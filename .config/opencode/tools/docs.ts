import { tool } from "@opencode-ai/plugin"

const SSH_OPTS = "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
const SSH_HOST = "docs@docs.erfi.io"
const SSH_PORT = "2222"

async function ssh(command: string): Promise<string> {
  const result = await Bun.$`ssh ${SSH_OPTS.split(" ")} -p ${SSH_PORT} ${SSH_HOST} ${command}`.text()
  return result.trim()
}

/**
 * Search documentation across all sources (Supabase, Cloudflare, Vercel, PostgreSQL, AWS)
 * and their blogs/changelogs. Returns matching file paths.
 */
export const search = tool({
  description:
    "Search documentation for Supabase, Cloudflare, Vercel, PostgreSQL, and AWS. " +
    "Returns file paths matching the query. Use this to find relevant docs before reading them. " +
    "Sources: supabase, cloudflare, cloudflare-blog, vercel, vercel-blog, vercel-changelog, postgres, aws.",
  args: {
    query: tool.schema.string().describe("Text pattern to search for (grep regex)"),
    source: tool.schema
      .string()
      .optional()
      .describe(
        "Limit search to a specific source directory (e.g. 'supabase', 'cloudflare', 'aws'). Omit to search all.",
      ),
    maxResults: tool.schema
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 20)"),
  },
  async execute(args) {
    const dir = args.source ? `/docs/${args.source}/` : "/docs/"
    const limit = args.maxResults ?? 20
    return ssh(`grep -rl '${args.query}' ${dir} | head -${limit}`)
  },
})

/**
 * Read a documentation file by path. Returns the full content.
 */
export const read = tool({
  description:
    "Read a documentation file from the docs server. " +
    "Pass a file path from docs_search results, or construct one like /docs/supabase/guides/auth.md",
  args: {
    path: tool.schema.string().describe("File path to read (e.g. /docs/supabase/guides/auth.md)"),
    lines: tool.schema
      .number()
      .optional()
      .describe("Only read the first N lines (for large files). Omit for full file."),
  },
  async execute(args) {
    if (args.lines) {
      return ssh(`head -${args.lines} '${args.path}'`)
    }
    return ssh(`cat '${args.path}'`)
  },
})

/**
 * Find documentation files by name or path pattern.
 */
export const find = tool({
  description:
    "Find documentation files by name or path pattern. " +
    "Useful for discovering what docs exist for a topic.",
  args: {
    pattern: tool.schema.string().describe("File name pattern (e.g. '*.md', '*auth*', '*lambda*')"),
    source: tool.schema
      .string()
      .optional()
      .describe("Limit to a specific source (e.g. 'supabase', 'aws')"),
    maxResults: tool.schema
      .number()
      .optional()
      .describe("Maximum number of results (default: 30)"),
  },
  async execute(args) {
    const dir = args.source ? `/docs/${args.source}/` : "/docs/"
    const limit = args.maxResults ?? 30
    return ssh(`find ${dir} -name '${args.pattern}' -type f | head -${limit}`)
  },
})

/**
 * Search documentation with surrounding context lines.
 */
export const grep = tool({
  description:
    "Search documentation and return matching lines with context. " +
    "More detailed than docs_search — shows the actual content around matches.",
  args: {
    query: tool.schema.string().describe("Text pattern to search for (grep regex)"),
    path: tool.schema.string().describe("File or directory to search in (e.g. /docs/postgres/)"),
    context: tool.schema
      .number()
      .optional()
      .describe("Number of context lines around each match (default: 3)"),
  },
  async execute(args) {
    const ctx = args.context ?? 3
    return ssh(`grep -A${ctx} '${args.query}' '${args.path}' | head -100`)
  },
})

/**
 * List available documentation sources and their file counts.
 */
export const sources = tool({
  description: "List all available documentation sources and their file counts.",
  args: {},
  async execute() {
    return ssh(
      `for d in /docs/*/; do name=$(basename "$d"); count=$(find "$d" -type f | wc -l); echo "$name: $count files"; done`,
    )
  },
})
