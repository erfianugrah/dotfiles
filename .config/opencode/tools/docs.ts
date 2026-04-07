import { z } from "zod"

const SSH_HOST = "docs@docs.erfi.io"
const SSH_PORT = "2222"

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
    "Search documentation for Supabase, Cloudflare, Vercel, PostgreSQL, and AWS. " +
    "Returns file paths matching the query. Use this to find relevant docs before reading them. " +
    "Sources: supabase, cloudflare, cloudflare-blog, vercel, vercel-blog, vercel-changelog, postgres, aws.",
  args: {
    query: z.string().describe("Text pattern to search for (grep regex)"),
    source: z
      .string()
      .optional()
      .describe("Limit to a source (e.g. 'supabase', 'cloudflare', 'aws'). Omit to search all."),
    maxResults: z.number().optional().describe("Max results to return (default: 20)"),
  },
  async execute(args: { query: string; source?: string; maxResults?: number }) {
    const dir = args.source ? safePath(`/docs/${sq(args.source)}/`) : "/docs/"
    const limit = args.maxResults ?? 20
    return ssh(`grep -rl '${sq(args.query)}' '${dir}' | head -${limit}`)
  },
}

export const read = {
  description:
    "Read a documentation file from the docs server. " +
    "Pass a path from docs_search results, or construct one like /docs/supabase/guides/auth.md",
  args: {
    path: z.string().describe("File path (e.g. /docs/supabase/guides/auth.md)"),
    lines: z.number().optional().describe("Only read first N lines. Omit for full file."),
  },
  async execute(args: { path: string; lines?: number }) {
    const p = safePath(args.path)
    if (args.lines) {
      return ssh(`head -${Math.abs(Math.floor(args.lines))} '${sq(p)}'`)
    }
    return ssh(`cat '${sq(p)}'`)
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
    "Search documentation with surrounding context lines. " +
    "More detailed than docs_search — shows actual content around matches.",
  args: {
    query: z.string().describe("Text pattern to search for (grep regex)"),
    path: z.string().describe("File or directory to search (e.g. /docs/postgres/)"),
    context: z.number().optional().describe("Context lines around each match (default: 3)"),
  },
  async execute(args: { query: string; path: string; context?: number }) {
    const ctx = Math.abs(Math.floor(args.context ?? 3))
    const p = safePath(args.path)
    return ssh(`grep -A${ctx} '${sq(args.query)}' '${sq(p)}' | head -100`)
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
