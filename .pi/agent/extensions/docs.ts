// AUTO-GENERATED from docs-ssh: src/commands/tools-pi-template.ts
// Regenerate: ssh -p PORT docs@HOST tools pi > ~/.pi/agent/extensions/docs.ts
import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"

const SSH_HOST = "docs@docs.erfi.io"
const SSH_PORT = "2222"
const MAX_RESULT_CHARS = 51_200

// ─── Helpers ───────────────────────────────────────────────────────

function sq(s: string): string {
  return s.replace(/'/g, "'\\''")
}

// Split a query into AND-terms. Double-quoted spans stay whole (phrase
// match); everything else splits on whitespace. Always returns >= 1
// token so an empty / all-quotes edge case still yields a runnable cmd.
function tokenizeQuery(q: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] ?? m[2]).trim()
    if (t) tokens.push(t)
  }
  return tokens.length ? tokens : [q.trim()]
}

// OR-match of `rg -i` over a file: any token may match the row. Ranked
// downstream by distinct-token-hit count so the most on-topic line still
// surfaces first, without requiring every word to appear verbatim on the
// same title+summary line (AND-chaining that used to zero-result on any
// natural-language multi-word query).
function rgOrChain(tokens: string[], file: string): string {
  const args = tokens.map((t) => `-e '${sq(t)}'`).join(" ")
  return `rg -i ${args} ${file}`
}

// OR-match of `rg -il` over a directory: any token may match a file's
// content.
function rgFilesOrChain(tokens: string[], dir: string): string {
  const args = tokens.map((t) => `-e '${sq(t)}'`).join(" ")
  return `rg -il ${args} '${dir}' 2>/dev/null`
}

// Rank OR-matched lines by how many distinct query tokens they hit
// (case-insensitive substring match), stable on ties (preserves the
// upstream order - _index.tsv is roughly source-alphabetical).
export function rankByTokenHits(lines: string[], tokens: string[]): string[] {
  if (tokens.length <= 1) return lines
  const lower = tokens.map((t) => t.toLowerCase())
  return lines
    .map((line, i) => {
      const lc = line.toLowerCase()
      const score = lower.reduce((n, t) => n + (lc.includes(t) ? 1 : 0), 0)
      return { line, score, i }
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.line)
}

function resolvePath(args: { path?: string; filePath?: string }): string {
  const v = args.path ?? args.filePath
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("'path' is required (alias: 'filePath').")
  }
  return v
}

// Common local-filesystem prefixes. Catching these before SSHing the docs
// server prevents the confusing "bash: /docs/home/erfi/...: No such file"
// failure mode when the agent forgets these tools target docs.erfi.io and
// not the local FS. Update this list when adding new common roots.
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
]

function looksLikeLocalPath(p: string): boolean {
  if (p.startsWith("~") || p.startsWith("./") || p.startsWith("../")) return true
  // bare /docs/<localprefix>/... - agent prepended /docs to a local absolute
  // path (e.g. resolvePath(filePath=/home/erfi/foo.md) -> /docs/home/erfi/foo.md).
  for (const prefix of LOCAL_FS_PREFIXES) {
    if (p.startsWith(prefix)) return true
    if (p.startsWith(`/docs${prefix}`)) return true
  }
  return false
}

export function safePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("path is required (string).")
  }
  // Strip traversal segments only - ../ and ..\ - not bare '..' which
  // appears in legitimate filenames (e.g. MDN's do...while/index.md).
  let cleaned = p
  let prev: string
  do {
    prev = cleaned
    cleaned = cleaned
      .replace(/\.\.\//g, "")
      .replace(/\.\.\\/g, "")
      .replace(/\/\/+/g, "/")
  } while (cleaned !== prev)
  if (looksLikeLocalPath(cleaned)) {
    throw new Error(
      `'${p}' looks like a local filesystem path, not a docs.erfi.io source path. ` +
        `These tools (docs_read/docs_summary/docs_grep/docs_find/docs_search) only target docs.erfi.io; ` +
        `for files on this machine use the built-in 'read' tool instead. ` +
        `Docs paths look like /docs/<source>/... - list sources with docs_sources.`,
    )
  }
  if (!cleaned.startsWith("/docs/")) {
    return `/docs/${cleaned.replace(/^\/+/, "")}`
  }
  return cleaned
}

