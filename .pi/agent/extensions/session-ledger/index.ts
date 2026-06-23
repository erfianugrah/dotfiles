/**
 * session-ledger — a queryable, cross-session "work ledger" that makes
 * picking up where you left off automatic instead of a manual
 * quit → session_search → re-explain dance.
 *
 * Three surfaces, all grounded in verified pi hooks (see the session that
 * built this — every claim below was checked against the binary + real
 * session data before writing):
 *
 *  1. CAPTURE (zero effort)
 *     - `session_compact` hands us an LLM-written structured summary for
 *       free on every compaction / `/compact`. We persist it (filtering the
 *       degenerate "No conversation content" summaries that real data showed
 *       compaction sometimes emits).
 *     - `session_shutdown` catches short sessions you quit BEFORE compaction
 *       ever fires. We do NOT call the LLM on the quit path (docs don't
 *       guarantee async shutdown handlers are awaited, and a network call
 *       would hang quit). Instead we write the serialized transcript RAW
 *       (synchronous SQLite insert — always lands) marked summary_pending=1.
 *
 *  2. LAZY SUMMARISE
 *     - On the next `session_start` we summarise any pending raw rows via a
 *       one-shot `complete()` call, off the quit path, where there's time
 *       and a model. Same outcome as a shutdown summary, no quit hang.
 *
 *  3. RETRIEVE (seamless)
 *     - On `session_start` in a project that has ledger rows, the `context`
 *       hook prepends a cached system block with the latest summaries. The
 *       new session starts knowing where you left off — no "pick up where we
 *       left off" typing. Cached in the system-prompt region (verified: pi
 *       applies Anthropic cache markers there) → ~zero per-turn cost.
 *     - `ledger_search` (FTS5) + `ledger_sql` (read-only SQL) let the model
 *       drill into history on demand.
 *
 * Storage: `~/.pi/agent/ledger.db`. NOT version-controlled (per-machine work
 * history). Schema carries a nullable `embedding` BLOB so sqlite-vec semantic
 * search can be layered later with no migration.
 *
 * Kill switch: LEDGER_OFF=1 disables injection (capture still runs). `/ledger
 * off` toggles at runtime.
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import { complete } from "@earendil-works/pi-ai/compat";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────
// Constants

const DB_PATH = join(getAgentDir(), "ledger.db");
const INJECT_MAX_BYTES = Number(process.env.LEDGER_INJECT_MAX_BYTES ?? 6000);
const INJECT_MAX_ROWS = Number(process.env.LEDGER_INJECT_MAX_ROWS ?? 2);
const INJECT_MAX_AGE_DAYS = Number(process.env.LEDGER_INJECT_MAX_AGE_DAYS ?? 21);
const SHUTDOWN_MIN_ENTRIES = 6; // don't capture trivial sessions
const RAW_MAX_BYTES = 16000; // cap stored transcript
const RAW_PER_ENTRY = 1500;
const LAZY_SUMMARISE_PER_START = 3; // bound model calls per session_start
const SUMMARISE_TIMEOUT_MS = Number(process.env.LEDGER_SUMMARISE_TIMEOUT_MS ?? 30000);
const INJECT_HEADER = "# Recent work in this project (from past sessions)";

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests — no side effects)

/** Extract plain text from a pi message/entry `content` field. */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (typeof c === "string") parts.push(c);
		else if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
			parts.push((c as { text: string }).text);
		}
	}
	return parts.join(" ");
}

/**
 * Detect the degenerate summaries compaction emits on empty / split-turn
 * spans (e.g. "## Goal\n(No conversation content was provided...)"). Real
 * session data showed these exist; persisting them pollutes the ledger.
 */
export function isDegenerateSummary(summary: string | null | undefined): boolean {
	if (!summary || !summary.trim()) return true;
	const low = summary.toLowerCase();
	if (/no conversation (content|messages|history)|was provided to summarize|provide the actual conversation/.test(low)) {
		return true;
	}
	const meaningful = summary
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l) =>
			l
				.replace(/^[-*\d.]+\s*/, "")
				.replace(/^\[[ x]\]\s*/i, "")
				.trim(),
		)
		.filter((l) => l && !/^\(?(none|n\/a|no [a-z ]+)\)?\.?$/i.test(l));
	const chars = meaningful.join(" ").replace(/\s+/g, "").length;
	return chars < 40;
}

/** git toplevel of `cwd`, or `cwd` itself if not a repo. Side-effectful (spawns git). */
export function gitProject(cwd: string): string {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		return out || cwd;
	} catch {
		return cwd;
	}
}

