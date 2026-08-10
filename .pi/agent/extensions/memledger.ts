/**
 * memledger tools - query the central memledger store (Postgres + PostgREST
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
 * Reads are LAN/tailnet-open by design, so these tools need no credentials.
 * MEMLEDGER_URL overrides the base URL (default https://memledger.erfi.io).
 *
 * search_messages / semantic_search / search_ledger / search_memories /
 * list_sessions are the NATIVE replacements for the memledger MCP server
 * entries (2026-08-10): identical names, zero discovery cost, and no bearer
 * token sitting in an mcp-remote process's argv. memledger_search remains as
 * the combined one-call variant.
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
      const srcParam = params.source ? `&source=${encodeURIComponent(params.source)}` : "";
      const url = `${baseUrl()}/semantic/search?q=${encodeURIComponent(params.q)}&kind=messages&limit=${limit}${srcParam}`;
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

  // ── MCP-parity native tools (previously via pi-mcp-bridge + mcp-remote) ──

  pi.registerTool(
    defineTool({
      name: "search_messages",
      label: "memledger messages",
      description:
        "Full-text search across ALL agent session messages (pi/opencode/claude). Websearch syntax: phrases, OR, -negation.",
      parameters: Type.Object({
        q: Type.String({ description: "Search query" }),
        source: Type.Optional(Type.String({ description: "pi | opencode | claude" })),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal) {
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
        try {
          const rows = await searchMessages(params.q, params.source, limit, signal);
          const lines = rows.map(
            (r) => `${r.source} | ${r.session_key}#${r.ordinal} | ${r.ts ?? "?"} | ${r.headline.replace(/\s+/g, " ").slice(0, 160)}`,
          );
          return {
            content: [{ type: "text", text: lines.length ? lines.join("\n") : `no message matches for "${params.q}"` }],
            details: { count: lines.length },
          };
        } catch (e) {
          return { content: [{ type: "text", text: `memledger unreachable: ${e}` }] };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "semantic_search",
      label: "memledger semantic",
      description:
        "Semantic (pgvector) similarity search over messages, memories, or ledger_entries. Use for concepts, not exact strings.",
      parameters: Type.Object({
        q: Type.String({ description: "Concept query" }),
        kind: Type.Optional(
          Type.String({ description: "messages (default) | memories | ledger_entries" }),
        ),
        source: Type.Optional(Type.String({ description: "Filter messages to one client: pi | opencode | claude" })),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal) {
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
        const kind = ["messages", "memories", "ledger_entries"].includes(params.kind ?? "")
          ? params.kind!
          : "messages";
        const srcParam = params.source ? `&source=${encodeURIComponent(params.source)}` : "";
        const url = `${baseUrl()}/semantic/search?q=${encodeURIComponent(params.q)}&kind=${kind}&limit=${limit}${srcParam}`;
        const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }).catch(
          (e) => ({ err: String(e) }),
        );
        if ("err" in resp) return { content: [{ type: "text", text: `memledger semantic unreachable: ${resp.err}` }] };
        if (!(resp as Response).ok)
          return { content: [{ type: "text", text: `memledger semantic HTTP ${(resp as Response).status}` }] };
        const data = (await (resp as Response).json()) as {
          results: { session_key?: string; ordinal?: number; id?: number; text: string; similarity: number }[];
        };
        const lines = data.results.map((r) => {
          const where = kind === "messages" ? `${r.session_key}#${r.ordinal}` : `#${r.id}`;
          return `${r.similarity.toFixed(3)} | ${where} | ${r.text.replace(/\s+/g, " ").slice(0, 200)}`;
        });
        return {
          content: [
            {
              type: "text",
              text: lines.length
                ? lines.join("\n")
                : `no semantic matches for "${params.q}" (backfill may still be running - check /semantic/stats)`,
            },
          ],
          details: { count: lines.length, kind },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "search_ledger",
      label: "memledger ledger",
      description: "Search work-ledger summaries (what was done in past sessions, by project).",
      parameters: Type.Object({
        q: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal) {
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
        const url = buildUrl(baseUrl(), "ledger", params.q, undefined, limit);
        const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).catch(
          (e) => ({ err: String(e) }),
        );
        if ("err" in resp) return { content: [{ type: "text", text: `memledger unreachable: ${resp.err}` }] };
        const rows = (await (resp as Response).json()) as Record<string, unknown>[];
        const lines = Array.isArray(rows) ? formatRows("ledger", rows) : [];
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : `no ledger matches for "${params.q}"` }],
          details: { count: lines.length },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "search_memories",
      label: "memledger memories",
      description: "Search persistent agent memories.",
      parameters: Type.Object({
        q: Type.String({ description: "Search query" }),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal) {
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
        const url = buildUrl(baseUrl(), "memories", params.q, undefined, limit);
        const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).catch(
          (e) => ({ err: String(e) }),
        );
        if ("err" in resp) return { content: [{ type: "text", text: `memledger unreachable: ${resp.err}` }] };
        const rows = (await (resp as Response).json()) as Record<string, unknown>[];
        const lines = Array.isArray(rows) ? formatRows("memories", rows) : [];
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : `no memory matches for "${params.q}"` }],
          details: { count: lines.length },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "list_sessions",
      label: "memledger sessions",
      description: "List recent sessions, optionally filtered by project basename and/or client (pi|opencode|claude).",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "Project basename filter (ilike)" })),
        source: Type.Optional(Type.String({ description: "pi | opencode | claude" })),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal) {
        const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
        let url =
          `${baseUrl()}/sessions?select=session_key,source,project,title,started_at,message_count` +
          `&order=started_at.desc.nullslast&limit=${limit}`;
        if (params.project) url += `&project=ilike.*${encodeURIComponent(params.project)}*`;
        if (params.source) url += `&source=eq.${encodeURIComponent(params.source)}`;
        const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }).catch(
          (e) => ({ err: String(e) }),
        );
        if ("err" in resp) return { content: [{ type: "text", text: `memledger unreachable: ${resp.err}` }] };
        const rows = (await (resp as Response).json()) as Record<string, unknown>[];
        const lines = Array.isArray(rows) ? formatRows("sessions", rows) : [];
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "no sessions found" }],
          details: { count: lines.length },
        };
      },
    }),
  );
}
