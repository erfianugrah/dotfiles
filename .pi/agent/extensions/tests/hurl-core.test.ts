/**
 * hurl-core unit tests - pure JSON projection + rendering + var normalisation.
 * No hurl binary needed (live run [blocked: needs binary]).
 *
 *   bun test extensions/tests/hurl-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { normalizeVars, parseHurlJson, renderHurl } from "../lib/hurl-core.ts";

const PASS = JSON.stringify({
  success: true,
  entries: [
    {
      index: 1,
      calls: [{ request: { method: "GET", url: "https://x/health" }, response: { status: 200 } }],
      time: 12,
      asserts: [{ success: true }],
    },
  ],
});

const FAIL = JSON.stringify({
  success: false,
  entries: [
    {
      index: 1,
      calls: [{ request: { method: "GET", url: "https://x/users/1" }, response: { status: 500 } }],
      time: 34,
      curl_cmd: "curl https://x/users/1",
      asserts: [{ success: false, predicate: { kind: "equal" }, message: "status expected 200, got 500" }],
    },
  ],
});

describe("hurl-core.parseHurlJson", () => {
  test("passing entry: success true, status 200, no failed asserts", () => {
    const { entries, allSuccess } = parseHurlJson(PASS);
    expect(allSuccess).toBe(true);
    expect(entries.length).toBe(1);
    expect(entries[0].success).toBe(true);
    expect(entries[0].status).toBe(200);
    expect(entries[0].method).toBe("GET");
  });
  test("failing entry: captures failed assert + curl", () => {
    const { entries, allSuccess } = parseHurlJson(FAIL);
    expect(allSuccess).toBe(false);
    expect(entries[0].success).toBe(false);
    expect(entries[0].status).toBe(500);
    expect(entries[0].failedAsserts[0].kind).toBe("equal");
    expect(entries[0].failedAsserts[0].message).toContain("got 500");
    expect(entries[0].curlCmd).toBe("curl https://x/users/1");
  });
  test("accepts an array of runs", () => {
    const { entries } = parseHurlJson(`[${PASS},${FAIL}]`);
    expect(entries.length).toBe(2);
  });
  test("malformed -> empty, not success", () => {
    expect(parseHurlJson("nope")).toEqual({ entries: [], allSuccess: false });
  });
});

describe("hurl-core.renderHurl", () => {
  test("all pass -> one-line summary, not an error", () => {
    const { entries, allSuccess } = parseHurlJson(PASS);
    const r = renderHurl(entries, allSuccess, "/t/a.hurl");
    expect(r.isError).toBe(false);
    expect(r.text).toBe("1/1 entries passed (12 ms total)");
  });
  test("failure -> error + per-entry breakdown", () => {
    const { entries, allSuccess } = parseHurlJson(FAIL);
    const r = renderHurl(entries, allSuccess, "/t/a.hurl");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("0/1 passed, 1 failed");
    expect(r.text).toContain("[1] GET https://x/users/1 -> 500");
    expect(r.text).toContain("equal: status expected 200, got 500");
  });
  test("no entries -> not an error", () => {
    expect(renderHurl([], true, "/t/a.hurl").isError).toBe(false);
  });
});

describe("hurl-core.normalizeVars", () => {
  test("keeps scalars as strings, drops objects/arrays/null", () => {
    expect(normalizeVars({ a: "x", b: 3, c: true, d: { nested: 1 }, e: [1], f: null })).toEqual({
      a: "x",
      b: "3",
      c: "true",
    });
  });
  test("non-object -> {}", () => {
    expect(normalizeVars(undefined)).toEqual({});
    expect(normalizeVars("nope")).toEqual({});
  });
});
