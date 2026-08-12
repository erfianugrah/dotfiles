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
 * Pure logic (envelope + SSE/SearXNG projection + orchestration) lives in
 * ./lib/exa-core.ts (shared with the Claude Code MCP toolkit); this file is
 * the thin pi adapter.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codesearch, websearch } from "./lib/exa-core.ts";

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
    const { text, details, isError } = await websearch({
      query: params.query,
      numResults: params.numResults,
      type: params.type,
      livecrawl: params.livecrawl,
      contextMaxCharacters: params.contextMaxCharacters,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
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
    const { text, details, isError } = await codesearch({
      query: params.query,
      tokensNum: params.tokensNum,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(websearchTool);
  pi.registerTool(codesearchTool);
}
