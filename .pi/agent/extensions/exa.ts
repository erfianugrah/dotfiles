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
  description: [
    "Search the web via Exa AI — fast, deep, and LLM-optimised. Returns content strings (not raw HTML) ready for the model to read directly.",
    "",
    "Use this as the PRIMARY external lookup path. Prefer this over `bash curl <search-engine>`. The `research` skill (SearXNG) is the fallback when Exa is rate-limited or down.",
    "",
    "Search types:",
    "- `auto` (default): balanced, picks fast/deep heuristically",
    "- `fast`: quick results, 5-10s",
    "- `deep`: comprehensive, can take 30+ seconds",
    "",
    "Live-crawl modes:",
    "- `fallback` (default): use cached content; live-crawl only as backup",
    "- `preferred`: live-crawl every result (slower, freshest)",
  ].join("\n"),
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

    try {
      const text = await exaCall("web_search_exa", args, 25_000);
      return {
        content: [{ type: "text", text: text ?? "No search results found. Try a different query." }],
        details: { query: params.query, type: args.type },
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Exa websearch failed: ${(err as Error).message}` }],
        details: { query: params.query },
      };
    }
  },
});

// ── codesearch ────────────────────────────────────────────────────────────

const codesearchTool = defineTool({
  name: "codesearch",
  label: "Code Search",
  description: [
    "Find code examples + documentation via Exa AI. Best for API/library/SDK usage patterns and specific framework concepts.",
    "",
    "Examples of good queries:",
    "- 'React useState hook examples'",
    "- 'Python pandas dataframe filtering'",
    "- 'Express.js middleware ordering'",
    "- 'Next.js partial prerendering configuration'",
    "",
    "Token budget defaults to 5000 (balanced). Use 1000-2000 for focused queries, 10000-50000 for comprehensive overview.",
  ].join("\n"),
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
