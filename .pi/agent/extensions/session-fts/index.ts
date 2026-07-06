/**
 * session-fts-index — main-thread façade for the FTS5 indexer worker.
 *
 * The actual indexer (writes, SQLite churn, FTS5 inverted-index updates)
 * runs in session-fts-worker.ts as a Bun Worker — completely off the main
 * pi event loop. This file:
 *
 *   - Keeps a read-only DB handle for searchFts() + indexStats() (WAL mode
 *     allows concurrent readers while the worker writes).
 *   - Spawns the worker on session_start (delayed by STARTUP_DELAY_MS to
 *     let the TUI fully render first).
 *   - Forwards turn_end re-index requests to the worker.
 *   - Surfaces worker progress + completion via ctx.ui.setStatus() so the
 *     footer extension status slot shows what's happening.
 *
 * Before this refactor, the indexer ran on the main thread and even with
 * setImmediate-every-file the synchronous SQLite work caused visible
 * keystroke lag at every session_start (3ms per row × 150 rows × 100 files
 * = ~45s of unyielding work on a 1.3GB index). Worker thread = problem
 * eliminated; TUI stays smooth.
 *
 * Commands:
 *   /session-index status   row counts + worker state
 *   /session-index rebuild  worker: drop and reindex from scratch
 *   /session-index gc       worker: remove rows for files no longer on disk
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────────────────
// Constants

const DB_PATH = join(getAgentDir(), "session-fts.db");
const SESSIONS_ROOT = join(getAgentDir(), "sessions");
const BATCH_PER_STARTUP = 100;
const STARTUP_DELAY_MS = 5000; // TUI fully responsive before worker kicks in
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// Read-only DB (main thread)

let readDb: Database | null = null;
function openReadDb(): Database {
  if (readDb) return readDb;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH, { create: true });
  // Wait up to 5s for the write lock instead of throwing — when a second
  // pi process starts while the first's worker is mid-INSERT, the schema
  // pragmas/CREATEs below would otherwise fail with "database is locked"
  // and bring down extension load. busy_timeout is connection-local and
  // doesn't itself need any lock.
  d.exec("PRAGMA busy_timeout = 5000");
  // Schema-init is best-effort: the worker (in this or any other pi
  // process sharing the DB) is the canonical writer and will create the
  // tables on session_start. If we can't get the write lock here, that's
  // fine — searchFts() already swallows errors, and indexStats() does too.
  try {
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA synchronous = NORMAL");
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
    d.exec(`
      CREATE TABLE IF NOT EXISTS session_names (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  } catch { /* worker will handle schema; reads tolerate missing tables */ }
  readDb = d;
  return d;
}

// ─────────────────────────────────────────────────────────────────────────
// Worker management

type WorkerMessage =
  | { type: "progress"; files: number; entries: number }
  | { type: "done"; files: number; entries: number; ms: number }
  | { type: "error"; message: string };

let worker: Worker | null = null;
let workerBusy = false;
let lastCommand: string | null = null;

