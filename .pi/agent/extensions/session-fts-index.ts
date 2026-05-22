/**
 * session-fts-index — SQLite FTS5 background indexer for pi sessions.
 *
 * Backs `session-search` with a persistent full-text index, replacing the
 * per-query 15K-file ripgrep scan on this user's box. The rg path stays as
 * a fallback for files not yet indexed (see fallback logic in
 * session-search.ts).
 *
 * Why a background indexer rather than always-rg:
 *   - ~15,056 jsonl files / ~18 GB on this box. rg scan ~3-10s per query.
 *   - FTS5 with porter+unicode61: <50ms for indexed corpus.
 *   - Indexing 18GB up front would block startup ~10-30 min. Unacceptable.
 *
 * Strategy:
 *   1. On extension load: open DB at ~/.pi/agent/session-fts.db.
 *      Apply schema if missing. Don't index on the hot path.
 *   2. On every `session_start`: spawn an async background indexer that
 *      handles up to BATCH_PER_STARTUP newest-first files that aren't yet
 *      indexed (or whose mtime/size changed). Yields between files via
 *      setImmediate so the TUI stays responsive.
 *   3. On every `turn_end`: re-index ONLY the current session file. This
 *      keeps the live session searchable immediately.
 *   4. Exports searchFts() + indexStats() for session-search.ts to consume.
 *
 * Schema:
 *   msg_fts: FTS5 virtual table (content + path/date/role unindexed columns)
 *   indexed_files: path → (mtime, size, entry_count) for change detection
 *
 * Tokenizer: 'porter unicode61' — stemming (test/testing/tested all match)
 * plus accent folding. Same as opencode.
 *
 * Commands:
 *   /session-index status   show row counts + indexer progress
 *   /session-index rebuild  drop everything + reindex from scratch
 *   /session-index gc       remove rows for files that no longer exist
 */

import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────
// Module state

const DB_PATH = join(getAgentDir(), "session-fts.db");
const SESSIONS_ROOT = join(getAgentDir(), "sessions");
// Reality check: parsing+inserting ~5-15ms per file (measured 4ms for parse
// alone on this box, SQLite adds the rest). Full 15K-file corpus indexes in
// ~2-4min total. We bias toward fast convergence — 2000 files per startup
// means most users are fully indexed within 8 sessions.
const BATCH_PER_STARTUP = 2000;
const YIELD_EVERY = 25; // setImmediate every N files keeps TUI responsive
const MAX_FILE_BYTES = 50 * 1024 * 1024; // skip files >50MB (defensive)

let db: Database | null = null;
let indexerRunning = false;

// ─────────────────────────────────────────────────────────────────────────
// DB lifecycle

function openDb(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH, { create: true });
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA synchronous = NORMAL");
  d.exec("PRAGMA temp_store = MEMORY");
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
      content,
      session_path UNINDEXED,
      date UNINDEXED,
      role UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      entry_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db = d;
  return d;
}

function closeDb() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers reused by indexer and searcher

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

function dateFromName(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "?";
}

