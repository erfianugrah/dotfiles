// .pi/agent/tests/memledger-core-search.test.ts
// Regression tests for the self-hit fallback chain in memledger-core.
// The 2026-08-25 incident: a session searched memledger with a multi-term
// query; its OWN echo messages ranked top at shallow depth, dropSelf removed
// them, and the OR-broadened retry ALSO fetched shallow (self-dominated
// again) - so the tool reported "all matches were the current session's own
// messages" while the prior sessions sat in the store below the self-block.
// These tests pin the fix: deep fetch (50) on every fallback leg.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { runSearchMessages, runMemledgerSearch } from "../extensions/lib/memledger-core.ts";

const SELF = "pi:testhost:me";
const OTHER = "pi:testhost:prior-session";

type Row = { session_key: string; ordinal: number; source: string; role: string; ts: string; rank: number; headline: string };

function row(key: string, n: number): Row {
  return { session_key: key, ordinal: n, source: "pi", role: "user", ts: "2026-08-20T00:00:00Z", rank: n, headline: `content ${n}` };
}

let calls: string[] = [];
const realFetch = globalThis.fetch;

// fetch stub: exact-AND query returns N self rows; OR query at depth 50
// returns self rows followed by non-self rows (the prior sessions). Depth
// < 50 on the OR query (the old bug) returns ONLY self rows.
function makeFetch(selfRows: number, otherRows: number) {
  return (input: unknown): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const isOr = url.includes(encodeURIComponent(" OR "));
    const lim = Number(new URL(url).searchParams.get("lim") ?? "10");
    const rows: Row[] = [];
    for (let i = 0; i < selfRows; i++) rows.push(row(SELF, i + 1));
    if (isOr && lim >= 50) {
      for (let i = 0; i < otherRows; i++) rows.push(row(OTHER, i + 1));
    }
    return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
  };
}

describe("runSearchMessages self-hit fallback", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("OR-broadened retry fetches DEEP, escaping the self-hit block", async () => {
    globalThis.fetch = makeFetch(10, 3) as never;
    const out = await runSearchMessages({ q: "subnet router advertise routes tailscale", selfSession: SELF });
    // The fix: the OR retry requested lim=50 and found the prior session.
    expect(out.text).toContain(OTHER);
    expect(out.text).toContain("OR-broadened");
    const orCall = calls.find((c) => c.includes(encodeURIComponent(" OR ")));
    expect(orCall).toBeDefined();
    expect(orCall).toContain("lim=50");
  });

  test("deep retry on the exact query wins before OR when non-self rows exist at depth", async () => {
    // Exact query at depth 50 also surfaces other rows (self block is 3 rows
    // shallow): the deep leg fires, no OR needed.
    const f = (input: unknown): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const lim = Number(new URL(url).searchParams.get("lim") ?? "10");
      const rows: Row[] = [row(SELF, 1), row(SELF, 2)];
      if (lim >= 50) rows.push(row(OTHER, 1), row(OTHER, 2));
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
    };
    globalThis.fetch = f as never;
    const out = await runSearchMessages({ q: "tailscale accept-routes", selfSession: SELF });
    expect(out.text).toContain(OTHER);
    expect(out.text).toContain("deeper matches");
    expect(calls.some((c) => c.includes(encodeURIComponent(" OR ")))).toBe(false);
  });
});

describe("runMemledgerSearch sessions fallback", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sessions: OR retry fires even when the AND matched NOTHING (not just self-only)", async () => {
    // Old bug: OR retry only fired when before > 0 (self rows present). A
    // 5+-term AND matching zero rows never broadened.
    const f = (input: unknown): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      const isOr = url.includes(encodeURIComponent(" OR "));
      const isSessions = url.includes("rpc/search_sessions");
      const rows = isSessions && isOr
        ? [
            { session_key: SELF, source: "pi", project: "infra", started_at: "t", title: "me", message_count: 1, match_kind: "mentions", hits: 5, last_hit: "t" },
            { session_key: OTHER, source: "pi", project: "infra", started_at: "t", title: "Prior Tailscale Work", message_count: 9, match_kind: "mentions", hits: 3, last_hit: "t" },
          ]
        : [];
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
    };
    globalThis.fetch = f as never;
    const out = await runMemledgerSearch({ q: "why is it hijacking the route table", kind: "sessions", selfSession: SELF });
    expect(out.text).toContain("Prior Tailscale Work");
    expect(out.text).toContain("OR-broadened");
    const orCall = calls.find((c) => c.includes(encodeURIComponent(" OR ")));
    expect(orCall).toBeDefined();
    expect(orCall).toContain("lim=50");
  });
});
