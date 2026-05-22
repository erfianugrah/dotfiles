/**
 * session-search — full-text search across past Pi sessions, backed by ripgrep.
 *
 * Why ripgrep: ~/.pi/agent/sessions holds ~15k jsonl files / ~18GB on a
 * long-lived box. The previous sync JSON.parse-every-line scan locked the
 * agent for minutes. ripgrep streams matches in parallel and never blocks the
 * event loop.
 *
 * Strategy:
 *   1. Tokenise the query (opencode's toFtsQuery pattern) — multi-word
 *      queries auto-OR across tokens so 'opencode pi migration' matches any
 *      of those words, not the literal three-word substring (which never
 *      appears anywhere). Quoted phrases pass through as a single token.
 *   2. Spawn `rg --json -i -F -e <tok1> -e <tok2> ...` over the sessions dir.
 *   3. For each `match` event, JSON.parse the matched line (it IS a session
 *      entry — sessions are jsonl, one entry per line).
 *   4. Filter entries to type="message", optionally by role.
 *   5. Score by distinct-token-hit-count, sort desc, take limit.
 *   6. Build a snippet around the first matching token and emit.
 *
 * Pi session layout: ~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<uuid>.jsonl
 * Message entry shape (v3):
 *   { type:"message", message:{ role:"user"|"assistant"|"toolResult",
 *                                content:[{type, text}, ...] }, ... }
 *
 * Mirrors opencode's session-search semantics (which uses SQLite FTS5 with
 * stemming and auto-OR). Pi can't easily build an FTS5 index without a
 * background indexer, but ripgrep + tokenisation reaches the same
 * user-visible behaviour for multi-word queries.
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

// Tokenise a query the way opencode's toFtsQuery does:
//   - already-structured queries (with quotes / OR / AND / NOT / *) pass
//     through unchanged as a single pattern
//   - otherwise split on whitespace + common separators, dedupe
// Each resulting token becomes a separate `-e <pattern>` arg to rg, which
// ORs them automatically.
function tokenise(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed) return [];
	if (/\b(OR|AND|NOT)\b|[*"]/.test(trimmed)) return [trimmed];
	const tokens = trimmed
		.split(/[\s\-_./\\:]+/)
		.filter((t) => t.length > 0);
	return Array.from(new Set(tokens));
}

function snippet(text: string, tokens: string[], before = 40, after = 120): string {
	const lc = text.toLowerCase();
	// Find earliest token hit so the snippet shows the most context
	let idx = -1;
	let hitLen = 0;
	for (const t of tokens) {
		const lt = t.toLowerCase();
		const pos = lc.indexOf(lt);
		if (pos !== -1 && (idx === -1 || pos < idx)) {
			idx = pos;
			hitLen = lt.length;
		}
	}
	if (idx === -1) return text.slice(0, before + after);
	const start = Math.max(0, idx - before);
	const end = Math.min(text.length, idx + hitLen + after);
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
	tokens: string[],
	roleFilter: string | undefined,
	limit: number,
	signal: AbortSignal | undefined,
): Promise<Hit[]> {
	return new Promise((resolve, reject) => {
		if (tokens.length === 0) return resolve([]);
		// -F  fixed string (faster, treats each pattern literally)
		// -i  case-insensitive
		// -e <pat>  one per token — rg ORs them automatically
		// Multiple -e flags is the rg-native equivalent of opencode's FTS5 auto-OR.
		// --json  structured stream
		// --no-config  ignore user's ripgreprc
		// -g  only jsonl files (defensive — sessions dir should only have those)
		const rgArgs = ["--json", "--no-config", "-i", "-F", "-g", "*.jsonl"];
		for (const t of tokens) {
			rgArgs.push("-e", t);
		}
		rgArgs.push(root);
		const child = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });

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
			// Score = count of distinct tokens that hit this line (case-insensitive)
			const lc = text.toLowerCase();
			let score = 0;
			for (const t of tokens) {
				if (lc.includes(t.toLowerCase())) score++;
			}
			hits.push({
				sessionPath,
				date: dateFromName(basename(sessionPath)),
				role: role ?? "?",
				snippet: snippet(text, tokens),
				// Tag the hit with its score; we sort + truncate after the stream
				// drains rather than mid-stream, so multi-token relevance works.
				// @ts-expect-error — augmented field, dropped before serialisation
				_score: score,
			});

			// Take 4× limit while streaming, then sort + slice to the real limit.
			// Lets us keep multi-token relevance without buffering the entire scan.
			if (hits.length >= Math.max(limit * 4, 40)) finish();
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
		"Search past session content using ripgrep with opencode-style multi-word OR semantics.",
		"",
		"Use this tool to find relevant context from previous sessions — past decisions, implementations, user preferences, and recurring patterns.",
		"",
		"Query handling:",
		'- Multi-word queries auto-OR across tokens: "opencode pi migration" matches messages containing ANY of those words.',
		'- Quoted phrases pass through as a single token: \'"web research"\' matches the literal phrase.',
		'- Structured queries containing OR/AND/NOT or * also pass through unchanged.',
		"- Case-insensitive. Stemming is NOT supported (use root words like 'test' not 'testing').",
		"",
		"Results are scored by distinct-token-hit-count and returned in descending relevance.",
		"",
		"Parameters:",
		'- "query": Search terms (multi-word auto-OR; quote for literal phrase)',
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
		query: Type.String({ description: "Search terms (multi-word auto-OR; quote for literal phrase)" }),
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
		const tokens = tokenise(params.query);
		if (tokens.length === 0) {
			return {
				content: [{ type: "text", text: "Empty query." }],
				details: { count: 0, query: params.query },
			};
		}
		const t0 = Date.now();

		let hits: Hit[];
		try {
			hits = await searchWithRipgrep(root, tokens, params.role, limit, signal);
		} catch (err: any) {
			return {
				content: [{ type: "text", text: `Search failed: ${err?.message ?? String(err)}` }],
				details: { error: true, query: params.query },
			};
		}

		// Sort by distinct-token-hit score (desc), truncate to real limit,
		// strip internal _score field before serialisation.
		hits.sort((a: any, b: any) => (b._score ?? 0) - (a._score ?? 0));
		hits = hits.slice(0, limit);
		for (const h of hits as any[]) delete h._score;

		const ms = Date.now() - t0;

		if (hits.length === 0) {
			const tokenList = tokens.length > 1 ? ` (tokens: ${tokens.join(", ")})` : "";
			return {
				content: [{ type: "text", text: `No matches for "${params.query}"${tokenList} (searched in ${ms}ms)` }],
				details: { count: 0, query: params.query, tokens, ms },
			};
		}

		const out = hits
			.map((h, i) => `${i + 1}. [${h.date}] ${h.role}\n   ${h.sessionPath}\n   ${h.snippet}`)
			.join("\n\n");

		const tokenSummary = tokens.length > 1 ? ` for ${tokens.length} tokens` : "";
		return {
			content: [{ type: "text", text: `${out}\n\n(${hits.length} hits${tokenSummary} in ${ms}ms)` }],
			details: { count: hits.length, query: params.query, tokens, ms },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(sessionSearchTool);
}