/** Build an FTS5 MATCH query: tokenise, drop punctuation, OR-join. */
export function ftsQuery(input: string): string {
	const tokens = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
	if (tokens.length === 0) return "";
	return tokens.map((t) => `"${t}"`).join(" OR ");
}

export type LedgerRow = {
	id: number;
	created_at: number;
	kind: string;
	git_branch: string | null;
	summary: string | null;
};

/**
 * Build the system-prompt block injected into a new session. Newest-first,
 * byte-budgeted. Includes a staleness warning so the model re-verifies
 * against reality rather than trusting summaries blindly.
 */
export function buildInjectionBlock(rows: LedgerRow[], maxBytes = INJECT_MAX_BYTES): string {
	if (rows.length === 0) return "";
	const head =
		`${INJECT_HEADER}\n` +
		"Summaries of prior pi sessions in this project, newest first. " +
		"Treat as possibly-stale hints: re-read named files and re-check state before acting on them.\n";
	let out = head;
	for (const r of rows) {
		if (!r.summary) continue;
		const date = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
		const branch = r.git_branch ? ` · ${r.git_branch}` : "";
		const section = `\n## ${date} · ${r.kind}${branch}\n${r.summary.trim()}\n`;
		if (Buffer.byteLength(out + section, "utf8") > maxBytes) break;
		out += section;
	}
	return out === head ? "" : out;
}

/** Guard the read-only SQL tool. Returns {ok} or {ok:false, reason}. */
export function isReadOnlySql(sql: string): { ok: boolean; reason?: string } {
	const t = sql.trim().replace(/;+\s*$/, "");
	if (!t) return { ok: false, reason: "empty query" };
	if (t.includes(";")) return { ok: false, reason: "multiple statements not allowed" };
	if (!/^(select|with)\b/i.test(t)) return { ok: false, reason: "query must start with SELECT or WITH" };
	if (/\b(insert|update|delete|drop|create|alter|attach|detach|pragma|replace|vacuum|reindex|begin|commit|rollback)\b/i.test(t)) {
		return { ok: false, reason: "write / DDL keyword not allowed" };
	}
	return { ok: true };
}

/** Serialize session entries to a bounded role-tagged transcript for summarisation. */
export function serializeEntriesForSummary(
	entries: Array<{ type?: string; role?: string; content?: unknown }>,
	opts: { maxPerEntry?: number; maxTotal?: number } = {},
): string {
	const maxPerEntry = opts.maxPerEntry ?? RAW_PER_ENTRY;
	const maxTotal = opts.maxTotal ?? RAW_MAX_BYTES;
	const parts: string[] = [];
	for (const e of entries) {
		const text = extractText(e.content).trim();
		if (!text) continue;
		const label = e.role || e.type || "msg";
		parts.push(`[${label}] ${text.slice(0, maxPerEntry)}`);
	}
	const joined = parts.join("\n");
	// Keep the most recent content if over budget (tail matters most).
	return joined.length > maxTotal ? joined.slice(joined.length - maxTotal) : joined;
}

const SUMMARISE_PROMPT =
	"You are summarising a short coding session so a future session can resume it. " +
	"Produce structured markdown with these sections: ## Goal, ## Key Decisions, " +
	"## Progress (Done / In Progress), ## Next Steps, ## Critical Context. " +
	"Be concise. Name specific files touched. If the session did nothing substantive, " +
	"reply with exactly: SKIP\n\nConversation:\n";

/** Extract text from a complete() response, defensively. */
export function extractCompletionText(response: unknown): string {
	if (!response || typeof response !== "object") return "";
	const content = (response as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : ""))
		.join("");
}

// ─────────────────────────────────────────────────────────────────────────
// DB layer

let db: Database | null = null;

