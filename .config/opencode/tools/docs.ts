import { z } from "zod"

const SSH_HOST = "docs@docs.erfi.io"
const SSH_PORT = "2222"
const MAX_RESULT_CHARS = 16_000

function sq(s: string): string {
  return s.replace(/'/g, "'\\''")
}

function safePath(p: string): string {
  const cleaned = p.replace(/\.\./g, "").replace(/\/\//g, "/")
  if (!cleaned.startsWith("/docs/")) {
    return `/docs/${cleaned.replace(/^\/+/, "")}`
  }
  return cleaned
}

function capOutput(text: string, path?: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  const truncated = text.slice(0, MAX_RESULT_CHARS)
  const remaining = text.length - MAX_RESULT_CHARS
  const hint = path
    ? `\n\n[truncated ${remaining} chars — use docs_read with lines parameter or docs_summary to read specific sections of ${path}]`
    : `\n\n[truncated ${remaining} chars — narrow your query or add a line limit]`
  return truncated + hint
}

async function ssh(command: string): Promise<string> {
  const proc = Bun.spawn(
    ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-p", SSH_PORT, SSH_HOST, command],
    { stdout: "pipe", stderr: "pipe" },
  )
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text.trim()
}

export const search = {
  description:
    "Search documentation by title and summary for astro, aws, cloudflare, cloudflare-blog, erfi-personal-blog, erfi-technical-blog, flyio, mcp, nextjs, postgres, rust-book, supabase, supabase-blog, tailwindcss, vercel, vercel-blog, vercel-changelog. " +
    "Searches a pre-built index instead of scanning all files. " +
    "Use this FIRST to find relevant docs, then docs_read or docs_grep to get content.",
  args: {
    query: z.string().describe("Text to search for in titles and summaries"),
    source: z
      .string()
      .optional()
      .describe("Limit to a source (e.g. 'supabase', 'cloudflare', 'aws'). Omit to search all."),
    maxResults: z.number().optional().describe("Max results (default: 15)"),
  },
  async execute(args: { query: string; source?: string; maxResults?: number }) {
    const limit = args.maxResults ?? 15
    const filter = args.source ? `| rg '^${sq(args.source)}/'` : ""
    return ssh(`rg -i '${sq(args.query)}' /docs/_index.tsv ${filter} | head -${limit}`)
  },
}

export const read = {
  description:
    "Read a documentation file. For large files, use docs_summary first to see " +
    "the headings, then read with a line limit to get only the section you need.",
  args: {
    path: z.string().describe("File path (e.g. /docs/supabase/guides/auth.md)"),
    lines: z.number().optional().describe("Only read first N lines. Omit for full file."),
    offset: z.number().optional().describe("Start reading from this line number (1-indexed)."),
  },
  async execute(args: { path: string; lines?: number; offset?: number }) {
    const p = safePath(args.path)
    let cmd: string
    if (args.offset && args.lines) {
      cmd = `sed -n '${Math.max(1, Math.floor(args.offset))},${Math.floor(args.offset) + Math.floor(args.lines) - 1}p' '${sq(p)}'`
    } else if (args.lines) {
      cmd = `head -${Math.abs(Math.floor(args.lines))} '${sq(p)}'`
    } else {
      cmd = `cat '${sq(p)}'`
    }
    const result = await ssh(cmd)
    return capOutput(result, args.path)
  },
}

export const find = {
  description: "Find documentation files by name or path pattern.",
  args: {
    pattern: z.string().describe("File name pattern (e.g. '*.md', '*auth*', '*lambda*')"),
    source: z.string().optional().describe("Limit to a source (e.g. 'supabase', 'aws')"),
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
    "More detailed than docs_search — shows actual content around matches.",
  args: {
    query: z.string().describe("Text pattern to search for (regex)"),
    path: z.string().describe("File or directory to search (e.g. /docs/postgres/)"),
    context: z.number().optional().describe("Context lines around each match (default: 3)"),
  },
  async execute(args: { query: string; path: string; context?: number }) {
    const ctx = Math.abs(Math.floor(args.context ?? 3))
    const p = safePath(args.path)
    const result = await ssh(`rg -i -A${ctx} '${sq(args.query)}' '${sq(p)}' | head -100`)
    return capOutput(result, args.path)
  },
}

export const summary = {
  description:
    "Get the structure/outline of a documentation file — headings and section names. " +
    "Use this before docs_grep to find the right section to read, saving tokens.",
  args: {
    path: z.string().describe("File path (e.g. /docs/supabase/guides/auth.md)"),
  },
  async execute(args: { path: string }) {
    const p = safePath(args.path)
    const headings = await ssh(`rg '^#' '${sq(p)}'`)
    const lineCount = await ssh(`wc -l < '${sq(p)}'`)
    return `${lineCount.trim()} lines\n\n${headings}`
  },
}

export const sources = {
  description: "List all available documentation sources and their file counts.",
  args: {},
  async execute() {
    return ssh(
      `for d in /docs/*/; do name=$(basename "$d"); count=$(find "$d" -type f | wc -l); echo "$name: $count files"; done`,
    )
  },
}
