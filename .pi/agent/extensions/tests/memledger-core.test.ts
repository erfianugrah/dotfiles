/**
 * Unit tests for memledger-core's URL builders + harness-agnostic
 * orchestrators. No network: global fetch is stubbed with realistic PostgREST
 * / embedder fixtures. Run:
 *   bun test .pi/agent/extensions/tests/memledger-core.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildListSessionsUrl,
  buildSemanticUrl,
  clampLimit,
  formatSemanticRows,
  runListSessions,
  runMemledgerSearch,
  runSearchLedger,
  runSearchMemories,
  runSearchMessages,
  runSemanticSearch,
} from "../lib/memledger-core.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Route by URL substring to a canned JSON body, capturing the last URL hit. */
let lastUrl = "";
function stubFetch(routes: Record<string, unknown>, status = 200) {
  globalThis.fetch = ((input: unknown) => {
    lastUrl = String(input);
    const key = Object.keys(routes).find((k) => lastUrl.includes(k));
    const body = key ? routes[key] : [];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as never;
}

// -- pure URL builders -------------------------------------------------------

describe("buildSemanticUrl", () => {
  test("messages kind with source", () => {
    expect(buildSemanticUrl("https://m.local", "zfs pool", "messages", "claude", 5)).toBe(
      "https://m.local/semantic/search?q=zfs%20pool&kind=messages&limit=5&source=claude",
    );
  });
  test("ledger_entries kind omits source", () => {
    expect(buildSemanticUrl("https://m.local", "x", "ledger_entries", undefined, 10)).toBe(
      "https://m.local/semantic/search?q=x&kind=ledger_entries&limit=10",
    );
  });
});

describe("buildListSessionsUrl", () => {
  test("no filters selects the base columns", () => {
    const url = buildListSessionsUrl("https://m.local", undefined, undefined, 10);
    expect(url).toContain("/sessions?select=session_key,source,project,title,started_at,message_count");
    expect(url).toContain("order=started_at.desc.nullslast&limit=10");
    expect(url).not.toContain("ilike");
    expect(url).not.toContain("eq.");
  });
  test("project + source filters appended", () => {
    const url = buildListSessionsUrl("https://m.local", "dotfiles", "pi", 7);
    expect(url).toContain("&project=ilike.*dotfiles*");
    expect(url).toContain("&source=eq.pi");
    expect(url).toContain("limit=7");
  });
});

describe("clampLimit", () => {
  test("defaults and bounds", () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(999)).toBe(50);
    expect(clampLimit(25)).toBe(25);
  });
});

describe("formatSemanticRows", () => {
  test("messages show session_key#ordinal", () => {
    const lines = formatSemanticRows("messages", [
      { session_key: "pi:h:9", ordinal: 4, text: "the  bridge\nconfig", similarity: 0.8123 },
    ]);
    expect(lines[0]).toBe("0.812 | pi:h:9#4 | the bridge config");
  });
  test("non-message kinds show #id", () => {
    const lines = formatSemanticRows("memories", [{ id: 42, text: "hi", similarity: 0.5 }]);
    expect(lines[0]).toBe("0.500 | #42 | hi");
  });
});

// -- orchestrators (stubbed fetch) -------------------------------------------

