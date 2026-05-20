/**
 * context7 — library documentation lookup via context7.com REST API.
 *
 * Replaces the context7 remote MCP (https://mcp.context7.com/mcp/oauth)
 * which Pi can't speak. Two tools:
 *
 *   context7_resolve_library_id — search context7 for a library/package,
 *     returns matching IDs (e.g. "/reactjs/react.dev"), descriptions,
 *     snippet count, reputation, benchmark score.
 *
 *   context7_query_docs — fetch documentation content for a resolved
 *     library ID, optionally narrowed by topic + token budget.
 *
 * REST API: anonymous tier works without auth (rate-limited by IP).
 * Authenticated tier via OAuth not exposed here — anonymous is enough
 * for personal use. If you hit rate limits, add CONTEXT7_API_KEY env
 * and we'll send Authorization: Bearer.
 *
 * Why this is needed even though docs.erfi.io exists: context7 covers
 * fresh code samples from npm packages that aren't in docs.erfi.io.
 * Use docs.erfi.io first for established libs (Postgres, K8s, AWS, etc.);
 * fall back to context7 for newer/niche packages.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://context7.com/api/v1";

function authHeaders(): Record<string, string> {
  const key = process.env.CONTEXT7_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

const resolveLibraryId = defineTool({
  name: "context7_resolve_library_id",
  label: "Context7 Resolve Library ID",
  description: [
    "Resolves a package/product name to a context7-compatible library ID and returns matching libraries.",
    "",
    "Call this BEFORE context7_query_docs to obtain a valid library ID UNLESS the user explicitly provides one in the format `/org/project` or `/org/project/version`.",
    "",
    "Each result includes:",
    "- Library ID: context7-compatible identifier (format: /org/project)",
    "- Title + description: short summary",
    "- Code snippet count + total tokens",
    "- Source reputation (trustScore 0-10)",
    "- Benchmark score (100 is highest quality)",
    "",
    "Selection priority: name similarity → description relevance → snippet coverage → trustScore → benchmarkScore.",
  ].join("\n"),
  parameters: Type.Object({
    libraryName: Type.String({
      description:
        "Library name to search for. Use the official name with proper punctuation — e.g. 'Next.js' not 'nextjs', 'Customer.io' not 'customerio', 'Three.js' not 'threejs'.",
    }),
    query: Type.Optional(
      Type.String({
        description:
          "Optional: the question/task you need help with. Used to rank results by relevance to your goal. Do NOT include sensitive data (API keys, credentials).",
      }),
    ),
  }),

  async execute(_id, params) {
    const url = new URL(`${BASE_URL}/search`);
    url.searchParams.set("query", params.libraryName);
    if (params.query) url.searchParams.set("topic", params.query);
    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        isError: true,
        content: [{ type: "text", text: `context7 HTTP ${res.status}: ${body.slice(0, 200)}` }],
        details: { status: res.status },
      };
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results ?? [];
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No libraries found matching "${params.libraryName}".` }], details: { count: 0 } };
    }
    // Format top 10 with the key fields
    const lines = results.slice(0, 10).map((r) => {
      const id = r.id ?? "(no id)";
      const title = r.title ?? "";
      const desc = (r.description as string | undefined) ?? "";
      const trust = r.trustScore as number | undefined;
      const bench = r.benchmarkScore as number | undefined;
      const snippets = r.totalSnippets as number | undefined;
      const meta: string[] = [];
      if (trust !== undefined) meta.push(`trust:${trust}`);
      if (bench !== undefined) meta.push(`bench:${Math.round(bench)}`);
      if (snippets !== undefined) meta.push(`snippets:${snippets}`);
      return `${id}  ${title}  [${meta.join(" ")}]\n  ${desc.slice(0, 200)}`;
    });
    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
      details: { count: results.length, returned: Math.min(10, results.length) },
    };
  },
});

const queryDocs = defineTool({
  name: "context7_query_docs",
  label: "Context7 Query Docs",
  description: [
    "Retrieves up-to-date documentation + code examples from context7 for a programming library or framework.",
    "",
    "Call context7_resolve_library_id FIRST to obtain the library ID UNLESS the user provided one explicitly.",
    "",
    "Library ID format: `/org/project` or `/org/project/version`",
    "  e.g. `/vercel/next.js`, `/supabase/supabase`, `/reactjs/react.dev`, `/mongodb/docs`",
    "",
    "Token budget defaults to 5000 (balanced). Use lower (1000-2000) for focused queries, higher (10000-50000) for comprehensive overview.",
  ].join("\n"),
  parameters: Type.Object({
    libraryId: Type.String({
      description: "Exact context7-compatible library ID (e.g. '/vercel/next.js' or '/vercel/next.js/v14.3.0-canary.87').",
    }),
    query: Type.Optional(
      Type.String({
        description:
          "Specific question / topic. Be specific. Good: 'How to set up authentication with JWT in Express.js'. Bad: 'auth'.",
      }),
    ),
    tokensNum: Type.Optional(
      Type.Number({
        description: "Token budget (1000-50000, default 5000). Lower = focused, higher = comprehensive.",
      }),
    ),
  }),

  async execute(_id, params) {
    // Library ID may start with `/` — strip if so, the API path needs the bare form
    const libId = params.libraryId.replace(/^\//, "");
    const tokens = Math.min(Math.max(params.tokensNum ?? 5000, 1000), 50000);
    const url = new URL(`${BASE_URL}/${libId}`);
    if (params.query) url.searchParams.set("topic", params.query);
    url.searchParams.set("tokens", String(tokens));

    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        isError: true,
        content: [{ type: "text", text: `context7 HTTP ${res.status} for ${libId}: ${body.slice(0, 300)}` }],
        details: { status: res.status, libraryId: params.libraryId },
      };
    }
    const text = await res.text();
    return {
      content: [{ type: "text", text }],
      details: { libraryId: params.libraryId, tokens, bytes: text.length },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(resolveLibraryId);
  pi.registerTool(queryDocs);
}
