/**
 * memledger_search - query the central memledger store (Postgres + PostgREST
 * on the tailnet) holding EVERY agent client's history: pi, opencode and
 * claude session messages, pi work-ledger entries, pi memories.
 *
 * When to use:
 *   - anything older than the local retention window (local logs get pruned
 *     after 30 days - memledger is the only copy with full-text search)
 *   - cross-client questions ("did I ever solve X in opencode or claude?")
 *   - work-ledger summaries ("what did I do on project Y last month")
 * For recent pi-only sessions the built-in session_search is the fast path.
 *
 * Reads are LAN/tailnet-open by design, so this tool needs no credentials.
 * MEMLEDGER_URL overrides the base URL (default https://memledger.erfi.io).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { baseUrl, buildUrl, formatRows, type SearchKind } from "./lib/memledger-core.ts";

const KINDS: SearchKind[] = ["messages", "ledger", "memories", "sessions", "semantic"];

const memledgerSearchTool = defineTool({
  name: "memledger_search",
  label: "memledger search",
  description:
    "Full-text search across ALL agent session histories (pi/opencode/claude messages, work-ledger summaries, memories) in the central memledger store. Use for anything older than ~30 days (local logs are pruned) or cross-client; prefer session_search for recent pi-only lookups.",
  parameters: Type.Object({
    q: Type.String({ description: "Search query (websearch syntax: words, \"phrases\", OR, -negation)" }),
    source: Type.Optional(
      Type.String({ description: "Filter messages to one client: pi | opencode | claude" }),
    ),
    kind: Type.Optional(
      Type.String({
        description: "What to search: messages (default FTS) | semantic (pgvector similarity) | ledger | memories | sessions",
      }),
    ),
    limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const kind = (KINDS as string[]).includes(params.kind ?? "") ? (params.kind as SearchKind) : "messages";
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    // semantic goes to the embedder service (embeds the query + cosine
    // similarity over pgvector), not a PostgREST RPC.
    if (kind === "semantic") {
      const url = `${baseUrl()}/semantic/search?q=${encodeURIComponent(params.q)}&kind=messages&limit=${limit}`;
      const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }).catch((e) => ({ err: String(e) }));
      if ("err" in resp) {
        return { content: [{ type: "text", text: `memledger semantic unreachable: ${resp.err}` }], details: { url } };
      }
      if (!(resp as Response).ok) {
        return { content: [{ type: "text", text: `memledger semantic HTTP ${(resp as Response).status}` }], details: { url } };
      }
      const data = (await (resp as Response).json()) as { results: { session_key: string; ordinal: number; text: string; similarity: number }[] };
      const lines = data.results.map(
        (r) => `${r.similarity.toFixed(3)} | ${r.session_key}#${r.ordinal} | ${r.text.replace(/\s+/g, " ").slice(0, 200)}`,
      );
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : `no semantic matches for "${params.q}" (backfill may still be running - check /semantic/stats)` }],
        details: { url, count: lines.length },
      };
    }

    const url = buildUrl(baseUrl(), kind as Exclude<SearchKind, "semantic">, params.q, params.source, limit);

    const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).catch(
      (e) => new Error(String(e)) as Error | Response,
    );
    if (resp instanceof Error) {
      return { content: [{ type: "text", text: `memledger unreachable: ${resp.message}` }], details: { url } };
    }
    if (!resp.ok) {
      return {
        content: [{ type: "text", text: `memledger HTTP ${resp.status} for ${kind} search` }],
        details: { url, status: resp.status },
      };
    }
    const rows = (await resp.json()) as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return { content: [{ type: "text", text: `no ${kind} matches for "${params.q}"` }], details: { url, count: 0 } };
    }
    return {
      content: [{ type: "text", text: formatRows(kind, rows).join("\n") }],
      details: { url, count: rows.length, kind },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(memledgerSearchTool);
}
