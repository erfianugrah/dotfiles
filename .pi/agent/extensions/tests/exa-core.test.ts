/**
 * exa-core unit tests - pure envelope building, SSE/SearXNG projection, arg
 * building, token clamping. No network (mcp.exa.ai / SearXNG live calls are
 * covered elsewhere / marked [blocked: needs network] in the port doc).
 *
 *   bun test extensions/tests/exa-core.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildExaEnvelope,
  buildWebsearchArgs,
  clampTokens,
  exaBaseUrl,
  parseExaSse,
  renderSearxng,
  type SearxHit,
} from "../lib/exa-core.ts";

// A realistic Exa MCP SSE body: an event line + a data line carrying the
// JSON-RPC result whose content[0].text is the LLM-optimised string.
const SSE_BODY = [
  "event: message",
  `data: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: "Rust ownership: each value has a single owner..." }],
    },
  })}`,
  "",
].join("\n");

describe("exa-core.parseExaSse", () => {
  test("extracts result.content[0].text from the data line", () => {
    expect(parseExaSse(SSE_BODY)).toBe("Rust ownership: each value has a single owner...");
  });
  test("returns undefined when no data line has text", () => {
    expect(parseExaSse("event: ping\n\n")).toBeUndefined();
    expect(parseExaSse('data: {"result":{"content":[]}}')).toBeUndefined();
  });
  test("skips malformed data lines and keeps scanning", () => {
    const body = `data: not-json\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } })}`;
    expect(parseExaSse(body)).toBe("ok");
  });
});

describe("exa-core.buildExaEnvelope", () => {
  test("wraps tool + args in a JSON-RPC 2.0 tools/call envelope", () => {
    const env = JSON.parse(buildExaEnvelope("web_search_exa", { query: "x", type: "auto" }));
    expect(env).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: "x", type: "auto" } },
    });
  });
});

describe("exa-core.buildWebsearchArgs", () => {
  test("applies defaults: type=auto, numResults=8, livecrawl=fallback", () => {
    expect(buildWebsearchArgs({ query: "q" })).toEqual({
      query: "q",
      type: "auto",
      numResults: 8,
      livecrawl: "fallback",
    });
  });
  test("passes through overrides and omits contextMaxCharacters when unset", () => {
    const args = buildWebsearchArgs({ query: "q", type: "deep", numResults: 3, livecrawl: "preferred" });
    expect(args.type).toBe("deep");
    expect(args.numResults).toBe(3);
    expect(args.livecrawl).toBe("preferred");
    expect(args.contextMaxCharacters).toBeUndefined();
  });
  test("includes contextMaxCharacters when provided", () => {
    expect(buildWebsearchArgs({ query: "q", contextMaxCharacters: 2000 }).contextMaxCharacters).toBe(2000);
  });
});

describe("exa-core.clampTokens", () => {
  test("default 5000 when unset", () => {
    expect(clampTokens(undefined)).toBe(5000);
  });
  test("clamps below 1000 up and above 50000 down", () => {
    expect(clampTokens(10)).toBe(1000);
    expect(clampTokens(999999)).toBe(50000);
  });
  test("passes valid values through", () => {
    expect(clampTokens(12000)).toBe(12000);
  });
});

describe("exa-core.renderSearxng", () => {
  const hits: SearxHit[] = [
    { title: "First", url: "https://a.example/1", content: "alpha body", engine: "duckduckgo" },
    { title: "Second", url: "https://b.example/2", content: "beta body", engine: "brave" },
  ];
  test("renders a numbered block with title, engine, url, snippet", () => {
    const out = renderSearxng(hits)!;
    expect(out).toContain("1. First _(via duckduckgo)_");
    expect(out).toContain("https://a.example/1");
    expect(out).toContain("alpha body");
    expect(out).toContain("2. Second _(via brave)_");
  });
  test("caps at 8 hits", () => {
    const many: SearxHit[] = Array.from({ length: 20 }, (_, i) => ({
      title: `t${i}`,
      url: `https://x.example/${i}`,
      content: "c",
      engine: "e",
    }));
    const out = renderSearxng(many)!;
    expect(out).toContain("8. t7");
    expect(out).not.toContain("9. t8");
  });
  test("undefined / empty -> undefined", () => {
    expect(renderSearxng(undefined)).toBeUndefined();
    expect(renderSearxng([])).toBeUndefined();
  });
});

describe("exa-core.exaBaseUrl", () => {
  const orig = process.env.EXA_API_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = orig;
  });
  test("anonymous endpoint without a key", () => {
    delete process.env.EXA_API_KEY;
    expect(exaBaseUrl()).toBe("https://mcp.exa.ai/mcp");
  });
  test("appends url-encoded key when present", () => {
    process.env.EXA_API_KEY = "a b/c";
    expect(exaBaseUrl()).toBe("https://mcp.exa.ai/mcp?exaApiKey=a%20b%2Fc");
  });
});