// Small wrapper: resolve + validate a path argument, returning either the
// resolved pair or a discriminated error so each tool's execute() can return
// a clean isError result instead of letting safePath's throw bubble up as a
// generic tool failure.
function resolveAndValidate(
  params: { path?: string; filePath?: string },
): { argPath: string; p: string } | { error: string } {
  try {
    const argPath = resolvePath(params)
    const p = safePath(argPath)
    return { argPath, p }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `[error] ${message}` }],
    details: { error: message },
  }
}

function capOutput(text: string, path?: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  let end = MAX_RESULT_CHARS
  const lastCode = text.charCodeAt(end - 1)
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) end--
  const truncated = text.slice(0, end)
  const remaining = text.length - end
  const hint = path
    ? `\n\n[truncated ${remaining} chars - use docs_read with offset/lines or docs_summary to target specific sections of ${path}]`
    : `\n\n[truncated ${remaining} chars - narrow your query or add a line limit]`
  return truncated + hint
}

function ssh(command: string): Promise<string> {
  // node:child_process spawn (not Bun.spawn) - runtime-neutral: works under
  // both Node and Bun, so the generated extension loads in any pi build.
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
    )
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout!.on("data", (b) => out.push(b))
    proc.stderr!.on("data", (b) => err.push(b))
    proc.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf-8")
      const stderr = Buffer.concat(err).toString("utf-8").trim()
      if (code === 255) {
        resolve(`[error] SSH connection failed: ${stderr || "connection refused or timed out"}`)
        return
      }
      // DOCS_CMD_TIMEOUT kill (timeout(1) exits 124 / 143 on SIGTERM)
      if (code === 124 || code === 143) {
        resolve(`[error] command timed out on the docs server (DOCS_CMD_TIMEOUT). Narrow the query or split into smaller reads.`)
        return
      }
      // Non-zero exit with stderr message - surface so the agent sees the real error
      if (code !== 0 && !stdout && stderr) {
        resolve(`[error] ${stderr}`)
        return
      }
      resolve(stdout)
    })
    proc.on("error", (e) => resolve(`[error] ${e.message}`))
  })
}

// ─── rg --json parser ──────────────────────────────────────────────

interface RgMatch {
  path: string
  line: number
  text: string
  submatches?: Array<{ start: number; end: number }>
}

function parseRgJson(raw: string): RgMatch[] {
  const matches: RgMatch[] = []
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === "match") {
        const d = obj.data
        matches.push({
          path: d.path?.text ?? "",
          line: d.line_number ?? 0,
          text: (d.lines?.text ?? "").replace(/\n$/, ""),
          submatches: d.submatches?.map((s: { start: number; end: number }) => ({
            start: s.start,
            end: s.end,
          })),
        })
      }
    } catch {
      // Skip malformed lines
    }
  }
  return matches
}

function formatRgMatches(matches: RgMatch[]): string {
  if (matches.length === 0) return ""
  const lines: string[] = []
  let lastPath = ""
  for (const m of matches) {
    if (m.path !== lastPath) {
      if (lastPath) lines.push("")
      lines.push(m.path)
      lastPath = m.path
    }
    let text = m.text
    if (m.submatches && m.submatches.length > 0) {
      const sorted = [...m.submatches].sort((a, b) => b.start - a.start)
      for (const s of sorted) {
        text = text.slice(0, s.start) + "**" + text.slice(s.start, s.end) + "**" + text.slice(s.end)
      }
    }
    lines.push(`  ${m.line}: ${text}`)
  }
  return lines.join("\n")
}

// ─── Tool definitions ──────────────────────────────────────────────

