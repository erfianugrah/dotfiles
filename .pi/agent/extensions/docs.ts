/**
 * docs — SSH-based access to the docs.erfi.io documentation server.
 *
 * Direct port of ~/dotfiles/.config/opencode/tools/docs.ts (opencode custom
 * tool) to Pi. Registers six tools — docs_search, docs_read, docs_grep,
 * docs_find, docs_summary, docs_sources — that execute commands on the
 * remote docs server via SSH (ForceCommand-restricted account).
 *
 * The user's AGENTS.md is heavily oriented around these tools. Without this
 * extension Pi has no equivalent and falls back to web search for everything
 * that's actually in docs.erfi.io (158 sources: postgres, supabase, k8s, aws,
 * cloudflare, terraform, vercel, all the framework docs, etc.).
 *
 * Outputs are capped at 51,200 chars with a truncation hint suggesting
 * docs_read with offset/lines or docs_summary for targeted reads.
 *
 * Source: opencode tools/docs.ts; SSH config matches that file exactly
 * (docs@docs.erfi.io:2222, StrictHostKeyChecking disabled to match opencode's
 * established behavior — the server uses ForceCommand so the user can't
 * change directory or run arbitrary commands anyway).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "child_process";

const SSH_HOST = "docs@docs.erfi.io";
const SSH_PORT = "2222";
const MAX_RESULT_CHARS = 51_200;

// ── helpers ───────────────────────────────────────────────────────────────

function sq(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// Agents frequently call docs_read / docs_summary / docs_grep with
// `filePath` (the built-in Read/Edit tool's arg name) instead of `path`.
// Accepting both prevents a confusing crash and keeps the agent moving.
// Prefer `path` when both are provided.
function resolvePath(args: { path?: string; filePath?: string }): string {
  const v = args.path ?? args.filePath;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("'path' is required (alias: 'filePath').");
  }
  return v;
}

function safePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("path is required (string).");
  }
  // Strip traversal segments only — ../ and ..\ — not bare '..' which
  // appears in legitimate filenames (e.g. MDN's do...while/index.md).
  let cleaned = p;
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/\.\.\//g, "").replace(/\.\.\\/g, "").replace(/\/\/+/g, "/");
  } while (cleaned !== prev);
  if (!cleaned.startsWith("/docs/")) {
    return `/docs/${cleaned.replace(/^\/+/, "")}`;
  }
  return cleaned;
}

function capOutput(text: string, path?: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  // Back off one UTF-16 code unit when the cut point lands inside a
  // surrogate pair. Without this we could emit an orphan high surrogate
  // (0xD800–0xDBFF) that breaks JSON serialisation downstream.
  let end = MAX_RESULT_CHARS;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--;
  const truncated = text.slice(0, end);
  const remaining = text.length - end;
  const hint = path
    ? `\n\n[truncated ${remaining} chars — use docs_read with offset/lines or docs_summary to target specific sections of ${path}]`
    : `\n\n[truncated ${remaining} chars — narrow your query or add a line limit]`;
  return truncated + hint;
}

async function ssh(command: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-p",
        SSH_PORT,
        SSH_HOST,
        command,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf-8");
      const stderr = Buffer.concat(err).toString("utf-8").trim();
      if (code === 255) {
        resolve(`[error] SSH connection failed: ${stderr || "connection refused or timed out"}`);
        return;
      }
      // DOCS_CMD_TIMEOUT kill (timeout(1) exits 124 / 143 on SIGTERM)
      if (code === 124 || code === 143) {
        resolve(`[error] command timed out on the docs server (DOCS_CMD_TIMEOUT). Narrow the query or split into smaller reads.`);
        return;
      }
      // Non-zero exit with stderr message — surface so the agent sees the real error
      if (code !== 0 && !stdout && stderr) {
        resolve(`[error] ${stderr}`);
        return;
      }
      resolve(stdout);
    });
    proc.on("error", (e) => resolve(`[error] ${e.message}`));
  });
}

// ── rg --json parsing (for docs_grep structured output) ──────────────────

type RgMatch = { path: string; line: number; text: string };

function parseRgJson(jsonl: string): RgMatch[] {
  const out: RgMatch[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "match") continue;
      out.push({
        path: e.data?.path?.text ?? "",
        line: e.data?.line_number ?? 0,
        text: (e.data?.lines?.text ?? "").replace(/\n$/, ""),
      });
    } catch {
      // skip non-JSON lines
    }
  }
  return out;
}

function formatRgMatches(matches: RgMatch[]): string {
  const lines: string[] = [];
  let lastPath = "";
  for (const m of matches) {
    if (m.path !== lastPath) {
      if (lines.length) lines.push("");
      lines.push(m.path);
      lastPath = m.path;
    }
    lines.push(`  ${m.line}: ${m.text}`);
  }
  return lines.join("\n");
}

// ── tools ─────────────────────────────────────────────────────────────────

const docsSearch = defineTool({
  name: "docs_search",
  promptSnippet: "docs_search — search docs.erfi.io titles+summaries (FIRST step). 158 sources: postgres, supabase, k8s, aws, cloudflare, react, nextjs, etc.",
  promptGuidelines: [
    "Use docs_search FIRST when looking up library / framework / cloud-platform behaviour. Always pass `source=` when the source is known.",
    "After 2 docs_search calls on the same topic with no docs_read in between, STOP rewording and docs_read the top hit.",
    "NEVER `ls` / `find` / `bash` paths under /docs/. They live on docs.erfi.io, not local disk. Use docs_sources / docs_find / docs_search.",
  ],
  label: "Docs Search",
  description:
    "Search documentation by title and summary. Searches a pre-built index instead of scanning all files. Use this FIRST to find relevant docs, then docs_read or docs_grep to get content.",
  parameters: Type.Object({
    query: Type.String({ description: "Search text" }),
    source: Type.Optional(
      Type.String({ description: "Filter to source (e.g. 'supabase', 'aws'). Omit for all." }),
    ),
    maxResults: Type.Optional(Type.Number({ description: "Max results (default: 15)" })),
  }),
  async execute(_id, params) {
    const limit = params.maxResults ?? 15;
    const filter = params.source ? `| rg '^${sq(params.source)}/'` : "";
    const result = await ssh(
      `rg -i '${sq(params.query)}' /docs/_index.tsv ${filter} | awk -v lim=${limit} '{ n++; if (n<=lim) print } END { if (n>lim) print "[showing "lim" of "n" results — refine query or add source filter]" }'`,
    );
    if (!result.trim()) {
      const dir = params.source ? safePath(`/docs/${sq(params.source)}/`) : "/docs/";
      const [fileMatch, contentMatch] = await Promise.all([
        ssh(`find '${dir}' -type f -iname '*${sq(params.query)}*' | head -${limit}`),
        ssh(`rg -il '${sq(params.query)}' '${dir}' 2>/dev/null | head -${limit}`),
      ]);
      const combined = [...new Set([...fileMatch.split("\n"), ...contentMatch.split("\n")].filter(Boolean))];
      if (combined.length) {
        const text = `[no index matches — found via filename/content search]\n${combined.slice(0, limit).join("\n")}`;
        return { content: [{ type: "text", text }], details: { count: combined.length } };
      }
      return {
        content: [{ type: "text", text: `[no results for "${params.query}"${params.source ? ` in ${params.source}` : ""}]` }],
        details: { count: 0 },
      };
    }
    return { content: [{ type: "text", text: result }], details: { source: params.source } };
  },
});

const docsRead = defineTool({
  name: "docs_read",
  label: "Docs Read",
  description:
    "Read a documentation file. For large files, use docs_summary first to see the headings, then read with offset/lines to get only the section you need.",
  promptSnippet: "docs_read — read a docs.erfi.io file by /docs/<source>/... path. Use offset+lines for large files.",
  promptGuidelines: [
    "On files >300 lines, run docs_summary first then docs_read with offset/lines instead of full-file reads.",
    "When the user disputes a doc-based answer, the next call MUST be docs_read on the source — not another docs_search.",
  ],
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "File path (e.g. /docs/supabase/guides/auth.md)" })),
    filePath: Type.Optional(Type.String({ description: "Alias for 'path'. Accepted for compatibility with built-in Read tool." })),
    lines: Type.Optional(Type.Number({ description: "Read N lines. Omit to read to end of file." })),
    offset: Type.Optional(Type.Number({ description: "Start line (1-indexed)." })),
  }),
  async execute(_id, params) {
    const argPath = resolvePath(params);
    const p = safePath(argPath);
    let cmd: string;
    if (params.offset) {
      const start = Math.max(1, Math.floor(params.offset));
      if (params.lines) {
        const end = start + Math.floor(params.lines) - 1;
        cmd = `bat --plain --paging=never --color=never --line-range=${start}:${end} '${sq(p)}' 2>/dev/null || sed -n '${start},${end}p' '${sq(p)}'`;
      } else {
        cmd = `bat --plain --paging=never --color=never --line-range=${start}: '${sq(p)}' 2>/dev/null || sed -n '${start},$p' '${sq(p)}'`;
      }
    } else if (params.lines) {
      cmd = `head -${Math.abs(Math.floor(params.lines))} '${sq(p)}'`;
    } else {
      cmd = `printf '[file] %s lines, %s bytes\\n\\n' "$(wc -l < '${sq(p)}')" "$(wc -c < '${sq(p)}')"; bat --decorations=always --paging=never --color=never --style=numbers '${sq(p)}' 2>/dev/null || cat '${sq(p)}'`;
    }
    const result = await ssh(cmd);
    return { content: [{ type: "text", text: capOutput(result, argPath) }], details: { path: argPath } };
  },
});

const docsFind = defineTool({
  name: "docs_find",
  label: "Docs Find",
  description: "Find documentation files by name or path pattern.",
  promptSnippet: "docs_find — find docs files by glob pattern. Faster than docs_search when you already know part of the filename.",
  promptGuidelines: [
    "Use docs_find to verify a doc file exists by name pattern. Never use bash `ls` / `find` on /docs/ paths — they aren't local files.",
  ],
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern (e.g. '*.md', '*auth*')" }),
    source: Type.Optional(Type.String({ description: "Filter to source (e.g. 'supabase', 'aws')" })),
    maxResults: Type.Optional(Type.Number({ description: "Max results (default: 30)" })),
  }),
  async execute(_id, params) {
    const dir = params.source ? safePath(`/docs/${sq(params.source)}/`) : "/docs/";
    const limit = params.maxResults ?? 30;
    const result = await ssh(`find '${dir}' -name '${sq(params.pattern)}' -type f | head -${limit}`);
    return { content: [{ type: "text", text: result }], details: { pattern: params.pattern, source: params.source } };
  },
});

const docsGrep = defineTool({
  name: "docs_grep",
  label: "Docs Grep",
  description:
    "Search documentation content with surrounding context lines using ripgrep. Returns structured results with file paths and exact line numbers. More detailed than docs_search — shows actual content around matches.",
  promptSnippet: "docs_grep — regex search inside /docs/<source>/ with context lines. Faster than docs_search when you know the source.",
  promptGuidelines: [
    "Prefer docs_grep over docs_search when the source is already known and you want a specific phrase or symbol. Always scope path=/docs/<source>/ so output stays sane.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Regex pattern to search for" }),
    path: Type.Optional(Type.String({ description: "File or dir path (e.g. /docs/postgres/)" })),
    filePath: Type.Optional(Type.String({ description: "Alias for 'path'. Accepted for compatibility with built-in Read tool." })),
    context: Type.Optional(Type.Number({ description: "Context lines per match (default: 3)" })),
  }),
  async execute(_id, params) {
    const ctx = Math.abs(Math.floor(params.context ?? 3));
    const argPath = resolvePath(params);
    const p = safePath(argPath);
    const [jsonResult, countResult] = await Promise.all([
      ssh(`rg -i --json -C${ctx} '${sq(params.query)}' '${sq(p)}' | head -500`),
      ssh(`rg -ic '${sq(params.query)}' '${sq(p)}' 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}'`),
    ]);
    const total = parseInt(countResult, 10) || 0;
    if (jsonResult) {
      const matches = parseRgJson(jsonResult);
      if (matches.length > 0) {
        const formatted = formatRgMatches(matches);
        const countNote = total > matches.length ? ` (showing ${matches.length} of ${total})` : "";
        return {
          content: [{ type: "text", text: capOutput(`${matches.length}${countNote} matches\n\n${formatted}`, argPath) }],
          details: { matches: matches.length, total },
        };
      }
    }
    const plainResult = await ssh(`rg -in -C${ctx} '${sq(params.query)}' '${sq(p)}' | head -100`);
    if (!plainResult.trim()) {
      return {
        content: [{ type: "text", text: `[no matches for "${params.query}" in ${argPath}]` }],
        details: { matches: 0 },
      };
    }
    return { content: [{ type: "text", text: capOutput(plainResult, argPath) }], details: { matches: total } };
  },
});

const docsSummary = defineTool({
  name: "docs_summary",
  label: "Docs Summary",
  description:
    "Get the structure/outline of a documentation file — headings and section names. Use this before docs_read to find the right section to read, saving tokens.",
  promptSnippet: "docs_summary — outline of headings in a docs file. Run BEFORE docs_read on files >300 lines.",
  promptGuidelines: [
    "Run docs_summary before docs_read on any /docs/ file that's >300 lines. Then docs_read with offset/lines to target the section instead of full-file reads.",
  ],
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "File path (e.g. /docs/supabase/guides/auth.md)" })),
    filePath: Type.Optional(Type.String({ description: "Alias for 'path'. Accepted for compatibility with built-in Read tool." })),
  }),
  async execute(_id, params) {
    const argPath = resolvePath(params);
    const p = safePath(argPath);
    const [headings, lineCount, byteCount] = await Promise.all([
      ssh(`rg -n '^#' '${sq(p)}'`),
      ssh(`wc -l < '${sq(p)}'`),
      ssh(`wc -c < '${sq(p)}'`),
    ]);
    const text = `${lineCount.trim()} lines, ${byteCount.trim()} bytes\n\n${headings}`;
    return { content: [{ type: "text", text }], details: { path: argPath } };
  },
});

const docsSources = defineTool({
  name: "docs_sources",
  label: "Docs Sources",
  description: "List all available documentation sources and their file counts.",
  promptSnippet: "docs_sources — list all docs.erfi.io sources (postgres, supabase, k8s, aws, cloudflare, react, nextjs, …). Use to check what's available.",
  promptGuidelines: [
    "Use docs_sources to verify a source exists before docs_search / docs_grep. NEVER `ls /docs/` — those paths aren't on local disk.",
  ],
  parameters: Type.Object({
    filter: Type.Optional(Type.String({ description: "Filter source names (e.g. 'postgres', 'supabase')" })),
  }),
  async execute(_id, params) {
    const filterCmd = params.filter ? ` | rg -i '${sq(params.filter)}'` : "";
    const result = await ssh(
      `find /docs -mindepth 2 -type f 2>/dev/null | awk -F/ '{c[$3]++} END{for (d in c) printf "%s: %d files\\n", d, c[d]}' | sort${filterCmd}`,
    );
    return { content: [{ type: "text", text: result }], details: { filter: params.filter } };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(docsSearch);
  pi.registerTool(docsRead);
  pi.registerTool(docsFind);
  pi.registerTool(docsGrep);
  pi.registerTool(docsSummary);
  pi.registerTool(docsSources);
}
