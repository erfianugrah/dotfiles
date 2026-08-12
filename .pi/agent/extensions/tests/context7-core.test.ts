/**
 * context7-core unit tests - pure URL-building, search-result projection,
 * token clamping, rendering, and the fetch orchestrators against an injected
 * fake fetch (no network). The live REST calls are marked
 * [blocked: needs network] in the port doc.
 *
 *   bun test extensions/tests/context7-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  authHeaders,
  buildDocsUrl,
  buildSearchUrl,
  clampTokens,
  normalizeLibraryId,
  parseSearchResults,
  queryDocs,
  renderSearchResults,
  resolveLibraryId,
} from "../lib/context7-core.ts";

const SEARCH_FIXTURE = JSON.stringify({
  results: [
    {
      id: "/vercel/next.js",
      title: "Next.js",
      description: "The React Framework for the Web",
      trustScore: 10,
      benchmarkScore: 92.4,
      totalSnippets: 3120,
    },
    {
      id: "/reactjs/react.dev",
      title: "React",
      description: "React docs",
      // missing scores -> null
    },
  ],
});

// Minimal fake Response covering the fields the core touches.
function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("context7-core.buildSearchUrl", () => {
  test("sets query param", () => {
    expect(buildSearchUrl("Next.js")).toBe("https://context7.com/api/v1/search?query=Next.js");
  });
  test("adds topic when query given", () => {
    const u = new URL(buildSearchUrl("Next.js", "routing"));
    expect(u.searchParams.get("query")).toBe("Next.js");
    expect(u.searchParams.get("topic")).toBe("routing");
  });
});

describe("context7-core.normalizeLibraryId / clampTokens", () => {
  test("strips a single leading slash", () => {
    expect(normalizeLibraryId("/vercel/next.js")).toBe("vercel/next.js");
    expect(normalizeLibraryId("vercel/next.js")).toBe("vercel/next.js");
  });
  test("clamps token budget into [1000, 50000]", () => {
    expect(clampTokens(undefined)).toBe(5000);
    expect(clampTokens(500)).toBe(1000);
    expect(clampTokens(999999)).toBe(50000);
    expect(clampTokens(12000)).toBe(12000);
  });
});

describe("context7-core.buildDocsUrl", () => {
  test("strips leading slash, sets topic + clamped tokens", () => {
    const u = new URL(buildDocsUrl("/vercel/next.js", "auth", 999999));
    expect(u.pathname).toBe("/api/v1/vercel/next.js");
    expect(u.searchParams.get("topic")).toBe("auth");
    expect(u.searchParams.get("tokens")).toBe("50000");
  });
  test("defaults tokens to 5000 with no query", () => {
    const u = new URL(buildDocsUrl("vercel/next.js"));
    expect(u.searchParams.get("topic")).toBeNull();
    expect(u.searchParams.get("tokens")).toBe("5000");
  });
});

describe("context7-core.authHeaders", () => {
  test("empty when no key", () => {
    expect(authHeaders({})).toEqual({});
  });
  test("bearer when key present", () => {
    expect(authHeaders({ CONTEXT7_API_KEY: "sk-xyz" })).toEqual({ authorization: "Bearer sk-xyz" });
  });
});

describe("context7-core.parseSearchResults", () => {
  test("projects results and coerces missing numeric fields to null", () => {
    const m = parseSearchResults(SEARCH_FIXTURE);
    expect(m.length).toBe(2);
    expect(m[0].id).toBe("/vercel/next.js");
    expect(m[0].trustScore).toBe(10);
    expect(m[0].benchmarkScore).toBe(92.4);
    expect(m[0].totalSnippets).toBe(3120);
    expect(m[1].trustScore).toBeNull();
    expect(m[1].benchmarkScore).toBeNull();
  });
  test("caps at limit", () => {
    expect(parseSearchResults(SEARCH_FIXTURE, 1).length).toBe(1);
  });
  test("malformed / empty -> []", () => {
    expect(parseSearchResults("not json")).toEqual([]);
    expect(parseSearchResults("{}")).toEqual([]);
    expect(parseSearchResults('{"results":[]}')).toEqual([]);
  });
});

describe("context7-core.renderSearchResults", () => {
  test("renders id, title, meta, and truncated description", () => {
    const text = renderSearchResults(parseSearchResults(SEARCH_FIXTURE));
    expect(text).toContain("/vercel/next.js  Next.js  [trust:10 bench:92 snippets:3120]");
    expect(text).toContain("The React Framework for the Web");
    // second entry has no meta values
    expect(text).toContain("/reactjs/react.dev  React  []");
  });
});

describe("context7-core.resolveLibraryId (orchestrator, injected fetch)", () => {
  test("happy path renders matches", async () => {
    let calledUrl = "";
    const r = await resolveLibraryId({
      libraryName: "Next.js",
      query: "routing",
      fetchImpl: (async (url: string) => {
        calledUrl = url;
        return fakeResponse(SEARCH_FIXTURE);
      }) as unknown as typeof fetch,
      env: {},
    });
    expect(calledUrl).toContain("topic=routing");
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("/vercel/next.js");
    expect(r.details.count).toBe(2);
  });
  test("no matches -> friendly message", async () => {
    const r = await resolveLibraryId({
      libraryName: "zzznope",
      fetchImpl: (async () => fakeResponse('{"results":[]}')) as unknown as typeof fetch,
      env: {},
    });
    expect(r.text).toContain('No libraries found matching "zzznope"');
    expect(r.details.count).toBe(0);
  });
  test("HTTP error -> isError with status", async () => {
    const r = await resolveLibraryId({
      libraryName: "x",
      fetchImpl: (async () => fakeResponse("rate limited", false, 429)) as unknown as typeof fetch,
      env: {},
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("context7 HTTP 429");
    expect(r.details.status).toBe(429);
  });
});

describe("context7-core.queryDocs (orchestrator, injected fetch)", () => {
  test("returns raw docs text + byte count, hits clamped URL", async () => {
    let calledUrl = "";
    const DOCS = "# Next.js routing\n\nUse the app router...";
    const r = await queryDocs({
      libraryId: "/vercel/next.js",
      query: "routing",
      tokensNum: 2000,
      fetchImpl: (async (url: string) => {
        calledUrl = url;
        return fakeResponse(DOCS);
      }) as unknown as typeof fetch,
      env: {},
    });
    expect(calledUrl).toContain("/api/v1/vercel/next.js");
    expect(calledUrl).toContain("tokens=2000");
    expect(r.text).toBe(DOCS);
    expect(r.details.bytes).toBe(DOCS.length);
    expect(r.details.tokens).toBe(2000);
  });
  test("HTTP error includes bare lib id", async () => {
    const r = await queryDocs({
      libraryId: "/nope/nope",
      fetchImpl: (async () => fakeResponse("not found", false, 404)) as unknown as typeof fetch,
      env: {},
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("context7 HTTP 404 for nope/nope");
    expect(r.details.status).toBe(404);
  });
});
