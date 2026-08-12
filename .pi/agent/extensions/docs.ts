// AUTO-GENERATED from docs-ssh: src/commands/tools-pi-template.ts
// Regenerate: ssh -p PORT docs@HOST tools pi > ~/.pi/agent/extensions/docs.ts
//
// Pure logic (arg-building, query tokenisation/ranking, rg --json parsing,
// path validation, output capping) + the SSH orchestrator now live in
// ./lib/docs-core.ts (shared with the Claude Code MCP toolkit). This file is
// the thin pi adapter and re-exports safePath + rankByTokenHits so existing
// importers (tests/extensions.test.ts) keep resolving them here.
// See also: ~/.pi/agent/TOOLKIT.md
import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { runDocs, type DocsParams } from "./lib/docs-core.ts"

export { safePath, rankByTokenHits } from "./lib/docs-core.ts"

function toResult(r: { text: string; details: Record<string, unknown>; isError?: boolean }) {
  return {
    ...(r.isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: r.text }],
    details: r.details,
  }
}

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
    return toResult(await runDocs("search", params as DocsParams))
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
    return toResult(await runDocs("read", params as DocsParams))
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
    return toResult(await runDocs("find", params as DocsParams))
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
    return toResult(await runDocs("grep", params as DocsParams))
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
    return toResult(await runDocs("summary", params as DocsParams))
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
    return toResult(await runDocs("sources", params as DocsParams))
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
