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
 *
 * All HTTP/orchestration lives in lib/memledger-core.ts so pi and Claude Code
 * (via .claude/mcp/toolkit.ts) run identical logic. This file is a thin pi
 * adapter that maps the core's { text, details } to the pi tool-result shape.
 */

import { hostname } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  runListSessions,
  runMemledgerSearch,
  runSearchLedger,
  runSearchMemories,
  runSearchMessages,
  runSemanticSearch,
  type MemledgerResult,
} from "./lib/memledger-core.ts";

// re-export the pure helpers the pi test-suite imports from the adapter's core
export { baseUrl, buildUrl, formatRows, searchMessages, type SearchKind } from "./lib/memledger-core.ts";

function toPiResult(r: MemledgerResult) {
  return { content: [{ type: "text" as const, text: r.text }], details: r.details };
}

/**
 * The caller's own memledger session key ("pi:HOST:UUID" - same shape the
 * ingester builds). Passed to the core runners so this session's own
 * messages are excluded from results: a session searching history ranks
 * its own synthesis/echo of the query vocabulary highest, which drowned out
 * the original sources (2026-08-23). Returns undefined when the session id
 * can't be resolved (ephemeral sessions, non-pi harnesses) - filtering then
 * no-ops and behaviour is unchanged.
 */
function selfSessionKey(ctx: unknown): string | undefined {
  try {
    const id = (
      ctx as { sessionManager?: { getSessionId?: () => string | undefined } } | undefined
    )?.sessionManager?.getSessionId?.();
    return id ? `pi:${hostname()}:${id}` : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "memledger_search",
      label: "memledger search",
      description:
        "Full-text search across ALL agent session histories (pi/opencode/claude messages, work-ledger summaries, memories) in the central memledger store. Use for anything older than ~30 days (local logs are pruned) or cross-client; prefer session_search for recent pi-only lookups.",
      parameters: Type.Object({
        q: Type.String({ description: "Search query (websearch syntax: words, \"phrases\", OR, -negation)" }),
        source: Type.Optional(Type.String({ description: "Filter messages to one client: pi | opencode | claude" })),
        kind: Type.Optional(
          Type.String({
            description: "What to search: messages (default FTS) | semantic (pgvector similarity) | ledger | memories | sessions (topic search over sessions: attributed title/project/cwd matches + message-content mentions, with match_kind provenance and hit counts - the answer to 'which sessions touched X')",
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        return toPiResult(await runMemledgerSearch({ ...params, selfSession: selfSessionKey(ctx) }, signal));
      },
    }),
  );

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
      async execute(_id, params, signal, _onUpdate, ctx) {
        return toPiResult(await runSearchMessages({ ...params, selfSession: selfSessionKey(ctx) }, signal));
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
        kind: Type.Optional(Type.String({ description: "messages (default) | memories | ledger_entries" })),
        source: Type.Optional(Type.String({ description: "Filter messages to one client: pi | opencode | claude" })),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        return toPiResult(await runSemanticSearch({ ...params, selfSession: selfSessionKey(ctx) }, signal));
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
        return toPiResult(await runSearchLedger(params, signal));
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
        return toPiResult(await runSearchMemories(params, signal));
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "list_sessions",
      label: "memledger sessions",
      description: "List recent sessions, optionally filtered by project basename and/or client (pi|opencode|claude). NOTE: project is the basename of the session's STARTUP cwd, frozen at session start - sessions that worked on a project from a different cwd are invisible here. For 'sessions about X' use memledger_search with kind=sessions (also searches message content).",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "Project basename filter (ilike)" })),
        source: Type.Optional(Type.String({ description: "pi | opencode | claude" })),
        limit: Type.Optional(Type.Number({ description: "Max rows (default 10, max 50)" })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        return toPiResult(await runListSessions({ ...params, selfSession: selfSessionKey(ctx) }, signal));
      },
    }),
  );
}