function openDb(): Database {
	if (db) return db;
	mkdirSync(dirname(DB_PATH), { recursive: true });
	const d = new Database(DB_PATH, { create: true });
	d.exec("PRAGMA busy_timeout = 5000");
	d.exec("PRAGMA journal_mode = WAL");
	d.exec("PRAGMA synchronous = NORMAL");
	d.exec(`
		CREATE TABLE IF NOT EXISTS ledger (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file    TEXT,
			project         TEXT NOT NULL,
			cwd             TEXT NOT NULL,
			git_branch      TEXT,
			created_at      INTEGER NOT NULL,
			kind            TEXT NOT NULL,
			summary         TEXT,
			raw_text        TEXT,
			read_files      TEXT,
			modified_files  TEXT,
			tokens_before   INTEGER,
			summary_pending INTEGER NOT NULL DEFAULT 0,
			embedding       BLOB
		);
	`);
	d.exec("CREATE INDEX IF NOT EXISTS idx_ledger_project ON ledger(project, created_at DESC);");
	d.exec("CREATE INDEX IF NOT EXISTS idx_ledger_pending ON ledger(summary_pending);");
	d.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(
			summary, project UNINDEXED, tokenize = 'porter unicode61'
		);
	`);
	db = d;
	return d;
}

function insertSummaryRow(args: {
	sessionFile: string | null;
	project: string;
	cwd: string;
	branch: string | null;
	kind: string;
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
	tokensBefore: number | null;
}): void {
	const d = openDb();
	const r = d
		.query(
			`INSERT INTO ledger (session_file, project, cwd, git_branch, created_at, kind, summary, read_files, modified_files, tokens_before, summary_pending)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
		)
		.get(
			args.sessionFile,
			args.project,
			args.cwd,
			args.branch,
			Date.now(),
			args.kind,
			args.summary,
			JSON.stringify(args.readFiles),
			JSON.stringify(args.modifiedFiles),
			args.tokensBefore,
		) as { id: number };
	d.query("INSERT INTO ledger_fts (rowid, summary, project) VALUES (?, ?, ?)").run(r.id, args.summary, args.project);
}

function insertPendingRaw(args: {
	sessionFile: string | null;
	project: string;
	cwd: string;
	branch: string | null;
	rawText: string;
}): void {
	const d = openDb();
	d.query(
		`INSERT INTO ledger (session_file, project, cwd, git_branch, created_at, kind, raw_text, summary_pending)
		 VALUES (?, ?, ?, ?, ?, 'shutdown', ?, 1)`,
	).run(args.sessionFile, args.project, args.cwd, args.branch, Date.now(), args.rawText);
}

