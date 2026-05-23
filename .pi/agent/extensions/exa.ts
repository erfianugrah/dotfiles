/**
 * exa — websearch + codesearch via mcp.exa.ai HTTP+SSE MCP endpoint.
 *
 * Direct port of the opencode fork's tools/websearch.ts + codesearch.ts +
 * mcp-exa.ts. opencode wraps the public mcp.exa.ai service (which speaks
 * MCP over HTTP+SSE). Anonymous tier works without auth; EXA_API_KEY env
 * unlocks the higher tier.
 *
 * Two tools:
 *
 *   websearch   — fast/auto/deep web search. Returns LLM-optimised content
 *                 strings (not raw HTML). Use as primary external lookup
 *                 path; the research skill (SearXNG) is the fallback.
 *
 *   codesearch  — code examples + library docs lookup. Higher token budget
 *                 default. Use when looking for API patterns, usage
 *                 examples, or specific framework concepts.
 *
 * URL: https://mcp.exa.ai/mcp[?exaApiKey=<key>]
 * Body: JSON-RPC 2.0 tools/call envelope (matches opencode's wrapper).
 * Response: SSE `data:` lines, parse the first `result.content[0].text`.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp";

// SearXNG fallback: when Exa returns empty / errors out, hit the local
// SearXNG instance the research skill exposes. Same approach as
// web-research.ts but only when Exa fails — keeps the primary path
// unchanged.
const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";

async function searxngFallback(query: string, timeoutMs = 12_000): Promise<string | undefined> {
  const params = new URLSearchParams({ q: query, format: "json", safesearch: "0" });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SEARXNG_URL}/search?${params}`, { signal: ctl.signal });
    if (!res.ok) return undefined;
    const j = (await res.json()) as {
      results?: Array<{ title: string; url: string; content: string; engine: string }>;
    };
    const hits = (j.results ?? []).slice(0, 8);
    if (hits.length === 0) return undefined;
    return hits
      .map(
        (r, i) =>
          `${i + 1}. ${r.title} _(via ${r.engine})_\n   ${r.url}\n   ${r.content.slice(0, 240)}`,
      )
      .join("\n\n");
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ── MCP request helper ────────────────────────────────────────────────────

async function exaCall(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Exa HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const body = await res.text();
    // Parse SSE — find first `data:` line, JSON-decode, extract content[0].text
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6)) as {
          result?: { content?: Array<{ type: string; text: string }> };
        };
        const text = parsed.result?.content?.[0]?.text;
        if (text) return text;
      } catch {
        continue;
      }
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ── websearch ─────────────────────────────────────────────────────────────

const websearchTool = defineTool({
  name: "websearch",
  label: "Web Search",
  promptSnippet: "websearch — Exa web search. Quick discovery only.",
  promptGuidelines: [
    "For recommendations / facts / disputed answers, use web_research instead.",
  ],
  description:
    "Exa web search returning LLM-optimised content strings. type: auto|fast|deep. livecrawl: fallback|preferred.",

  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    numResults: Type.Optional(Type.Number({ description: "Number of results (default: 8)" })),
    type: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
        description: "Search type (default: auto)",
      }),
    ),
    livecrawl: Type.Optional(
      Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
        description: "Live crawl mode (default: fallback)",
      }),
    ),
    contextMaxCharacters: Type.Optional(
      Type.Number({ description: "Maximum characters for LLM-optimised context string (default: 10000)" }),
    ),
  }),
  async execute(_id, params) {
    const args: Record<string, unknown> = {
      query: params.query,
      type: params.type ?? "auto",
      numResults: params.numResults ?? 8,
      livecrawl: params.livecrawl ?? "fallback",
    };
    if (params.contextMaxCharacters) args.contextMaxCharacters = params.contextMaxCharacters;

    let text: string | undefined;
    let exaError: string | undefined;
    try {
      text = await exaCall("web_search_exa", args, 25_000);
    } catch (err) {
      exaError = (err as Error).message;
    }

    // Empty or errored Exa response → try SearXNG before giving up. Avoids
    // the reformulation-loop pattern the tool-guard catches (where the agent
    // sees "No results" and rewords the query 3 times).
    if (!text) {
      const searx = await searxngFallback(params.query);
      if (searx) {
        const note = exaError
          ? `Exa failed (${exaError}); SearXNG fallback results:\n\n`
          : "Exa returned no results; SearXNG fallback results:\n\n";
        return {
          content: [{ type: "text", text: note + searx }],
          details: { query: params.query, fallback: "searxng", exaError },
        };
      }
      if (exaError) {
        return {
          isError: true,
          content: [{ type: "text", text: `Exa websearch failed: ${exaError} (SearXNG fallback also returned nothing)` }],
          details: { query: params.query },
        };
      }
      return {
        content: [{ type: "text", text: "No search results found. Try a different query." }],
        details: { query: params.query, type: args.type },
      };
    }

    return {
      content: [{ type: "text", text }],
      details: { query: params.query, type: args.type },
    };
  },
});

// ── codesearch ────────────────────────────────────────────────────────────

const codesearchTool = defineTool({
  name: "codesearch",
  label: "Code Search",
  promptSnippet: "codesearch — Exa code examples + library docs. Use for API usage patterns.",
  promptGuidelines: [],
  description:
    "Code examples + library documentation via Exa. Token budget 1000-50000 (default 5000).",

  parameters: Type.Object({
    query: Type.String({
      description:
        "Code/API/library search query. Be specific about the framework, library, or concept.",
    }),
    tokensNum: Type.Optional(
      Type.Number({
        description: "Tokens to return (1000-50000, default 5000)",
      }),
    ),
  }),
  async execute(_id, params) {
    const tokens = Math.min(Math.max(params.tokensNum ?? 5000, 1000), 50000);
    try {
      const text = await exaCall(
        "get_code_context_exa",
        { query: params.query, tokensNum: tokens },
        30_000,
      );
      return {
        content: [
          {
            type: "text",
            text:
              text ??
              "No code snippets or documentation found. Try a more specific query or check spelling of framework names.",
          },
        ],
        details: { query: params.query, tokens },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Exa codesearch failed: ${(err as Error).message}` }],
        details: { query: params.query },
      };
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(websearchTool);
  pi.registerTool(codesearchTool);
}