const searchTool = defineTool({
  name: "docs_search",
  label: "Docs Search",
  promptSnippet: "docs_search - search documentation index (titles+summaries).",
  promptGuidelines: [
    "Pass source= when known (e.g. 'supabase', 'cloudflare'). Index is ~15x smaller than raw docs.",
    "Multi-word queries auto-OR across tokens, ranked by distinct-token-hit count. Quote a phrase for a literal match.",
    "After 2 calls with no drill-in, stop and docs_read the top hit (or docs_grep path=/docs/<source>/ to escalate after a zero-results search).",
    "Always cite the source path(s) in your response (e.g. Source: /docs/supabase/guides/auth.md).",
  ],
  description:
    "Search docs.erfi.io title+summary index. Searches a pre-built index instead of scanning all files. Use this FIRST to find relevant docs.",

  parameters: Type.Object({
    query: Type.String({ description: "Search text" }),
    source: Type.Optional(
      Type.String({ description: "Filter to source (e.g. 'supabase', 'aws'). Omit for all." }),
    ),
    maxResults: Type.Optional(Type.Number({ description: "Max results (default: 15)" })),
  }),

  async execute(_id, params) {
    const limit = params.maxResults ?? 15
    const tokens = tokenizeQuery(params.query)
    const filter = params.source ? `| rg '^${sq(params.source)}/'` : ""
    const raw = await ssh(`${rgOrChain(tokens, "/docs/_index.tsv")} ${filter}`)
    const lines = raw.split("\n").filter(Boolean)
    if (lines.length === 0) {
      let dir: string
      try {
        dir = params.source ? safePath(`/docs/${sq(params.source)}/`) : "/docs/"
      } catch (e) {
        return errorResult((e as Error).message)
      }
      const inameOr = tokens.map((t) => `-iname '*${sq(t)}*'`).join(" -o ")
      const [fileMatch, contentMatch] = await Promise.all([
        ssh(`find '${dir}' -type f \\( ${inameOr} \\) | head -${limit}`),
        ssh(`${rgFilesOrChain(tokens, dir)} | head -${limit}`),
      ])
      const combined = [...new Set([...fileMatch.split("\n"), ...contentMatch.split("\n")].filter(Boolean))]
      if (combined.length) {
        return {
          content: [{ type: "text", text: `[no index matches - found via filename/content search]\n${combined.slice(0, limit).join("\n")}` }],
          details: { query: params.query, source: params.source, via: "fallback" },
        }
      }
      return {
        content: [{ type: "text", text: `[no results for "${params.query}"${params.source ? ` in ${params.source}` : ""}]` }],
        details: { query: params.query, source: params.source },
      }
    }
    const ranked = rankByTokenHits(lines, tokens)
    const top = ranked.slice(0, limit)
    const text = ranked.length > limit
      ? `${top.join("\n")}\n[showing ${limit} of ${ranked.length} results - refine query or add source filter]`
      : top.join("\n")
    return {
      content: [{ type: "text", text }],
      details: { query: params.query, source: params.source },
    }
  },
})