function latestProjectSummaries(project: string, limit: number, maxAgeDays: number): LedgerRow[] {
	const d = openDb();
	const cutoff = Date.now() - maxAgeDays * 86400_000;
	return d
		.query(
			`SELECT id, created_at, kind, git_branch, summary FROM ledger
			 WHERE project = ? AND summary IS NOT NULL AND summary_pending = 0 AND created_at >= ?
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.all(project, cutoff, limit) as LedgerRow[];
}

// ─────────────────────────────────────────────────────────────────────────
// Lazy summarisation of pending raw rows

async function summarisePending(ctx: ExtensionContext, project: string, max: number): Promise<number> {
	const d = openDb();
	const pending = d
		.query(
			`SELECT id, raw_text FROM ledger WHERE summary_pending = 1 AND project = ? ORDER BY created_at DESC LIMIT ?`,
		)
		.all(project, max) as Array<{ id: number; raw_text: string }>;
	if (pending.length === 0) return 0;

	const model = pickSummaryModel(ctx);
	if (!model) return 0;
	let auth: { ok?: boolean; apiKey?: string; headers?: Record<string, string> };
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch {
		return 0;
	}
	if (!auth?.ok || !auth.apiKey) return 0;

	let done = 0;
	for (const row of pending) {
		if (!row.raw_text?.trim()) {
			clearPending(d, row.id, null);
			continue;
		}
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), SUMMARISE_TIMEOUT_MS);
		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: SUMMARISE_PROMPT + row.raw_text }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096, signal: ac.signal },
			);
			const summary = extractCompletionText(response).trim();
			if (!summary || summary === "SKIP" || isDegenerateSummary(summary)) {
				clearPending(d, row.id, null); // drop raw, no useful summary
			} else {
				clearPending(d, row.id, summary, project);
				done++;
			}
		} catch {
			// leave pending — retried next start
		} finally {
			clearTimeout(timer);
		}
	}
	return done;
}

function clearPending(d: Database, id: number, summary: string | null, project?: string): void {
	if (summary) {
		d.query("UPDATE ledger SET summary = ?, summary_pending = 0, raw_text = NULL WHERE id = ?").run(summary, id);
		d.query("INSERT INTO ledger_fts (rowid, summary, project) VALUES (?, ?, ?)").run(id, summary, project ?? "");
	} else {
		// No useful summary — delete the row entirely (don't keep raw forever).
		d.query("DELETE FROM ledger WHERE id = ?").run(id);
	}
}

function pickSummaryModel(ctx: ExtensionContext): unknown {
	const env = process.env.LEDGER_SUMMARY_MODEL;
	if (env && env.includes("/")) {
		const idx = env.indexOf("/");
		const provider = env.slice(0, idx);
		const id = env.slice(idx + 1);
		try {
			const m = ctx.modelRegistry.find(provider, id);
			if (m) return m;
		} catch {
			/* fall through */
		}
	}
	return (ctx as { model?: unknown }).model ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Module state (per session)

let sessionProject = "";
let sessionCwd = "";
let sessionBranch: string | null = null;
let sessionFile: string | null = null;
let capturedThisSession = false;
let injectRows: LedgerRow[] = [];
let injectionEnabled = process.env.LEDGER_OFF !== "1";

function gitBranch(cwd: string): string | null {
	try {
		const b = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		return b || null;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Tools

const searchTool = defineTool({
	name: "ledger_search",
	description:
		"Search the cross-session work ledger (structured summaries of past pi sessions). " +
		"Use to recall what was done / decided in prior sessions on a project. FTS5 keyword search over summaries.",
	parameters: Type.Object({
		query: Type.String({ description: "Keywords to search summaries for" }),
		project: Type.Optional(Type.String({ description: "Filter to a project path (default: all projects)" })),
		limit: Type.Optional(Type.Number({ description: "Max rows (default 8, max 30)" })),
	}),
	async execute(_id: string, params: { query: string; project?: string; limit?: number }) {
		const limit = Math.min(Math.max(params.limit ?? 8, 1), 30);
		const match = ftsQuery(params.query);
		if (!match) return { content: [{ type: "text", text: "Empty query." }] };
		const d = openDb();
		const projClause = params.project ? "AND l.project = ?" : "";
		const sql = `SELECT l.id, l.created_at, l.kind, l.project, l.git_branch, l.summary
			FROM ledger_fts f JOIN ledger l ON l.id = f.rowid
			WHERE ledger_fts MATCH ? ${projClause}
			ORDER BY rank LIMIT ?`;
		const args = params.project ? [match, params.project, limit] : [match, limit];
		let rows: Array<LedgerRow & { project: string }>;
		try {
			rows = d.query(sql).all(...args) as Array<LedgerRow & { project: string }>;
		} catch (err) {
			return { content: [{ type: "text", text: `Search failed: ${(err as Error).message}` }] };
		}
		if (rows.length === 0) return { content: [{ type: "text", text: `No ledger entries for "${params.query}".` }] };
		const out = rows
			.map((r) => {
				const date = new Date(r.created_at).toISOString().slice(0, 10);
				return `### ${date} · ${r.kind} · ${r.project}${r.git_branch ? ` (${r.git_branch})` : ""}\n${r.summary}`;
			})
			.join("\n\n---\n\n");
		return { content: [{ type: "text", text: out }], details: { count: rows.length } };
	},
});

const sqlTool = defineTool({
	name: "ledger_sql",
	description:
		"Run a READ-ONLY SQL query (SELECT / WITH only) against the work-ledger DB. " +
		"Schema: ledger(id, session_file, project, cwd, git_branch, created_at INTEGER ms, kind, summary, " +
		"read_files JSON, modified_files JSON, tokens_before, summary_pending). " +
		"Use for arbitrary history queries the keyword search can't express (date ranges, per-project counts, file joins).",
	parameters: Type.Object({
		sql: Type.String({ description: "A single SELECT/WITH statement, no trailing semicolon needed" }),
	}),
	async execute(_id: string, params: { sql: string }) {
		const guard = isReadOnlySql(params.sql);
		if (!guard.ok) return { content: [{ type: "text", text: `Rejected: ${guard.reason}` }] };
		let rdb: Database;
		try {
			rdb = new Database(DB_PATH, { readonly: true });
		} catch (err) {
			return { content: [{ type: "text", text: `Cannot open ledger: ${(err as Error).message}` }] };
		}
		try {
			const rows = rdb.query(params.sql.trim().replace(/;+\s*$/, "")).all() as unknown[];
			const text = rows.length === 0 ? "(0 rows)" : JSON.stringify(rows.slice(0, 100), null, 2);
			return { content: [{ type: "text", text }], details: { rows: rows.length } };
		} catch (err) {
			return { content: [{ type: "text", text: `Query error: ${(err as Error).message}` }] };
		} finally {
			rdb.close();
		}
	},
});

// ─────────────────────────────────────────────────────────────────────────
// Extension entry