// Convert plain search terms to a forgiving FTS5 query (opencode's pattern).
//   "gatekeeper DDD bounded context" -> "gatekeeper OR DDD OR bounded OR context"
// Already-structured queries (with OR/AND/NOT/quotes/*) pass through unchanged.
export function toFtsQuery(input: string): string {
  if (/\b(OR|AND|NOT)\b|[*"]/.test(input)) return input;
  return input
    .split(/[\s\-_./\\:]+/)
    .filter(Boolean)
    .join(" OR ");
}

// ─────────────────────────────────────────────────────────────────────────
// Indexer

interface FileToIndex {
  path: string;
  mtime: number;
  size: number;
}

/** Walk sessions dir, return files that need (re)indexing, newest first. */
function listFilesNeedingIndex(d: Database, limit: number): FileToIndex[] {
  if (!existsSync(SESSIONS_ROOT)) return [];

  const stmt = d.query<{ mtime: number; size: number }, [string]>(
    "SELECT mtime, size FROM indexed_files WHERE path = ?",
  );
  const out: FileToIndex[] = [];

  // Walk cwd-encoded subdirs
  const subdirs: string[] = [];
  for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) subdirs.push(join(SESSIONS_ROOT, entry.name));
  }

  for (const sub of subdirs) {
    let files: string[];
    try {
      files = readdirSync(sub).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }
    for (const f of files) {
      const full = join(sub, f);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;

      const mtime = Math.floor(st.mtimeMs);
      const existing = stmt.get(full);
      if (existing && existing.mtime === mtime && existing.size === st.size) continue;
      out.push({ path: full, mtime, size: st.size });
    }
  }

  // Newest first (by mtime). The mtime is on the file struct.
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/** Index one jsonl file. Returns entry count, or -1 on parse error. */
async function indexFile(d: Database, file: FileToIndex): Promise<number> {
  const path = file.path;
  const date = dateFromName(basename(path));

  // Delete any existing rows for this file (file might have grown / changed).
  d.run("DELETE FROM msg_fts WHERE session_path = ?", [path]);

  let count = 0;
  const insert = d.prepare(
    "INSERT INTO msg_fts (content, session_path, date, role) VALUES (?, ?, ?, ?)",
  );

  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  d.exec("BEGIN");
  try {
    for await (const line of rl) {
      if (!line) continue;
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "message") continue;
      const role = entry.message?.role ?? "?";
      const text = extractText(entry.message?.content);
      if (!text || text.length < 8) continue;
      insert.run(text, path, date, role);
      count++;
    }
    d.run(
      "INSERT OR REPLACE INTO indexed_files (path, mtime, size, entry_count) VALUES (?, ?, ?, ?)",
      [path, file.mtime, file.size, count],
    );
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return count;
}

/** Background indexer entry point. Returns the number of files indexed. */
async function runIndexer(limit: number): Promise<{ files: number; entries: number; ms: number }> {
  if (indexerRunning) return { files: 0, entries: 0, ms: 0 };
  indexerRunning = true;
  const t0 = Date.now();
  let files = 0;
  let entries = 0;
  try {
    const d = openDb();
    const queue = listFilesNeedingIndex(d, limit);
    for (let i = 0; i < queue.length; i++) {
      try {
        const c = await indexFile(d, queue[i]);
        if (c >= 0) {
          files++;
          entries += c;
        }
      } catch {
        // Single bad file shouldn't kill the whole indexer
      }
      if (i % YIELD_EVERY === YIELD_EVERY - 1) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  } finally {
    indexerRunning = false;
  }
  return { files, entries, ms: Date.now() - t0 };
}

// ─────────────────────────────────────────────────────────────────────────
// Search

export interface FtsHit {
  sessionPath: string;
  date: string;
  role: string;
  snippet: string;
  rank: number;
}

export function searchFts(query: string, role: string | undefined, limit: number): FtsHit[] {
  const d = openDb();
  const ftsQuery = toFtsQuery(query);
  const args: (string | number)[] = [ftsQuery];
  let sql = `
    SELECT
      snippet(msg_fts, 0, '«', '»', '…', 32) as snippet,
      session_path,
      date,
      role,
      rank
    FROM msg_fts
    WHERE msg_fts MATCH ?
  `;
  if (role) {
    sql += " AND role = ?";
    args.push(role);
  }
  sql += " ORDER BY rank LIMIT ?";
  args.push(limit);

  try {
    const rows = d.query<
      { snippet: string; session_path: string; date: string; role: string; rank: number },
      typeof args
    >(sql).all(...args);
    return rows.map((r) => ({
      sessionPath: r.session_path,
      date: r.date,
      role: r.role,
      snippet: r.snippet,
      rank: r.rank,
    }));
  } catch {
    // Malformed FTS5 query, etc.
    return [];
  }
}

export function indexStats(): { totalRows: number; totalFiles: number; pendingFiles: number } {
  const d = openDb();
  const totalRows =
    (d.query<{ c: number }, []>("SELECT COUNT(*) as c FROM msg_fts").get()?.c ?? 0);
  const totalFiles =
    (d.query<{ c: number }, []>("SELECT COUNT(*) as c FROM indexed_files").get()?.c ?? 0);
  const pendingFiles = listFilesNeedingIndex(d, 1_000_000).length;
  return { totalRows, totalFiles, pendingFiles };
}

// ─────────────────────────────────────────────────────────────────────────
// Extension hooks

export default function (pi: ExtensionAPI) {
  // Open DB lazily on first use — but ensure schema exists at startup
  openDb();

  // Background-index newest-first files on every session_start
  pi.on("session_start", async (_event, ctx) => {
    // Fire-and-forget; don't block startup
    runIndexer(BATCH_PER_STARTUP)
      .then((r) => {
        if (r.files > 0 && ctx.hasUI) {
          // Quiet status update — user sees if they care
          try {
            ctx.ui.setStatus("session-fts", `+${r.files}f ${r.entries}m`);
            setTimeout(() => { try { ctx.ui.setStatus("session-fts", ""); } catch { /* ignore */ } }, 5000);
          } catch { /* ignore */ }
        }
      })
      .catch(() => { /* swallow */ });
  });

  // Re-index the current session at every turn_end so live messages are
  // searchable immediately.
  pi.on("turn_end", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile || !existsSync(sessionFile)) return;
    try {
      const st = statSync(sessionFile);
      const d = openDb();
      await indexFile(d, {
        path: sessionFile,
        mtime: Math.floor(st.mtimeMs),
        size: st.size,
      });
    } catch { /* ignore */ }
  });

  pi.on("session_shutdown", async () => {
    closeDb();
  });

  // Command: /session-index <status|rebuild|gc>
  pi.registerCommand("session-index", {
    description: "Manage session FTS5 index (status | rebuild | gc)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "status";

      if (sub === "status") {
        const s = indexStats();
        ctx.ui.notify(
          `index: ${s.totalRows} messages across ${s.totalFiles} files (${s.pendingFiles} pending)`,
          "info",
        );
        return;
      }

      if (sub === "rebuild") {
        const ok = await ctx.ui.confirm(
          "Rebuild session index",
          "This drops the FTS5 table and re-indexes everything. Could take minutes. Continue?",
        );
        if (!ok) return;
        const d = openDb();
        d.exec("DELETE FROM msg_fts");
        d.exec("DELETE FROM indexed_files");
        ctx.ui.notify("rebuilding index in background…", "info");
        const r = await runIndexer(1_000_000);
        ctx.ui.notify(
          `rebuild done: ${r.files} files, ${r.entries} messages in ${(r.ms / 1000).toFixed(1)}s`,
          "info",
        );
        return;
      }

      if (sub === "gc") {
        // Remove rows for files that no longer exist on disk
        const d = openDb();
        const allPaths = d
          .query<{ path: string }, []>("SELECT path FROM indexed_files")
          .all();
        let removed = 0;
        d.exec("BEGIN");
        try {
          for (const r of allPaths) {
            if (!existsSync(r.path)) {
              d.run("DELETE FROM msg_fts WHERE session_path = ?", [r.path]);
              d.run("DELETE FROM indexed_files WHERE path = ?", [r.path]);
              removed++;
            }
          }
          d.exec("COMMIT");
        } catch (e) {
          d.exec("ROLLBACK");
          ctx.ui.notify(`gc failed: ${(e as Error).message}`, "warning");
          return;
        }
        ctx.ui.notify(`gc: removed ${removed} stale entries`, "info");
        return;
      }

      ctx.ui.notify("usage: /session-index [status|rebuild|gc]", "info");
    },
  });
}