const readTool = defineTool({
  name: "docs_read",
  label: "Docs Read",
  promptSnippet: "docs_read - read a documentation file (full or line range).",
  promptGuidelines: [
    "Use docs_summary first on files >300 lines to find the right offset.",
    "offset+lines reads a targeted range (~140 tokens for 35 lines vs ~2K for full file).",
    "Pass filePath as alias for path (compatibility with built-in Read tool).",
    "Always cite the [source] path from the output header in your response.",
  ],
  description:
    "Read a /docs/<source>/... file. Use offset+lines for large files.",

  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "File path (e.g. /docs/supabase/guides/auth.md)" })),
    filePath: Type.Optional(Type.String({ description: "Alias for 'path'. Accepted for compatibility with built-in Read tool." })),
    lines: Type.Optional(Type.Number({ description: "Read N lines. Omit to read to end of file." })),
    offset: Type.Optional(Type.Number({ description: "Start line (1-indexed)." })),
  }),

  async execute(_id, params) {
    const v = resolveAndValidate(params)
    if ("error" in v) return errorResult(v.error)
    const { argPath, p } = v
    let cmd: string

    if (params.offset) {
      const start = Math.max(1, Math.floor(params.offset))
      if (params.lines) {
        const end = start + Math.floor(params.lines) - 1
        cmd = `bat --plain --paging=never --color=never --line-range=${start}:${end} '${sq(p)}' 2>/dev/null || sed -n '${start},${end}p' '${sq(p)}'`
      } else {
        cmd = `bat --plain --paging=never --color=never --line-range=${start}: '${sq(p)}' 2>/dev/null || sed -n '${start},$p' '${sq(p)}'`
      }
    } else if (params.lines) {
      cmd = `head -${Math.abs(Math.floor(params.lines))} '${sq(p)}'`
    } else {
      cmd = `printf '[file] %s lines, %s bytes\\n\\n' "$(wc -l < '${sq(p)}')" "$(wc -c < '${sq(p)}')"; bat --decorations=always --paging=never --color=never --style=numbers '${sq(p)}' 2>/dev/null || cat '${sq(p)}'`
    }

    const result = await ssh(cmd)
    const text = capOutput(`[source] ${argPath}\n\n` + result, argPath)
    return {
      content: [{ type: "text", text }],
      details: { path: argPath, offset: params.offset, lines: params.lines },
    }
  },
})

const findTool = defineTool({
  name: "docs_find",
  label: "Docs Find",
  promptSnippet: "docs_find - find documentation files by name / glob pattern.",
  promptGuidelines: [
    "Use when filename is partly known. e.g. pattern='*auth*', source='supabase'.",
  ],
  description: "Find docs files by name / glob pattern.",

  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern (e.g. '*.md', '*auth*')" }),
    source: Type.Optional(Type.String({ description: "Filter to source (e.g. 'supabase', 'aws')" })),
    maxResults: Type.Optional(Type.Number({ description: "Max results (default: 30)" })),
  }),

  async execute(_id, params) {
    let dir: string
    try {
      dir = params.source ? safePath(`/docs/${sq(params.source)}/`) : "/docs/"
    } catch (e) {
      return errorResult((e as Error).message)
    }
    const limit = params.maxResults ?? 30
    const result = await ssh(`find '${dir}' -iname '${sq(params.pattern)}' -type f | head -${limit}`)
    return {
      content: [{ type: "text", text: result }],
      details: { pattern: params.pattern, source: params.source },
    }
  },
})

const grepTool = defineTool({
  name: "docs_grep",
  label: "Docs Grep",
  promptSnippet: "docs_grep - regex search docs with context lines.",
  promptGuidelines: [
    "Scope path=/docs/<source>/ to keep output sane.",
    "context=3 (default) - increase for more surrounding lines.",
    "Use docs_search first; docs_grep is for targeted content search within a known source.",
    "Always include source path(s) in your response.",
  ],
  description:
    "Regex search inside /docs/<path>/ with context lines.",

  parameters: Type.Object({
    query: Type.String({ description: "Regex pattern to search for" }),
    path: Type.Optional(Type.String({ description: "File or dir path (e.g. /docs/postgres/)" })),
    filePath: Type.Optional(Type.String({ description: "Alias for 'path'." })),
    context: Type.Optional(Type.Number({ description: "Context lines per match (default: 3)" })),
  }),

  async execute(_id, params) {
    const ctx = Math.abs(Math.floor(params.context ?? 3))
    const v = resolveAndValidate(params)
    if ("error" in v) return errorResult(v.error)
    const { argPath, p } = v

    const [jsonResult, countResult] = await Promise.all([
      ssh(`rg -i --json -C${ctx} '${sq(params.query)}' '${sq(p)}' | head -500`),
      ssh(`rg -ic '${sq(params.query)}' '${sq(p)}' 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}'`),
    ])
    const total = parseInt(countResult) || 0

    if (jsonResult) {
      const matches = parseRgJson(jsonResult)
      if (matches.length > 0) {
        const formatted = formatRgMatches(matches)
        const countNote = total > matches.length ? ` (showing ${matches.length} of ${total})` : ""
        const text = capOutput(`${matches.length}${countNote} matches\n\n${formatted}`, argPath)
        return {
          content: [{ type: "text", text }],
          details: { query: params.query, path: argPath, matches: matches.length, total },
        }
      }
    }

    const plainResult = await ssh(`rg -in -C${ctx} '${sq(params.query)}' '${sq(p)}' | head -100`)
    if (!plainResult.trim()) {
      return {
        content: [{ type: "text", text: `[no matches for "${params.query}" in ${argPath}]` }],
        details: { query: params.query, path: argPath, matches: 0 },
      }
    }
    return {
      content: [{ type: "text", text: capOutput(plainResult, argPath) }],
      details: { query: params.query, path: argPath },
    }
  },
})

