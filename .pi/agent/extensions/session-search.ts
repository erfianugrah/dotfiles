/**
 * session-search — full-text search across past Pi sessions, backed by ripgrep.
 *
 * Why ripgrep: ~/.pi/agent/sessions holds ~15k jsonl files / ~18GB on a
 * long-lived box. The previous sync JSON.parse-every-line scan locked the
 * agent for minutes. ripgrep streams matches in parallel and never blocks the
 * event loop.
 *
 * Strategy:
 *   1. Spawn `rg --json -i -F <query>` over the sessions dir.
 *   2. For each `match` event, JSON.parse the matched line (it IS a session
 *      entry — sessions are jsonl, one entry per line).
 *   3. Filter entries to type="message", optionally by role.
 *   4. Build a snippet around the match and emit.
 *   5. Stop early once `limit` hits land — kill the child to free CPU.
 *
 * Pi session layout: ~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<uuid>.jsonl
 * Message entry shape (v3):
 *   { type:"message", message:{ role:"user"|"assistant"|"toolResult",
 *                                content:[{type, text}, ...] }, ... }
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

type Hit = {
	sessionPath: string;
	date: string;
	role: string;
	snippet: string;
};

// Filename pattern: 2026-05-20T22-19-40-639Z_<uuid>.jsonl
function dateFromName(filename: string): string {
	const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1] : "?";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			if (typeof c === "string") return c;
			if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
				return (c as { text: string }).text;
			}
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function snippet(text: string, query: string, before = 40, after = 120): string {
	const lc = text.toLowerCase();
	const lq = query.toLowerCase();
	const idx = lc.indexOf(lq);
	if (idx === -1) return text.slice(0, before + after);
	const start = Math.max(0, idx - before);
	const end = Math.min(text.length, idx + lq.length + after);
	let s = text.slice(start, end).replace(/\s+/g, " ");
	if (start > 0) s = "…" + s;
	if (end < text.length) s = s + "…";
	return s;
}

type RgMatch = {
	type: "match";
	data: {
		path: { text: string };
		lines: { text: string };
		line_number: number;
	};
};

function searchWithRipgrep(
	root: string,
	query: string,
	roleFilter: string | undefined,
	limit: number,
	signal: AbortSignal | undefined,
): Promise<Hit[]> {
	return new Promise((resolve, reject) => {
		// -F  fixed string (faster, treats query literally)
		// -i  case-insensitive
		// -j  bounded threads (default = #cores; explicit avoids surprise on big boxes)
		// --json  structured stream
		// --no-config  ignore user's ripgreprc
		// -g  only jsonl files (defensive — sessions dir should only have those)
		const child = spawn(
			"rg",
			[
				"--json",
				"--no-config",
				"-i",
				"-F",
				"-g",
				"*.jsonl",
				"--",
				query,
				root,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		const hits: Hit[] = [];
		let done = false;

		const finish = (err?: Error) => {
			if (done) return;
			done = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			if (err) reject(err);
			else resolve(hits);
		};

		signal?.addEventListener("abort", () => finish(new Error("aborted")), { once: true });

		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			if (done || !line) return;
			let ev: RgMatch;
			try {
				const parsed = JSON.parse(line);
				if (parsed?.type !== "match") return;
				ev = parsed as RgMatch;
			} catch {
				return;
			}

			const matchedLine = ev.data.lines.text;
			let entry: any;
			try {
				entry = JSON.parse(matchedLine);
			} catch {
				return; // not a session entry — skip
			}
			if (entry?.type !== "message") return;
			const role = entry.message?.role;
			if (roleFilter && role !== roleFilter) return;

			const text = extractText(entry.message?.content);
			if (!text) return;

			const sessionPath = ev.data.path.text;
			hits.push({
				sessionPath,
				date: dateFromName(basename(sessionPath)),
				role: role ?? "?",
				snippet: snippet(text, query),
			});

			if (hits.length >= limit) finish();
		});

		child.stderr.on("data", () => {
			/* swallow — rg complains about unreadable files etc. */
		});

		child.on("error", (err) => finish(err));
		child.on("close", () => finish());
	});
}

const sessionSearchTool = defineTool({
	name: "session_search",
	label: "Session Search",
	description: [
		"Search past session content using ripgrep (fixed-string, case-insensitive).",
		"",
		"Use this tool to find relevant context from previous sessions — past decisions, implementations, user preferences, and recurring patterns.",
		"",
		"Parameters:",
		'- "query": Search terms (case-insensitive substring match)',
		'- "role": Filter by message role: "user", "assistant", or omit for both',
		'- "limit": Max results to return (default: 10, max: 50)',
		"",
		"Returns matching snippets with session path, role, and date.",
		"",
		"When to use:",
		'- User references past work ("how did we do X last time?")',
		"- Need to understand prior decisions or context",
		"- Looking for patterns across sessions",
	].join("\n"),
	parameters: Type.Object({
		query: Type.String({ description: "Search terms (case-insensitive substring)" }),
		role: Type.Optional(
			Type.Union([Type.Literal("user"), Type.Literal("assistant")], { description: "Filter by message role" }),
		),
		limit: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 50)" })),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const root = join(getAgentDir(), "sessions");
		if (!existsSync(root)) {
			return {
				content: [{ type: "text", text: `No sessions dir at ${root}` }],
				details: { count: 0, query: params.query },
			};
		}

		const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
		const t0 = Date.now();

		let hits: Hit[];
		try {
			hits = await searchWithRipgrep(root, params.query, params.role, limit, signal);
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `Search failed: ${err?.message ?? String(err)}` }],
				details: { error: true, query: params.query },
			};
		}

		const ms = Date.now() - t0;

		if (hits.length === 0) {
			return {
				content: [{ type: "text", text: `No matches for "${params.query}" (searched in ${ms}ms)` }],
				details: { count: 0, query: params.query, ms },
			};
		}

		const out = hits
			.map((h, i) => `${i + 1}. [${h.date}] ${h.role}\n   ${h.sessionPath}\n   ${h.snippet}`)
			.join("\n\n");

		return {
			content: [{ type: "text", text: `${out}\n\n(${hits.length} hits in ${ms}ms)` }],
			details: { count: hits.length, query: params.query, ms },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(sessionSearchTool);
}
