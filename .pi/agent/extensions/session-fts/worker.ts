/**
 * session-fts-worker — runs the SQLite FTS5 indexer off the main pi event loop.
 *
 * `bun:sqlite` is fully synchronous: every INSERT blocks. With a 1.3GB index
 * (15K sessions) each row costs ~3ms — 100 files × 150 rows = ~45s of
 * unyielding CPU on the main thread. Even setImmediate yields can't paper
 * over that. The proper fix is a worker.
 *
 * This file IS the worker entry. The parent (session-fts-index.ts) spawns it
 * via `new Worker(new URL("./session-fts-worker.ts", import.meta.url))` and
 * communicates via postMessage:
 *
 *   parent → worker: { cmd: "index-batch", limit: 100 }
 *                  | { cmd: "index-file",  path: "/abs/path.jsonl" }
 *                  | { cmd: "rebuild" }
 *                  | { cmd: "gc" }
 *                  | { cmd: "shutdown" }
 *
 *   worker → parent: { type: "progress", files, entries }
 *                  | { type: "done",     files, entries, ms }
 *                  | { type: "error",    message }
 *
 * The worker owns its own DB handle. The main thread keeps a separate
 * read-only handle for searchFts() / indexStats() — WAL mode allows
 * concurrent readers + a single writer.
 */

import { Database } from "bun:sqlite";
import { createReadStream, statSync, readdirSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { createInterface } from "node:readline";

// ─────────────────────────────────────────────────────────────────────────
// Constants — keep in sync with session-fts-index.ts

const DB_PATH = join(process.env.HOME ?? "", ".pi", "agent", "session-fts.db");
const SESSIONS_ROOT = join(process.env.HOME ?? "", ".pi", "agent", "sessions");
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// DB

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });
// Wait up to 30s for the write lock instead of failing fast. When a
// second pi process is doing its own indexing on the same DB, INSERTs
// here would otherwise raise SQLITE_BUSY on every contended COMMIT.
// busy_timeout is connection-local and cooperates with WAL.
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA temp_store = MEMORY");
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
    content,
    session_path UNINDEXED,
    date UNINDEXED,
    role UNINDEXED,
    tokenize = 'porter unicode61'
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS indexed_files (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0
  );