function ensureWorker(onMessage: (msg: WorkerMessage) => void): Worker {
  if (worker) return worker;
  // Bun's Worker takes a URL. The .ts file is resolved relative to this file.
  worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  worker.onmessage = (e: MessageEvent) => onMessage(e.data as WorkerMessage);
  worker.onerror = () => {
    workerBusy = false;
    // Don't kill the worker on transient errors — let the next request retry
  };
  // Don't keep the parent process alive for this worker. Indexer state
  // lives in SQLite (WAL mode — safe against unclean exit), so on /quit pi
  // can exit immediately even if the worker is mid-batch. Without unref,
  // a 4 GB FTS5 DB mid-INSERT can stall shutdown for several seconds while
  // Bun waits for synchronous native code to return.
  try { (worker as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
  return worker;
}

function sendWorkerCmd(
  cmd: "index-batch" | "index-file" | "rebuild" | "gc",
  payload: { limit?: number; path?: string },
  onMessage: (msg: WorkerMessage) => void,
) {
  if (workerBusy) return false; // single-flight; drop duplicate requests
  const w = ensureWorker(onMessage);
  workerBusy = true;
  lastCommand = cmd;
  w.postMessage({ cmd, ...payload });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers reused by search

export function toFtsQuery(input: string): string {
  if (/\b(OR|AND|NOT)\b|[*"]/.test(input)) return input;
  return input
    .split(/[\s\-_./\\:]+/)
    .filter(Boolean)
    .join(" OR ");
}

// ─────────────────────────────────────────────────────────────────────────
// Search (synchronous reads on main thread — fast, doesn't block typing)

export interface FtsHit {
  sessionPath: string;
  date: string;
  role: string;
  snippet: string;
  rank: number;
  /** Human-readable session name, if one has been set. */
  name?: string;
}

// session names
// Upsert the display name for a session file. Best-effort: the worker holds
// the write lock during big INSERT batches, so busy_timeout (5s) may still
// time out - swallow errors, name indexing is a nicety, not load-bearing.
export function recordSessionName(path: string, name: string): void {
  if (!path) return;
  try {
    const d = openReadDb();
    d.query(
      `INSERT INTO session_names (path, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(path, name, Date.now());
  } catch { /* best-effort */ }
}

// Clear the name for a session (fired when the name is unset / cleared).
export function clearSessionName(path: string): void {
  if (!path) return;
  try {
    const d = openReadDb();
    d.query(`DELETE FROM session_names WHERE path = ?`).run(path);
  } catch { /* best-effort */ }
}

// Direct getter - exported for tests and callers that want just the name.
export function lookupSessionName(path: string): string | undefined {
  try {
    const d = openReadDb();
    const row = d.query<{ name: string }, [string]>(
      `SELECT name FROM session_names WHERE path = ?`,
    ).get(path);
    return row?.name;
  } catch {
    return undefined;
  }
}

export function searchFts(query: string, role: string | undefined, limit: number): FtsHit[] {
  const d = openReadDb();
  const ftsQuery = toFtsQuery(query);
  const args: (string | number)[] = [ftsQuery];
  let sql = `
    SELECT
      snippet(msg_fts, 0, '«', '»', '…', 32) as snippet,
      msg_fts.session_path,
      date,
      role,
      rank,
      session_names.name as name
    FROM msg_fts
    LEFT JOIN session_names ON session_names.path = msg_fts.session_path
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
      { snippet: string; session_path: string; date: string; role: string; rank: number; name: string | null },
      typeof args
    >(sql).all(...args);
    return rows.map((r) => ({
      sessionPath: r.session_path,
      date: r.date,
      role: r.role,
      snippet: r.snippet,
      rank: r.rank,
      name: r.name ?? undefined,
    }));
  } catch {
    return [];
  }
}

// Cache the filesystem walk for pendingFiles. /status calls and
// session-search fallback decisions hit indexStats() on the hot path —
// don't re-walk the sessions tree more than once every few seconds.
let pendingCache: { ts: number; count: number } | null = null;
const PENDING_CACHE_TTL_MS = 5_000;

function countSessionFiles(): number {
  if (!existsSync(SESSIONS_ROOT)) return 0;
  let total = 0;
  try {
    for (const e of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        for (const f of readdirSync(join(SESSIONS_ROOT, e.name))) {
          if (f.endsWith(".jsonl")) total++;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return total;
}

export function indexStats(): { totalRows: number; totalFiles: number; pendingFiles: number; workerBusy: boolean; lastCommand: string | null } {
  const d = openReadDb();
  // Tables may not exist yet on first launch if the schema-init above lost
  // the write-lock race — tolerate that and report zeros.
  let totalRows = 0;
  let totalFiles = 0;
  try { totalRows = d.query<{ c: number }, []>("SELECT COUNT(*) as c FROM msg_fts").get()?.c ?? 0; } catch { /* table missing */ }
  try { totalFiles = d.query<{ c: number }, []>("SELECT COUNT(*) as c FROM indexed_files").get()?.c ?? 0; } catch { /* table missing */ }
  // Approximate pending count without enumerating every file on every
  // call — cache the FS walk for PENDING_CACHE_TTL_MS.
  const now = Date.now();
  let pendingFiles = 0;
  if (pendingCache && now - pendingCache.ts < PENDING_CACHE_TTL_MS) {
    pendingFiles = Math.max(0, pendingCache.count - totalFiles);
  } else {
    const total = countSessionFiles();
    pendingCache = { ts: now, count: total };
    pendingFiles = Math.max(0, total - totalFiles);
  }
  return { totalRows, totalFiles, pendingFiles, workerBusy, lastCommand };
}

// ─────────────────────────────────────────────────────────────────────────
// Extension hooks

export default function (pi: ExtensionAPI) {
  // Open the read-only DB lazily but ensure the schema exists at startup.
  openReadDb();

  // Spawn the worker shortly after each session_start. Worker stays alive
  // between batches so we don't pay startup cost on every turn_end.
  pi.on("session_start", async (_event, ctx) => {
    setTimeout(() => {
      const ok = sendWorkerCmd("index-batch", { limit: BATCH_PER_STARTUP }, (msg) => {
        try {
          if (msg.type === "progress") {
            ctx.ui.setStatus?.("session-fts", `indexing +${msg.files}f ${msg.entries}m`);
          } else if (msg.type === "done") {
            workerBusy = false;
            if (msg.files > 0) {
              ctx.ui.setStatus?.("session-fts", `+${msg.files}f ${msg.entries}m`);
              setTimeout(() => { try { ctx.ui.setStatus?.("session-fts", ""); } catch { /* ignore */ } }, 5000);
            } else {
              ctx.ui.setStatus?.("session-fts", "");
            }
          } else if (msg.type === "error") {
            workerBusy = false;
            // Don't surface every error — they're usually transient per-file
          }
        } catch { /* ignore */ }
      });
      if (!ok) {
        // Worker was already busy when session_start fired — fine, current
        // batch will finish and the next session_start will pick up.
      }
    }, STARTUP_DELAY_MS);
  });

  // Keep the session_names table in sync with display-name changes
  // (/session-name, RPC, or the auto-title extension). pi 0.80.3+ (#6175).
  pi.on("session_info_changed", async (event: { name?: string }, ctx: ExtensionContext) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      if (!sessionFile) return;
      const name = event.name?.trim();
      if (name) recordSessionName(sessionFile, name);
      else clearSessionName(sessionFile);
    } catch { /* best-effort */ }
  });

  // Re-index the current session file at each turn_end so live messages
  // are searchable. Worker does this off-thread.
  pi.on("turn_end", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile || !existsSync(sessionFile)) return;
    sendWorkerCmd("index-file", { path: sessionFile }, (msg) => {
      if (msg.type === "done" || msg.type === "error") {
        workerBusy = false;
      }
    });
  });

  pi.on("session_shutdown", async () => {
    // Fire-and-forget shutdown. The worker is unref'd at creation, so the
    // parent process is free to exit regardless of whether the worker has
    // actually stopped. We still send `shutdown` (best effort, lets the
    // worker close its DB cleanly if idle) and `terminate()` (returns a
    // Promise we deliberately don't await — awaiting blocks process exit
    // until the worker's current synchronous SQLite call returns, which
    // on a multi-GB FTS5 index can take several seconds). WAL mode means
    // an abrupt worker stop is recoverable on next start.
    if (worker) {
      try { worker.postMessage({ cmd: "shutdown" }); } catch { /* ignore */ }
      try { void worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }
    if (readDb) {
      try { readDb.close(); } catch { /* ignore */ }
      readDb = null;
    }
  });

  pi.registerCommand("session-index", {
    description: "Manage session FTS5 index (status | rebuild | gc)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "status";

      if (sub === "status") {
        const s = indexStats();
        const workerState = s.workerBusy ? ` (worker busy: ${s.lastCommand})` : "";
        ctx.ui.notify(
          `index: ${s.totalRows} messages / ${s.totalFiles} files (${s.pendingFiles} pending)${workerState}`,
          "info",
        );
        return;
      }

      if (sub === "rebuild") {
        const ok = await ctx.ui.confirm(
          "Rebuild session index",
          "This drops the FTS5 table and re-indexes everything. Worker runs off-thread so TUI stays responsive, but the rebuild itself takes several minutes for a 15K-session corpus. Continue?",
        );
        if (!ok) return;
        const sent = sendWorkerCmd("rebuild", {}, (msg) => {
          if (msg.type === "progress") {
            ctx.ui.setStatus?.("session-fts", `rebuild +${msg.files}f ${msg.entries}m`);
          } else if (msg.type === "done") {
            workerBusy = false;
            ctx.ui.notify(
              `rebuild done: ${msg.files} files, ${msg.entries} messages in ${(msg.ms / 1000).toFixed(1)}s`,
              "info",
            );
            ctx.ui.setStatus?.("session-fts", "");
          } else if (msg.type === "error") {
            workerBusy = false;
            ctx.ui.notify(`rebuild error: ${msg.message}`, "warning");
          }
        });
        if (sent) ctx.ui.notify("rebuilding index in background worker…", "info");
        else ctx.ui.notify("worker busy — try again after current job", "warning");
        return;
      }

      if (sub === "gc") {
        const sent = sendWorkerCmd("gc", {}, (msg) => {
          if (msg.type === "done") {
            workerBusy = false;
            ctx.ui.notify(`gc: removed ${msg.files} stale entries`, "info");
          } else if (msg.type === "error") {
            workerBusy = false;
            ctx.ui.notify(`gc failed: ${msg.message}`, "warning");
          }
        });
        if (!sent) ctx.ui.notify("worker busy — try again after current job", "warning");
        return;
      }

      ctx.ui.notify("usage: /session-index [status|rebuild|gc]", "info");
    },
  });
}
