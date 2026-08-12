/**
 * Unit tests for the memledger_search tool's pure core.
 * Run: bun test .pi/agent/extensions/tests/memledger.test.ts
 */

import { describe, expect, test } from "bun:test";
import { buildUrl, formatRows, sanitizeFilter, stripMarks } from "../lib/memledger-core.ts";

describe("buildUrl", () => {
  test("messages with source filter", () => {
    expect(buildUrl("https://m.local", "messages", "hello world", "pi", 10)).toBe(
      "https://m.local/rpc/search_messages?q=hello%20world&lim=10&src=pi",
    );
  });
  test("messages without source omits src param", () => {
    expect(buildUrl("https://m.local", "messages", "x", undefined, 5)).toBe(
      "https://m.local/rpc/search_messages?q=x&lim=5",
    );
  });
  test("ledger", () => {
    expect(buildUrl("https://m.local", "ledger", "zfs", undefined, 20)).toBe(
      "https://m.local/rpc/search_ledger?q=zfs&lim=20",
    );
  });
  test("sessions uses the search_sessions RPC", () => {
    expect(buildUrl("https://m.local", "sessions", "a,b(c)", undefined, 10)).toBe(
      "https://m.local/rpc/search_sessions?q=a%2Cb(c)&lim=10",
    );
  });
  test("sessions passes source through as src", () => {
    expect(buildUrl("https://m.local", "sessions", "x", "pi", 5)).toBe(
      "https://m.local/rpc/search_sessions?q=x&lim=5&src=pi",
    );
  });
});

describe("sanitizeFilter", () => {
  test("removes commas and parens", () => {
    expect(sanitizeFilter("a,(b)")).toBe("a b");
  });
});

describe("stripMarks", () => {
  test("removes ts_headline marks", () => {
    expect(stripMarks("the <b>bridge</b> config")).toBe("the bridge config");
  });
});

describe("formatRows", () => {
  test("sessions render match_kind + hits when present (RPC rows)", () => {
    const lines = formatRows("sessions", [
      { source: "pi", project: "p", started_at: "t", title: "hit", message_count: 3, match_kind: "both", hits: 4 },
    ]);
    expect(lines[0]).toContain("both hits:4");
  });
  test("sessions omit match_kind for plain /sessions rows", () => {
    const lines = formatRows("sessions", [
      { source: "pi", project: "p", started_at: "t", title: "hit", message_count: 3 },
    ]);
    expect(lines[0]).not.toContain("hits:");
  });
  test("messages are one line each with source and headline", () => {
    const lines = formatRows("messages", [
      { source: "pi", session_key: "pi:h:1", ordinal: 3, ts: "2026-08-09", headline: "a <b>hit</b>\nover two lines" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("pi | pi:h:1#3 | 2026-08-09 | a hit over two lines");
  });
  test("long headlines are capped", () => {
    const lines = formatRows("messages", [
      { source: "pi", session_key: "k", ordinal: 0, ts: "t", headline: "x".repeat(500) },
    ]);
    expect(lines[0].length).toBeLessThan(220);
  });
});