`);

// ─────────────────────────────────────────────────────────────────────────
// Helpers

function extractText(content: unknown): string {
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

function dateFromName(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "?";
}

interface FileToIndex { path: string; mtime: number; size: number; }

function listFilesNeedingIndex(limit: number): FileToIndex[] {
  if (!existsSync(SESSIONS_ROOT)) return [];
  const stmt = db.query<{ mtime: number; size: number }, [string]>(
    "SELECT mtime, size FROM indexed_files WHERE path = ?",
  );
  const out: FileToIndex[] = [];
  for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(SESSIONS_ROOT, entry.name);
    let files: string[];
    try { files = readdirSync(sub).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
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
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

async function indexFile(file: FileToIndex): Promise<number> {
  const path = file.path;
  const date = dateFromName(basename(path));

  // Parse phase (mostly I/O bound)
  type Row = { text: string; role: string };
  const rows: Row[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message") continue;
    const role = entry.message?.role ?? "?";
    const text = extractText(entry.message?.content);
    if (!text || text.length < 8) continue;
    rows.push({ text, role });
  }

  // Insert phase (SQLite-bound) — chunked transactions to keep WAL pressure
  // sane. Worker thread = no need to yield; just write.
  db.run("DELETE FROM msg_fts WHERE session_path = ?", [path]);
  const insert = db.prepare("INSERT INTO msg_fts (content, session_path, date, role) VALUES (?, ?, ?, ?)");
  let inserted = 0;
  while (inserted < rows.length) {
    const end = Math.min(inserted + 200, rows.length); // bigger chunks since we don't yield
    db.exec("BEGIN");
    try {
      for (let i = inserted; i < end; i++) insert.run(rows[i].text, path, date, rows[i].role);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    inserted = end;
  }
  db.run(
    "INSERT OR REPLACE INTO indexed_files (path, mtime, size, entry_count) VALUES (?, ?, ?, ?)",
    [path, file.mtime, file.size, rows.length],
  );
  return rows.length;
}

async function runBatch(limit: number) {
  const t0 = Date.now();
  let files = 0;
  let entries = 0;
  let queue: FileToIndex[];
  try {
    queue = listFilesNeedingIndex(limit);
  } catch (err) {
    // listFilesNeedingIndex can throw if the DB is corrupt or the sessions
    // directory is in a weird state. Always post a terminal message so the
    // parent's workerBusy flag clears — otherwise indexing wedges.
    postMessage({ type: "error", message: `listFiles failed: ${(err as Error).message}` });
    postMessage({ type: "done", files: 0, entries: 0, ms: Date.now() - t0 });
    return;
  }
  for (let i = 0; i < queue.length; i++) {
    try {
      const c = await indexFile(queue[i]);
      files++;
      entries += c;
      // Light progress events every 20 files
      if (files % 20 === 0) {
        postMessage({ type: "progress", files, entries });
      }
    } catch (err) {
      // Don't kill the whole batch over one bad file
      postMessage({ type: "error", message: `indexFile failed: ${(err as Error).message}` });
    }
  }
  postMessage({ type: "done", files, entries, ms: Date.now() - t0 });
}

async function indexOne(path: string) {
  const t0 = Date.now();
  if (!existsSync(path)) {
    postMessage({ type: "done", files: 0, entries: 0, ms: Date.now() - t0 });
    return;
  }
  try {
    const st = statSync(path);
    const c = await indexFile({ path, mtime: Math.floor(st.mtimeMs), size: st.size });
    postMessage({ type: "done", files: 1, entries: c, ms: Date.now() - t0 });
  } catch (err) {
    postMessage({ type: "error", message: (err as Error).message });
  }
}

async function rebuild() {
  const t0 = Date.now();
  let queue: FileToIndex[];
  try {
    db.exec("DELETE FROM msg_fts");
    db.exec("DELETE FROM indexed_files");
    // Process ALL files. Big job. Worker-thread, so still off the main loop.
    queue = listFilesNeedingIndex(1_000_000);
  } catch (err) {
    // Pre-loop failure (DB corrupt, schema mismatch after a Bun upgrade,
    // disk full) needs a terminal message or workerBusy stays true forever.
    postMessage({ type: "error", message: `rebuild setup failed: ${(err as Error).message}` });
    postMessage({ type: "done", files: 0, entries: 0, ms: Date.now() - t0 });
    return;
  }
  let files = 0;
  let entries = 0;
  for (let i = 0; i < queue.length; i++) {
    try {
      const c = await indexFile(queue[i]);
      files++;
      entries += c;
      if (files % 50 === 0) postMessage({ type: "progress", files, entries });
    } catch (err) {
      postMessage({ type: "error", message: (err as Error).message });
    }
  }
  postMessage({ type: "done", files, entries, ms: Date.now() - t0 });
}

function gc() {
  let removed = 0;
  const rows = db.query<{ path: string }, []>("SELECT path FROM indexed_files").all();
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (!existsSync(r.path)) {
        db.run("DELETE FROM msg_fts WHERE session_path = ?", [r.path]);
        db.run("DELETE FROM indexed_files WHERE path = ?", [r.path]);
        removed++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    postMessage({ type: "error", message: (err as Error).message });
    return;
  }
  postMessage({ type: "done", files: removed, entries: 0, ms: 0 });
}

// ─────────────────────────────────────────────────────────────────────────
// Message handler

declare const self: { onmessage: (e: MessageEvent) => void };

// Wrap each async handler so unhandled rejections still produce a terminal
// done/error pair — otherwise the parent's workerBusy flag never clears.
async function runSafe(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    postMessage({ type: "error", message: `${name} crashed: ${(err as Error).message}` });
    postMessage({ type: "done", files: 0, entries: 0, ms: 0 });
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as {
    cmd: "index-batch" | "index-file" | "rebuild" | "gc" | "shutdown";
    limit?: number;
    path?: string;
  };
  switch (msg.cmd) {
    case "index-batch":
      void runSafe("index-batch", () => runBatch(msg.limit ?? 100));
      break;
    case "index-file":
      if (msg.path) void runSafe("index-file", () => indexOne(msg.path!));
      break;
    case "rebuild":
      void runSafe("rebuild", () => rebuild());
      break;
    case "gc":
      try { gc(); } catch (err) {
        postMessage({ type: "error", message: `gc crashed: ${(err as Error).message}` });
        postMessage({ type: "done", files: 0, entries: 0, ms: 0 });
      }
      break;
    case "shutdown":
      try { db.close(); } catch { /* ignore */ }
      // @ts-expect-error - worker self has terminate-equivalent
      (self as { close?: () => void }).close?.();
      break;
  }
};
