/**
 * docs-core - pure command-building, response parsing/projection, rendering,
 * and an SSH orchestrator for the docs.erfi.io toolset. ZERO harness imports
 * (node stdlib + global only). Source of truth for the pi adapter (../docs.ts)
 * and the Claude Code MCP toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * The docs.* operations shell out to `ssh docs@docs.erfi.io` and run rg / bat /
 * find / awk on the remote. All the arg-quoting, query tokenisation, ranking,
 * rg --json parsing, and output capping is pure and unit-tested with fixtures;
 * the single impure edge is runSsh() (spawn) + the DOCS_HOST/DOCS_PORT env read.
 *
 * Extracted from docs.ts (2026-08-12); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { spawn } from "node:child_process";

const SSH_HOST = process.env.DOCS_SSH_HOST ?? "docs@docs.erfi.io";
const SSH_PORT = process.env.DOCS_SSH_PORT ?? "2222";
const MAX_RESULT_CHARS = 51_200;

// ─── quoting / tokenisation (pure) ─────────────────────────────────────────

export function sq(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// Split a query into AND-terms. Double-quoted spans stay whole (phrase
// match); everything else splits on whitespace. Always returns >= 1
// token so an empty / all-quotes edge case still yields a runnable cmd.
export function tokenizeQuery(q: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] ?? m[2]).trim();
    if (t) tokens.push(t);
  }
  return tokens.length ? tokens : [q.trim()];
}

// OR-match of `rg -i` over a file: any token may match the row.
export function rgOrChain(tokens: string[], file: string): string {
  const args = tokens.map((t) => `-e '${sq(t)}'`).join(" ");
  return `rg -i ${args} ${file}`;
}

// OR-match of `rg -il` over a directory: any token may match a file's content.
export function rgFilesOrChain(tokens: string[], dir: string): string {
  const args = tokens.map((t) => `-e '${sq(t)}'`).join(" ");
  return `rg -il ${args} '${dir}' 2>/dev/null`;
}

// Rank OR-matched lines by how many distinct query tokens they hit
// (case-insensitive substring match), stable on ties.
export function rankByTokenHits(lines: string[], tokens: string[]): string[] {
  if (tokens.length <= 1) return lines;
  const lower = tokens.map((t) => t.toLowerCase());
  return lines
    .map((line, i) => {
      const lc = line.toLowerCase();
      const score = lower.reduce((n, t) => n + (lc.includes(t) ? 1 : 0), 0);
      return { line, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.line);
}

// ─── path resolution / validation (pure) ───────────────────────────────────

export function resolvePath(args: { path?: string; filePath?: string }): string {
  const v = args.path ?? args.filePath;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("'path' is required (alias: 'filePath').");
  }
  return v;
}

// Common local-filesystem prefixes. Catching these before SSHing the docs
// server prevents the confusing "bash: /docs/home/erfi/...: No such file"
// failure mode when the agent forgets these tools target docs.erfi.io.
const LOCAL_FS_PREFIXES = [
  "/home/",
  "/root/",
  "/Users/",
  "/etc/",
  "/var/",
  "/tmp/",
  "/opt/",
  "/srv/",
  "/mnt/",
  "/private/",
  "/usr/",
  "/dev/",
  "/proc/",
  "/sys/",
];

function looksLikeLocalPath(p: string): boolean {
  if (p.startsWith("~") || p.startsWith("./") || p.startsWith("../")) return true;
  // bare /docs/<localprefix>/... - agent prepended /docs to a local absolute path.
  for (const prefix of LOCAL_FS_PREFIXES) {
    if (p.startsWith(prefix)) return true;
    if (p.startsWith(`/docs${prefix}`)) return true;
  }
  return false;
}

export function safePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("path is required (string).");
  }
  // Strip traversal segments only - ../ and ..\ - not bare '..' which
  // appears in legitimate filenames (e.g. MDN's do...while/index.md).
  let cleaned = p;
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned
      .replace(/\.\.\//g, "")
      .replace(/\.\.\\/g, "")
      .replace(/\/\/+/g, "/");
  } while (cleaned !== prev);
  if (looksLikeLocalPath(cleaned)) {
    throw new Error(
      `'${p}' looks like a local filesystem path, not a docs.erfi.io source path. ` +
        `These tools (docs_read/docs_summary/docs_grep/docs_find/docs_search) only target docs.erfi.io; ` +
        `for files on this machine use the built-in 'read' tool instead. ` +
        `Docs paths look like /docs/<source>/... - list sources with docs_sources.`,
    );
  }
  if (!cleaned.startsWith("/docs/")) {
    return `/docs/${cleaned.replace(/^\/+/, "")}`;
  }
  return cleaned;
}

// Resolve + validate a path argument, returning either the resolved pair or a
// discriminated error so each operation can return a clean isError result.
export function resolveAndValidate(
  params: { path?: string; filePath?: string },
): { argPath: string; p: string } | { error: string } {
  try {
    const argPath = resolvePath(params);
    const p = safePath(argPath);
    return { argPath, p };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ─── output capping (pure) ─────────────────────────────────────────────────

export function capOutput(text: string, path?: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  let end = MAX_RESULT_CHARS;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--;
  const truncated = text.slice(0, end);
  const remaining = text.length - end;
  const hint = path
    ? `\n\n[truncated ${remaining} chars - use docs_read with offset/lines or docs_summary to target specific sections of ${path}]`
    : `\n\n[truncated ${remaining} chars - narrow your query or add a line limit]`;
  return truncated + hint;
}

// ─── rg --json parser (pure) ───────────────────────────────────────────────

export interface RgMatch {
  path: string;
  line: number;
  text: string;
  submatches?: Array<{ start: number; end: number }>;
}

export function parseRgJson(raw: string): RgMatch[] {
  const matches: RgMatch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "match") {
        const d = obj.data;
        matches.push({
          path: d.path?.text ?? "",
          line: d.line_number ?? 0,
          text: (d.lines?.text ?? "").replace(/\n$/, ""),
          submatches: d.submatches?.map((s: { start: number; end: number }) => ({
            start: s.start,
            end: s.end,
          })),
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return matches;
}

export function formatRgMatches(matches: RgMatch[]): string {
  if (matches.length === 0) return "";
  const lines: string[] = [];
  let lastPath = "";
  for (const m of matches) {
    if (m.path !== lastPath) {
      if (lastPath) lines.push("");
      lines.push(m.path);
      lastPath = m.path;
    }
    let text = m.text;
    if (m.submatches && m.submatches.length > 0) {
      const sorted = [...m.submatches].sort((a, b) => b.start - a.start);
      for (const s of sorted) {
        text = text.slice(0, s.start) + "**" + text.slice(s.start, s.end) + "**" + text.slice(s.end);
      }
    }
    lines.push(`  ${m.line}: ${text}`);
  }
  return lines.join("\n");
}

// ─── command builders (pure) ───────────────────────────────────────────────

export function buildSearchCmd(tokens: string[], source?: string): string {
  const filter = source ? `| rg '^${sq(source)}/'` : "";
  return `${rgOrChain(tokens, "/docs/_index.tsv")} ${filter}`;
}

export function buildSearchFallbackCmds(
  tokens: string[],
  dir: string,
  limit: number,
): { findCmd: string; contentCmd: string } {
  const inameOr = tokens.map((t) => `-iname '*${sq(t)}*'`).join(" -o ");
  return {
    findCmd: `find '${dir}' -type f \\( ${inameOr} \\) | head -${limit}`,
    contentCmd: `${rgFilesOrChain(tokens, dir)} | head -${limit}`,
  };
}

export function buildReadCmd(p: string, opts: { offset?: number; lines?: number }): string {
  if (opts.offset) {
    const start = Math.max(1, Math.floor(opts.offset));
    if (opts.lines) {
      const end = start + Math.floor(opts.lines) - 1;
      return `bat --plain --paging=never --color=never --line-range=${start}:${end} '${sq(p)}' 2>/dev/null || sed -n '${start},${end}p' '${sq(p)}'`;
    }
    return `bat --plain --paging=never --color=never --line-range=${start}: '${sq(p)}' 2>/dev/null || sed -n '${start},$p' '${sq(p)}'`;
  }
  if (opts.lines) {
    return `head -${Math.abs(Math.floor(opts.lines))} '${sq(p)}'`;
  }
  return `printf '[file] %s lines, %s bytes\\n\\n' "$(wc -l < '${sq(p)}')" "$(wc -c < '${sq(p)}')"; bat --decorations=always --paging=never --color=never --style=numbers '${sq(p)}' 2>/dev/null || cat '${sq(p)}'`;
}

export function buildFindCmd(dir: string, pattern: string, limit: number): string {
  return `find '${dir}' -iname '${sq(pattern)}' -type f | head -${limit}`;
}

export function buildGrepJsonCmd(p: string, query: string, ctx: number): string {
  return `rg -i --json -C${ctx} '${sq(query)}' '${sq(p)}' | head -500`;
}

export function buildGrepCountCmd(p: string, query: string): string {
  return `rg -ic '${sq(query)}' '${sq(p)}' 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}'`;
}

export function buildGrepPlainCmd(p: string, query: string, ctx: number): string {
  return `rg -in -C${ctx} '${sq(query)}' '${sq(p)}' | head -100`;
}

export function buildSummaryCmds(p: string): { headings: string; lineCount: string; byteCount: string } {
  return {
    headings: `rg -n '^#' '${sq(p)}'`,
    lineCount: `wc -l < '${sq(p)}'`,
    byteCount: `wc -c < '${sq(p)}'`,
  };
}

export function buildSourcesCmd(filter?: string): string {
  const filterCmd = filter ? ` | rg -i '${sq(filter)}'` : "";
  // Derive counts from the pre-built /docs/_index.tsv (one line per file) rather
  // than walking the entire /docs tree; falls back to the find walk if missing.
  return `if [ -s /docs/_index.tsv ]; then awk -F/ '{c[$1]++} END{for (d in c) printf "%s: %d files\\n", d, c[d]}' /docs/_index.tsv | sort${filterCmd}; else find /docs -mindepth 2 -type f 2>/dev/null | awk -F/ '{c[$3]++} END{for (d in c) printf "%s: %d files\\n", d, c[d]}' | sort${filterCmd}; fi`;
}

// ─── SSH runner (impure edge) ──────────────────────────────────────────────

export function runSsh(command: string): Promise<string> {
  // node:child_process spawn (not Bun.spawn) - runtime-neutral.
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
    proc.stdout!.on("data", (b) => out.push(b));
    proc.stderr!.on("data", (b) => err.push(b));
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
      if (code !== 0 && !stdout && stderr) {
        resolve(`[error] ${stderr}`);
        return;
      }
      resolve(stdout);
    });
    proc.on("error", (e) => resolve(`[error] ${e.message}`));
  });
}

// ─── harness-agnostic orchestrator ─────────────────────────────────────────

export type DocsAction = "search" | "read" | "grep" | "find" | "summary" | "sources";

export interface DocsParams {
  // search / grep
  query?: string;
  // search / find / sources filter
  source?: string;
  filter?: string;
  // read / grep / summary
  path?: string;
  filePath?: string;
  // read
  offset?: number;
  lines?: number;
  // grep
  context?: number;
  // find
  pattern?: string;
  // search / find
  maxResults?: number;
}

export interface DocsResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

function errorResult(message: string): DocsResult {
  return { isError: true, text: `[error] ${message}`, details: { error: message } };
}

// The SSH runner is injectable so tests can exercise the full orchestrator with
// fixtures and no network. Defaults to the real runSsh.
export async function runDocs(
  action: DocsAction,
  params: DocsParams,
  ssh: (cmd: string) => Promise<string> = runSsh,
): Promise<DocsResult> {
  switch (action) {
    case "search":
      return docsSearch(params, ssh);
    case "read":
      return docsRead(params, ssh);
    case "grep":
      return docsGrep(params, ssh);
    case "find":
      return docsFind(params, ssh);
    case "summary":
      return docsSummary(params, ssh);
    case "sources":
      return docsSources(params, ssh);
    default:
      return errorResult(`unknown action '${action}'`);
  }
}

async function docsSearch(params: DocsParams, ssh: (cmd: string) => Promise<string>): Promise<DocsResult> {
  if (!params.query) return errorResult("'query' is required for search.");
  const limit = params.maxResults ?? 15;
  const tokens = tokenizeQuery(params.query);
  const raw = await ssh(buildSearchCmd(tokens, params.source));
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) {
    let dir: string;
    try {
      dir = params.source ? safePath(`/docs/${sq(params.source)}/`) : "/docs/";
    } catch (e) {
      return errorResult((e as Error).message);
    }
    const { findCmd, contentCmd } = buildSearchFallbackCmds(tokens, dir, limit);
    const [fileMatch, contentMatch] = await Promise.all([ssh(findCmd), ssh(contentCmd)]);
    const combined = [
      ...new Set([...fileMatch.split("\n"), ...contentMatch.split("\n")].filter(Boolean)),
    ];
    if (combined.length) {
      return {
        text: `[no index matches - found via filename/content search]\n${combined.slice(0, limit).join("\n")}`,
        details: { query: params.query, source: params.source, via: "fallback" },
      };
    }
    return {
      text: `[no results for "${params.query}"${params.source ? ` in ${params.source}` : ""}]`,
      details: { query: params.query, source: params.source },
    };
  }
  const ranked = rankByTokenHits(lines, tokens);
  const top = ranked.slice(0, limit);
  const text =
    ranked.length > limit
      ? `${top.join("\n")}\n[showing ${limit} of ${ranked.length} results - refine query or add source filter]`
      : top.join("\n");
  return { text, details: { query: params.query, source: params.source } };
}

async function docsRead(params: DocsParams, ssh: (cmd: string) => Promise<string>): Promise<DocsResult> {
  const v = resolveAndValidate(params);
  if ("error" in v) return errorResult(v.error);
  const { argPath, p } = v;
  const result = await ssh(buildReadCmd(p, { offset: params.offset, lines: params.lines }));
  const text = capOutput(`[source] ${argPath}\n\n` + result, argPath);
  return { text, details: { path: argPath, offset: params.offset, lines: params.lines } };
}

async function docsFind(params: DocsParams, ssh: (cmd: string) => Promise<string>): Promise<DocsResult> {
  if (!params.pattern) return errorResult("'pattern' is required for find.");
  let dir: string;
  try {
    dir = params.source ? safePath(`/docs/${sq(params.source)}/`) : "/docs/";
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const limit = params.maxResults ?? 30;
  const result = await ssh(buildFindCmd(dir, params.pattern, limit));
  return { text: result, details: { pattern: params.pattern, source: params.source } };
}

async function docsGrep(params: DocsParams, ssh: (cmd: string) => Promise<string>): Promise<DocsResult> {
  if (!params.query) return errorResult("'query' is required for grep.");
  const ctx = Math.abs(Math.floor(params.context ?? 3));
  const v = resolveAndValidate(params);
  if ("error" in v) return errorResult(v.error);
  const { argPath, p } = v;

  const [jsonResult, countResult] = await Promise.all([
    ssh(buildGrepJsonCmd(p, params.query, ctx)),
    ssh(buildGrepCountCmd(p, params.query)),
  ]);
  const total = parseInt(countResult) || 0;

  if (jsonResult) {
    const matches = parseRgJson(jsonResult);
    if (matches.length > 0) {
      const formatted = formatRgMatches(matches);
      const countNote = total > matches.length ? ` (showing ${matches.length} of ${total})` : "";
      const text = capOutput(`${matches.length}${countNote} matches\n\n${formatted}`, argPath);
      return {
        text,
        details: { query: params.query, path: argPath, matches: matches.length, total },
      };
    }
  }

  const plainResult = await ssh(buildGrepPlainCmd(p, params.query, ctx));
  if (!plainResult.trim()) {
    return {
      text: `[no matches for "${params.query}" in ${argPath}]`,
      details: { query: params.query, path: argPath, matches: 0 },
    };
  }
  return { text: capOutput(plainResult, argPath), details: { query: params.query, path: argPath } };
}

async function docsSummary(params: DocsParams, ssh: (cmd: string) => Promise<string>): Promise<DocsResult> {
  const v = resolveAndValidate(params);
  if ("error" in v) return errorResult(v.error);
  const { argPath, p } = v;
  const cmds = buildSummaryCmds(p);
  const [headings, lineCount, byteCount] = await Promise.all([
    ssh(cmds.headings),
    ssh(cmds.lineCount),
    ssh(cmds.byteCount),
  ]);
  return {
    text: `[source] ${argPath}\n\n${lineCount.trim()} lines, ${byteCount.trim()} bytes\n\n${headings}`,
    details: { path: argPath, lines: parseInt(lineCount) || 0, bytes: parseInt(byteCount) || 0 },
  };
}

async function docsSources(params: DocsParams, ssh: (cmd: string) => Promise<string>): Promise<DocsResult> {
  const result = await ssh(buildSourcesCmd(params.filter));
  return { text: result, details: { filter: params.filter } };
}
