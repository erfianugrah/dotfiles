import { z } from "zod"

const SSH_HOST = "docs@docs.erfi.io"
const SSH_PORT = "2222"
const MAX_RESULT_CHARS = 51_200

// ─── Helpers ───────────────────────────────────────────────────────

function sq(s: string): string {
  return s.replace(/'/g, "'\\''")
}

function safePath(p: string): string {
  // Strip traversal segments only — ../ and ..\ — not bare '..' which
  // appears in legitimate filenames (e.g. MDN's do...while/index.md).
  // Loop until stable so stacked patterns like ....// collapse fully.
  let cleaned = p
  let prev: string
  do {
    prev = cleaned
    cleaned = cleaned
      .replace(/\.\.\//g, "")
      .replace(/\.\.\\/g, "")
      .replace(/\/\/+/g, "/")
  } while (cleaned !== prev)
  if (!cleaned.startsWith("/docs/")) {
    return `/docs/${cleaned.replace(/^\/+/, "")}`
  }
  return cleaned
}

function capOutput(text: string, path?: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  // Back off one UTF-16 code unit when the cut point lands inside a
  // surrogate pair. Without this, the caller could receive an orphan
  // high surrogate (0xD800–0xDBFF) that breaks JSON serialisation.
  let end = MAX_RESULT_CHARS
  const lastCode = text.charCodeAt(end - 1)
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) end--
  const truncated = text.slice(0, end)
  const remaining = text.length - end
  const hint = path
    ? `\n\n[truncated ${remaining} chars — use docs_read with offset/lines or docs_summary to target specific sections of ${path}]`
    : `\n\n[truncated ${remaining} chars — narrow your query or add a line limit]`
  return truncated + hint
}

async function ssh(command: string): Promise<string> {
  const proc = Bun.spawn(
    ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-p", SSH_PORT, SSH_HOST, command],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [text, errText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  // SSH connection failure (exit 255)
  if (exitCode === 255) {
    return `[error] SSH connection failed: ${errText.trim() || "connection refused or timed out"}`
  }
  // Server-side DOCS_CMD_TIMEOUT kill: timeout(1) exits 124 (or 143 when
  // the child inherits the SIGTERM status). timeout writes no stderr, so
  // without this branch the agent would see an empty string and not know
  // the command was killed.
  if (exitCode === 124 || exitCode === 143) {
    return `[error] command timed out on the docs server (DOCS_CMD_TIMEOUT). Narrow the query or split into smaller reads.`
  }
  // Remote command error: non-zero exit + empty stdout + stderr message.
  // Catches: find on nonexistent dir, cat on directory, rg on missing path.
  // Does NOT trigger for rg "no matches" (exit 1 but empty stderr).
  if (exitCode !== 0 && !text.trim() && errText.trim()) {
    return `[error] ${errText.trim()}`
  }
  return text.trim()
}

// ─── rg --json parser ──────────────────────────────────────────────
// Parses ripgrep JSON output into a compact, structured format.
// Each match becomes: "path:line: content" with submatches marked.
// Falls back to raw output if parsing fails.

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
    // Wrap the matched substring(s) in **…** so agents see exact match
    // positions without re-scanning the line. Walk submatches back-to-front
    // to keep earlier byte indices valid while we splice.
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

export const search = {
  description:
    "Search documentation by title and summary. Searches a pre-built index instead of scanning all files. Use this FIRST to find relevant docs, then docs_read or docs_grep to get content.",

  args: {
    query: z.string().describe("Search text"),
    source: z
      .string()
      .optional()
      .describe("Filter to source (e.g. 'supabase', 'aws'). Omit for all."),
    maxResults: z.number().optional().describe("Max results (default: 15)"),
  },
  async execute(args: { query: string; source?: string; maxResults?: number }) {
    const limit = args.maxResults ?? 15
    const filter = args.source ? `| rg '^${sq(args.source)}/'` : ""
    // Single-pass: awk prints the first LIMIT rows as they arrive and
    // emits a truncation footer at END if there were more. One rg
    // invocation vs the previous two (count + head).
    const result = await ssh(
      `rg -i '${sq(args.query)}' /docs/_index.tsv ${filter} | awk -v lim=${limit} '{ n++; if (n<=lim) print } END { if (n>lim) print "[showing "lim" of "n" results — refine query or add source filter]" }'`
    )

    // Fallback: if index search found nothing, try filename + content search
    if (!result.trim()) {
      const dir = args.source ? safePath(`/docs/${sq(args.source)}/`) : "/docs/"
      // Search filenames first (fast), then content
      const [fileMatch, contentMatch] = await Promise.all([
        ssh(`find '${dir}' -type f -iname '*${sq(args.query)}*' | head -${limit}`),
        ssh(`rg -il '${sq(args.query)}' '${dir}' 2>/dev/null | head -${limit}`),
      ])
      const combined = [...new Set([...fileMatch.split("\n"), ...contentMatch.split("\n")].filter(Boolean))]
      if (combined.length) {
        return `[no index matches — found via filename/content search]\n${combined.slice(0, limit).join("\n")}`
      }
      return `[no results for "${args.query}"${args.source ? ` in ${args.source}` : ""}]`
    }

    return result
  },
}

export const read = {
  description:
    "Read a documentation file. For large files, use docs_summary first to see the headings, then read with offset/lines to get only the section you need.",
  args: {
    path: z.string().describe("File path (e.g. /docs/supabase/guides/auth.md)"),
    lines: z.number().optional().describe("Read N lines. Omit to read to end of file."),
    offset: z.number().optional().describe("Start line (1-indexed)."),
  },
  async execute(args: { path: string; lines?: number; offset?: number }) {
    const p = safePath(args.path)
    let cmd: string
    const fullFile = !args.offset && !args.lines

    if (args.offset) {
      // offset set (with or without lines). bat's open-ended range
      // "--line-range=N:" reads from N to end of file; if lines is set
      // we compute an explicit end. sed fallback uses the same bounds.
      const start = Math.max(1, Math.floor(args.offset))
      if (args.lines) {
        const end = start + Math.floor(args.lines) - 1
        cmd = `bat --plain --paging=never --color=never --line-range=${start}:${end} '${sq(p)}' 2>/dev/null || sed -n '${start},${end}p' '${sq(p)}'`
      } else {
        cmd = `bat --plain --paging=never --color=never --line-range=${start}: '${sq(p)}' 2>/dev/null || sed -n '${start},$p' '${sq(p)}'`
      }
    } else if (args.lines) {
      cmd = `head -${Math.abs(Math.floor(args.lines))} '${sq(p)}'`
    } else {
      // Full-file read: prepend a one-line scale header so the agent
      // can see file size at a glance and decide whether to narrow
      // next time (saves tokens on repeated full reads of big files).
      cmd = `printf '[file] %s lines, %s bytes\\n\\n' "$(wc -l < '${sq(p)}')" "$(wc -c < '${sq(p)}')"; bat --decorations=always --paging=never --color=never --style=numbers '${sq(p)}' 2>/dev/null || cat '${sq(p)}'`
    }

    const result = await ssh(cmd)
    return capOutput(result, args.path)
  },
}

export const find = {
  description: "Find documentation files by name or path pattern.",
  args: {
    pattern: z.string().describe("Glob pattern (e.g. '*.md', '*auth*')"),
    source: z.string().optional().describe("Filter to source (e.g. 'supabase', 'aws')"),
    maxResults: z.number().optional().describe("Max results (default: 30)"),
  },
  async execute(args: { pattern: string; source?: string; maxResults?: number }) {
    const dir = args.source ? safePath(`/docs/${sq(args.source)}/`) : "/docs/"
    const limit = args.maxResults ?? 30
    return ssh(`find '${dir}' -name '${sq(args.pattern)}' -type f | head -${limit}`)
  },
}

export const grep = {
  description:
    "Search documentation content with surrounding context lines using ripgrep. " +
    "Returns structured results with file paths and exact line numbers. " +
    "More detailed than docs_search — shows actual content around matches.",
  args: {
    query: z.string().describe("Regex pattern to search for"),
    path: z.string().describe("File or dir path (e.g. /docs/postgres/)"),
    context: z.number().optional().describe("Context lines per match (default: 3)"),
  },
  async execute(args: { query: string; path: string; context?: number }) {
    const ctx = Math.abs(Math.floor(args.context ?? 3))
    const p = safePath(args.path)

    // Count total matches in parallel with fetching results
    const [jsonResult, countResult] = await Promise.all([
      // Try rg --json first for structured output with exact positions
      ssh(`rg -i --json -C${ctx} '${sq(args.query)}' '${sq(p)}' | head -500`),
      // Total match count (sum across files)
      ssh(`rg -ic '${sq(args.query)}' '${sq(p)}' 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}'`),
    ])
    const total = parseInt(countResult) || 0

    if (jsonResult) {
      const matches = parseRgJson(jsonResult)
      if (matches.length > 0) {
        const formatted = formatRgMatches(matches)
        const countNote = total > matches.length ? ` (showing ${matches.length} of ${total})` : ""
        return capOutput(`${matches.length}${countNote} matches\n\n${formatted}`, args.path)
      }
    }

    // Fallback to plain rg if --json produced no parseable output
    const plainResult = await ssh(
      `rg -in -C${ctx} '${sq(args.query)}' '${sq(p)}' | head -100`
    )
    return capOutput(plainResult, args.path)
  },
}

export const summary = {
  description:
    "Get the structure/outline of a documentation file — headings and section names. " +
    "Use this before docs_read to find the right section to read, saving tokens.",
  args: {
    path: z.string().describe("File path (e.g. /docs/supabase/guides/auth.md)"),
  },
  async execute(args: { path: string }) {
    const p = safePath(args.path)
    // Dispatch both SSH calls concurrently — each is one round-trip,
    // and they're independent. Saves one RTT vs serial execution.
    const [headings, lineCount] = await Promise.all([
      ssh(`rg -n '^#' '${sq(p)}'`),
      ssh(`wc -l < '${sq(p)}'`),
    ])
    return `${lineCount.trim()} lines\n\n${headings}`
  },
}

export const sources = {
  description: "List all available documentation sources and their file counts.",
  args: {
    filter: z.string().optional().describe("Filter source names (e.g. 'postgres', 'supabase')"),
  },
  async execute(args: { filter?: string }) {
    const filterCmd = args.filter ? ` | rg -i '${sq(args.filter)}'` : ""
    // Single find → awk group-by source dir. Previously spawned one
    // find per source (139 subshells on prod) inside a shell for-loop.
    // -mindepth 2 excludes /docs/_index.tsv and other root-level
    // metadata files. Sources with 0 files don't appear in the count
    // map; they're rare in prod but we note the hint anyway.
    return ssh(
      `find /docs -mindepth 2 -type f 2>/dev/null | awk -F/ '{c[$3]++} END{for (d in c) printf "%s: %d files\\n", d, c[d]}' | sort${filterCmd}`,
    )
  },
}