const summaryTool = defineTool({
  name: "docs_summary",
  label: "Docs Summary",
  promptSnippet: "docs_summary - outline (headings only) of a docs file.",
  promptGuidelines: [
    "Run before docs_read on files >300 lines to find the right line range.",
    "Returns heading list + file size so you know whether to narrow with offset/lines.",
    "Always include the source path in your response.",
  ],
  description: "Outline (headings only) of a docs file.",

  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "File path (e.g. /docs/supabase/guides/auth.md)" })),
    filePath: Type.Optional(Type.String({ description: "Alias for 'path'." })),
  }),

  async execute(_id, params) {
    const v = resolveAndValidate(params)
    if ("error" in v) return errorResult(v.error)
    const { argPath, p } = v
    const [headings, lineCount, byteCount] = await Promise.all([
      ssh(`rg -n '^#' '${sq(p)}'`),
      ssh(`wc -l < '${sq(p)}'`),
      ssh(`wc -c < '${sq(p)}'`),
    ])
    return {
      content: [{ type: "text", text: `[source] ${argPath}\n\n${lineCount.trim()} lines, ${byteCount.trim()} bytes\n\n${headings}` }],
      details: { path: argPath, lines: parseInt(lineCount) || 0, bytes: parseInt(byteCount) || 0 },
    }
  },
})

const sourcesTool = defineTool({
  name: "docs_sources",
  label: "Docs Sources",
  promptSnippet: "docs_sources - list available documentation sources with file counts.",
  promptGuidelines: [
    "Pass filter= to narrow (e.g. 'postgres', 'supabase'). Omit for all sources.",
    "Check this before docs_search to confirm a source exists.",
  ],
  description: "List docs.erfi.io sources with file counts.",

  parameters: Type.Object({
    filter: Type.Optional(Type.String({ description: "Filter source names (e.g. 'postgres', 'supabase')" })),
  }),

  async execute(_id, params) {
    const filterCmd = params.filter ? ` | rg -i '${sq(params.filter)}'` : ""
    // Derive counts from the pre-built /docs/_index.tsv (one line per file,
    // path starts with `<source>/...`) rather than walking the entire /docs
    // tree with find - on hundreds of sources x thousands of files the find
    // walk takes seconds; awk on the index is ~ms. Falls back to the find
    // walk if the index is missing or empty.
    const result = await ssh(
      `if [ -s /docs/_index.tsv ]; then awk -F/ '{c[$1]++} END{for (d in c) printf "%s: %d files\\n", d, c[d]}' /docs/_index.tsv | sort${filterCmd}; else find /docs -mindepth 2 -type f 2>/dev/null | awk -F/ '{c[$3]++} END{for (d in c) printf "%s: %d files\\n", d, c[d]}' | sort${filterCmd}; fi`,
    )
    return {
      content: [{ type: "text", text: result }],
      details: { filter: params.filter },
    }
  },
})

// ─── Export ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(searchTool)
  pi.registerTool(readTool)
  pi.registerTool(findTool)
  pi.registerTool(grepTool)
  pi.registerTool(summaryTool)
  pi.registerTool(sourcesTool)
}