describe("runSearchMessages", () => {
  test("formats rows and hits the rpc endpoint", async () => {
    stubFetch({
      "rpc/search_messages": [
        { session_key: "k", ordinal: 1, source: "pi", role: "user", ts: "2026-08-09", rank: 1, headline: "a <b>hit</b>" },
      ],
    });
    const r = await runSearchMessages({ q: "hit", source: "pi", limit: 5 });
    expect(r.isError).toBeUndefined();
    expect(lastUrl).toContain("/rpc/search_messages?q=hit&lim=5&src=pi");
    expect(r.text).toBe("pi | k#1 | 2026-08-09 | a hit");
    expect(r.details.count).toBe(1);
  });
  test("empty result gives a no-match message", async () => {
    stubFetch({ "rpc/search_messages": [] });
    const r = await runSearchMessages({ q: "nope" });
    expect(r.text).toBe('no message matches for "nope"');
  });
  test("network failure is a soft error", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as never;
    const r = await runSearchMessages({ q: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("memledger unreachable");
  });
});

describe("runSemanticSearch", () => {
  test("defaults to messages kind and formats similarity rows", async () => {
    stubFetch({ "semantic/search": { results: [{ session_key: "k", ordinal: 2, text: "hi", similarity: 0.91 }] } });
    const r = await runSemanticSearch({ q: "concept" });
    expect(lastUrl).toContain("kind=messages");
    expect(r.text).toBe("0.910 | k#2 | hi");
  });
  test("invalid kind falls back to messages", async () => {
    stubFetch({ "semantic/search": { results: [] } });
    await runSemanticSearch({ q: "x", kind: "bogus" });
    expect(lastUrl).toContain("kind=messages");
  });
  test("ledger_entries kind routed through", async () => {
    stubFetch({ "semantic/search": { results: [{ id: 3, text: "y", similarity: 0.4 }] } });
    const r = await runSemanticSearch({ q: "x", kind: "ledger_entries" });
    expect(lastUrl).toContain("kind=ledger_entries");
    expect(r.text).toBe("0.400 | #3 | y");
  });
  test("HTTP error surfaces the status", async () => {
    stubFetch({ "semantic/search": {} }, 503);
    const r = await runSemanticSearch({ q: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("memledger semantic HTTP 503");
  });
});

describe("runSearchLedger / runSearchMemories / runListSessions", () => {
  test("ledger formats project | date | summary", async () => {
    stubFetch({ "rpc/search_ledger": [{ project: "p", created_at: "2026-08-01", summary: "did a thing" }] });
    const r = await runSearchLedger({ q: "thing" });
    expect(lastUrl).toContain("/rpc/search_ledger?q=thing");
    expect(r.text).toBe("p | 2026-08-01 | did a thing");
  });
  test("memories format id | content", async () => {
    stubFetch({ "/memories?": [{ id: "m1", content: "remember me" }] });
    const r = await runSearchMemories({ q: "me" });
    expect(lastUrl).toContain("/memories?content=ilike.");
    expect(r.text).toBe("m1 | remember me");
  });
  test("list_sessions formats and applies filters", async () => {
    stubFetch({
      "/sessions?": [
        { session_key: "k", source: "pi", project: "dotfiles", started_at: "2026-08-10", title: "t", message_count: 3 },
      ],
    });
    const r = await runListSessions({ project: "dotfiles", source: "pi" });
    expect(lastUrl).toContain("project=ilike.*dotfiles*");
    expect(r.text).toBe("pi | dotfiles | 2026-08-10 | t | msgs:3");
  });
  test("empty sessions gives a friendly message", async () => {
    stubFetch({ "/sessions?": [] });
    const r = await runListSessions({});
    expect(r.text).toBe("no sessions found");
  });
});

describe("runMemledgerSearch (combined)", () => {
  test("default messages kind", async () => {
    stubFetch({ "rpc/search_messages": [{ source: "pi", session_key: "k", ordinal: 1, ts: "t", headline: "h" }] });
    const r = await runMemledgerSearch({ q: "x" });
    expect(r.details.kind).toBe("messages");
    expect(r.text).toBe("pi | k#1 | t | h");
  });
  test("semantic kind routes to the embedder", async () => {
    stubFetch({ "semantic/search": { results: [{ session_key: "k", ordinal: 1, text: "s", similarity: 0.7 }] } });
    const r = await runMemledgerSearch({ q: "x", kind: "semantic" });
    expect(lastUrl).toContain("/semantic/search");
    expect(r.text).toBe("0.700 | k#1 | s");
  });
  test("no rows yields no-match with kind in details", async () => {
    stubFetch({ "rpc/search_ledger": [] });
    const r = await runMemledgerSearch({ q: "x", kind: "ledger" });
    expect(r.text).toBe('no ledger matches for "x"');
    expect(r.details.kind).toBe("ledger");
  });
  test("HTTP error names the kind", async () => {
    stubFetch({ "rpc/search_messages": [] }, 500);
    const r = await runMemledgerSearch({ q: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("memledger HTTP 500 for messages search");
  });
});