export default function (pi: ExtensionAPI) {
	pi.registerTool(searchTool);
	pi.registerTool(sqlTool);

	pi.registerCommand("ledger", {
		description: "Work-ledger control (status | on | off | summarize)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (sub === "on") {
				injectionEnabled = true;
				injectRows = latestProjectSummaries(sessionProject, INJECT_MAX_ROWS, INJECT_MAX_AGE_DAYS);
				ctx.ui.notify("ledger injection ON", "info");
				return;
			}
			if (sub === "off") {
				injectionEnabled = false;
				injectRows = [];
				ctx.ui.notify("ledger injection OFF (capture still runs)", "info");
				return;
			}
			if (sub === "summarize") {
				const n = await summarisePending(ctx, sessionProject, 50);
				injectRows = injectionEnabled ? latestProjectSummaries(sessionProject, INJECT_MAX_ROWS, INJECT_MAX_AGE_DAYS) : [];
				ctx.ui.notify(`summarised ${n} pending row(s)`, "info");
				return;
			}
			// status
			const d = openDb();
			const total = (d.query("SELECT count(*) c FROM ledger").get() as { c: number }).c;
			const pending = (d.query("SELECT count(*) c FROM ledger WHERE summary_pending = 1").get() as { c: number }).c;
			const here = (d.query("SELECT count(*) c FROM ledger WHERE project = ?").get(sessionProject) as { c: number }).c;
			ctx.ui.notify(
				`ledger: ${total} entries (${pending} pending) · ${here} in this project · injection ${injectionEnabled ? "on" : "off"}`,
				"info",
			);
		},
	});

	// ── session_start: resolve project, lazily summarise pending, load inject rows
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		sessionCwd = ctx.cwd;
		sessionProject = gitProject(ctx.cwd);
		sessionBranch = gitBranch(ctx.cwd);
		sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
		capturedThisSession = false;
		try {
			await summarisePending(ctx, sessionProject, LAZY_SUMMARISE_PER_START);
		} catch {
			/* best effort */
		}
		injectRows = injectionEnabled ? latestProjectSummaries(sessionProject, INJECT_MAX_ROWS, INJECT_MAX_AGE_DAYS) : [];
	});

	// ── context: prepend cached system block with recent project summaries
	pi.on("context", async (event: { messages: Array<{ role: string; content: unknown }> }) => {
		if (!injectionEnabled || injectRows.length === 0) return undefined;
		const first = event.messages[0];
		if (
			first?.role === "system" &&
			typeof first.content === "string" &&
			first.content.includes(INJECT_HEADER)
		) {
			return undefined;
		}
		const block = buildInjectionBlock(injectRows);
		if (!block) return undefined;
		return { messages: [{ role: "system" as const, content: block }, ...event.messages] };
	});

	// ── session_compact: persist the free LLM-written summary (filtered)
	pi.on("session_compact", async (event: { compactionEntry?: Record<string, unknown> }) => {
		const entry = event.compactionEntry;
		if (!entry) return;
		const summary = typeof entry.summary === "string" ? entry.summary : "";
		if (isDegenerateSummary(summary)) return;
		const details = (entry.details ?? {}) as { readFiles?: string[]; modifiedFiles?: string[] };
		try {
			insertSummaryRow({
				sessionFile,
				project: sessionProject,
				cwd: sessionCwd,
				branch: sessionBranch,
				kind: "compaction",
				summary,
				readFiles: details.readFiles ?? [],
				modifiedFiles: details.modifiedFiles ?? [],
				tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
			});
			capturedThisSession = true;
		} catch {
			/* ignore */
		}
	});

	// ── session_shutdown: capture short un-compacted sessions RAW (sync, no network)
	pi.on("session_shutdown", async (event: { reason?: string }, ctx: ExtensionContext) => {
		if (capturedThisSession) return;
		if (event.reason === "reload") return; // /reload churns; don't dup
		let entries: Array<{ type?: string; role?: string; content?: unknown }>;
		try {
			entries = ctx.sessionManager.getEntries() as typeof entries;
		} catch {
			return;
		}
		const msgEntries = entries.filter((e) => extractText(e.content).trim().length > 0);
		if (msgEntries.length < SHUTDOWN_MIN_ENTRIES) return;
		const raw = serializeEntriesForSummary(msgEntries);
		if (!raw.trim()) return;
		try {
			insertPendingRaw({ sessionFile, project: sessionProject, cwd: sessionCwd, branch: sessionBranch, rawText: raw });
		} catch {
			/* ignore */
		}
	});
}
