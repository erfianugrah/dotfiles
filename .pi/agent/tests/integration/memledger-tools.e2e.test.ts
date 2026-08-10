/**
 * memledger tools END-TO-END: registers the REAL extension through a fake pi
 * runtime and executes every tool with a stubbed global fetch.
 *
 * Regression focus: 2026-08-10 - the five native MCP-parity tools were added
 * with `searchMessages` used but never imported from lib/memledger-core.ts.
 * Bun's transpiler does not flag the missing binding, the unit suite never
 * executed the tool, and it shipped red: `searchMessages is not defined` on
 * the first live call. Executing every registered tool here catches that
 * class at test time.
 *
 * Run: ./.pi/agent/tests/run.sh   (separate bun process from the unit suite)
 */
import { describe, expect, test, mock, beforeEach } from "bun:test";

// NOTE: mock.module() is process-global in Bun and the first stub registered
// for a specifier is what later-loading test files link against. This stub
// must stay a superset of what any extension imports from pi-ai (Type,
// complete, getModel) or session-ledger.e2e fails with "Export named
// 'complete' not found" when this file happens to load first (CI, cb0e7de).
mock.module("@earendil-works/pi-ai", () => ({
  Type: new Proxy({}, { get: () => () => ({}) }),
  complete: async () => ({ content: [{ type: "text", text: "" }] }),
  getModel: () => ({ id: "stub", provider: "stub" }),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  defineTool: (def: unknown) => def,
  getAgentDir: () => "/tmp/pi-memledger-e2e",
}));

const tools = new Map<string, any>();
const pi = {
  on: () => {},
  registerTool: (def: any) => tools.set(def.name, def),
  registerCommand: () => {},
} as never;

const { default: memledger } = await import("../../extensions/memledger.ts");
memledger(pi);

const CANNED: Record<string, unknown> = {
  "rpc/search_messages": [{ session_key: "k", ordinal: 1, source: "pi", role: "user", ts: "t", rank: 1, headline: "hit" }],
  "rpc/search_ledger": [{ project: "p", created_at: "t", summary: "hit" }],
  "memories?": [{ id: "m1", content: "hit" }],
  "sessions?": [{ session_key: "k", source: "pi", project: "p", started_at: "t", title: "hit", message_count: 1 }],
  "semantic/search": { results: [{ session_key: "k", ordinal: 1, id: 1, text: "hit", similarity: 0.9 }] },
};

function fakeFetch(input: unknown): Promise<Response> {
  const url = String(input);
  const key = Object.keys(CANNED).find((k) => url.includes(k));
  if (!key) return Promise.resolve(new Response("[]", { status: 200 }));
  const body = CANNED[key];
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

const CALLS: [string, Record<string, unknown>][] = [
  ["memledger_search", { q: "x" }],
  ["memledger_search", { q: "x", kind: "semantic" }],
  ["search_messages", { q: "x" }],
  ["semantic_search", { q: "x" }],
  ["semantic_search", { q: "x", kind: "ledger_entries" }],
  ["search_ledger", { q: "x" }],
  ["search_memories", { q: "x" }],
  ["list_sessions", { project: "x", source: "pi" }],
];

describe("memledger tools", () => {
  beforeEach(() => {
    globalThis.fetch = fakeFetch as never;
  });

  test("all expected tools register", () => {
    for (const name of ["memledger_search", "search_messages", "semantic_search", "search_ledger", "search_memories", "list_sessions"]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  for (const [name, params] of CALLS) {
    test(`${name} executes and returns text`, async () => {
      const tool = tools.get(name);
      const out = await tool.execute("id", params, new AbortController().signal);
      const text = out?.content?.[0]?.text;
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("is not defined");
      expect(text).not.toContain("unreachable");
    });
  }
});
