/**
 * docs-core unit tests - pure command-building, query tokenisation/ranking,
 * path validation, rg --json parsing, output capping, and the SSH orchestrator
 * exercised with a stubbed ssh runner (no network / no docs.erfi.io reachable).
 *
 *   bun test extensions/tests/docs-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  buildFindCmd,
  buildGrepCountCmd,
  buildGrepJsonCmd,
  buildReadCmd,
  buildSearchCmd,
  buildSourcesCmd,
  buildSummaryCmds,
  capOutput,
  formatRgMatches,
  parseRgJson,
  rankByTokenHits,
  resolveAndValidate,
  runDocs,
  safePath,
  sq,
  tokenizeQuery,
} from "../lib/docs-core.ts";

// -- pure: quoting / tokenisation --------------------------------------------

describe("docs-core.sq", () => {
  test("escapes single quotes for POSIX single-quoted strings", () => {
    expect(sq("it's a test")).toBe("it'\\''s a test");
  });
});

describe("docs-core.tokenizeQuery", () => {
  test("splits on whitespace", () => {
    expect(tokenizeQuery("row level security")).toEqual(["row", "level", "security"]);
  });
  test("quoted span stays whole (phrase)", () => {
    expect(tokenizeQuery('"row level" security')).toEqual(["row level", "security"]);
  });
  test("empty query still yields >= 1 token", () => {
    expect(tokenizeQuery("").length).toBe(1);
  });
});

describe("docs-core.rankByTokenHits", () => {
  test("ranks lines by distinct-token hits, stable on ties", () => {
    const lines = ["auth only", "auth and rls here", "rls only"];
    const ranked = rankByTokenHits(lines, ["auth", "rls"]);
    expect(ranked[0]).toBe("auth and rls here");
  });
  test("single token is a no-op", () => {
    const lines = ["b", "a"];
    expect(rankByTokenHits(lines, ["x"])).toEqual(lines);
  });
});

// -- pure: path validation ---------------------------------------------------

describe("docs-core.safePath", () => {
  test("prepends /docs/ to a bare source path", () => {
    expect(safePath("supabase/guides/auth.md")).toBe("/docs/supabase/guides/auth.md");
  });
  test("leaves an already-/docs/ path intact", () => {
    expect(safePath("/docs/postgres/index.md")).toBe("/docs/postgres/index.md");
  });
  test("strips ../ traversal but keeps legit '..' filenames", () => {
    expect(safePath("/docs/mdn/do..while/index.md")).toBe("/docs/mdn/do..while/index.md");
    // ../ is stripped -> /docs/etc/passwd, which then trips the /docs/etc local-prefix guard
    expect(() => safePath("/docs/../etc/passwd")).toThrow(/local filesystem path/);
    // the ../ marker is stripped (not the preceding segment), leaving both dirs joined
    expect(safePath("supabase/../postgres/x.md")).toBe("/docs/supabase/postgres/x.md");
  });
  test("rejects a local filesystem path", () => {
    expect(() => safePath("/Users/erfi/foo.md")).toThrow(/local filesystem path/);
    expect(() => safePath("/docs/home/erfi/foo.md")).toThrow(/local filesystem path/);
  });
});

describe("docs-core.resolveAndValidate", () => {
  test("accepts filePath alias", () => {
    const v = resolveAndValidate({ filePath: "supabase/x.md" });
    expect(v).toEqual({ argPath: "supabase/x.md", p: "/docs/supabase/x.md" });
  });
  test("missing path -> discriminated error", () => {
    const v = resolveAndValidate({});
    expect("error" in v).toBe(true);
  });
});

// -- pure: command builders --------------------------------------------------

describe("docs-core command builders", () => {
  test("buildSearchCmd OR-chains tokens over the index and filters by source", () => {
    const cmd = buildSearchCmd(["auth", "rls"], "supabase");
    expect(cmd).toContain("rg -i -e 'auth' -e 'rls' /docs/_index.tsv");
    expect(cmd).toContain("| rg '^supabase/'");
  });
  test("buildSearchCmd without source omits the filter", () => {
    expect(buildSearchCmd(["x"])).toBe("rg -i -e 'x' /docs/_index.tsv ");
  });
  test("buildReadCmd offset+lines uses a bat line-range with sed fallback", () => {
    const cmd = buildReadCmd("/docs/a.md", { offset: 10, lines: 5 });
    expect(cmd).toContain("--line-range=10:14");
    expect(cmd).toContain("sed -n '10,14p'");
  });
  test("buildReadCmd lines-only uses head", () => {
    expect(buildReadCmd("/docs/a.md", { lines: 20 })).toContain("head -20");
  });
  test("buildFindCmd globs case-insensitively with a head cap", () => {
    expect(buildFindCmd("/docs/supabase/", "*auth*", 30)).toBe(
      "find '/docs/supabase/' -iname '*auth*' -type f | head -30",
    );
  });
  test("buildGrepJsonCmd + count use the requested context", () => {
    expect(buildGrepJsonCmd("/docs/x/", "TODO", 2)).toContain("rg -i --json -C2 'TODO'");
    expect(buildGrepCountCmd("/docs/x/", "TODO")).toContain("rg -ic 'TODO'");
  });
  test("buildSummaryCmds extracts headings + line/byte counts", () => {
    const c = buildSummaryCmds("/docs/a.md");
    expect(c.headings).toContain("rg -n '^#' '/docs/a.md'");
    expect(c.lineCount).toContain("wc -l");
    expect(c.byteCount).toContain("wc -c");
  });
  test("buildSourcesCmd prefers the prebuilt index with a find fallback", () => {
    const cmd = buildSourcesCmd("postgres");
    expect(cmd).toContain("/docs/_index.tsv");
    expect(cmd).toContain("find /docs -mindepth 2");
    expect(cmd).toContain("| rg -i 'postgres'");
  });
});

// -- pure: rg --json parsing + rendering -------------------------------------

const RG_JSON = [
  JSON.stringify({ type: "begin", data: { path: { text: "/docs/pg/a.md" } } }),
  JSON.stringify({
    type: "match",
    data: {
      path: { text: "/docs/pg/a.md" },
      line_number: 12,
      lines: { text: "enable row level security\n" },
      submatches: [{ start: 7, end: 10 }],
    },
  }),
  "not-json-noise",
  JSON.stringify({
    type: "match",
    data: {
      path: { text: "/docs/pg/a.md" },
      line_number: 40,
      lines: { text: "another line\n" },
    },
  }),
].join("\n");

describe("docs-core.parseRgJson + formatRgMatches", () => {
  test("parses match events, skipping non-match/noise lines", () => {
    const matches = parseRgJson(RG_JSON);
    expect(matches.length).toBe(2);
    expect(matches[0].path).toBe("/docs/pg/a.md");
    expect(matches[0].line).toBe(12);
    expect(matches[0].text).toBe("enable row level security");
  });
  test("formats grouped by path with ** highlights on submatches", () => {
    const out = formatRgMatches(parseRgJson(RG_JSON));
    expect(out).toContain("/docs/pg/a.md");
    expect(out).toContain("12: enable **row** level security");
    expect(out).toContain("40: another line");
  });
  test("malformed input -> []", () => {
    expect(parseRgJson("garbage")).toEqual([]);
  });
});

describe("docs-core.capOutput", () => {
  test("returns text unchanged under the cap", () => {
    expect(capOutput("short")).toBe("short");
  });
  test("truncates with a path-aware hint over the cap", () => {
    const big = "x".repeat(60_000);
    const out = capOutput(big, "/docs/a.md");
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[truncated");
    expect(out).toContain("/docs/a.md");
  });
});

// -- orchestrator: runDocs with a stubbed ssh runner -------------------------

function stubSsh(responses: Record<string, string>): (cmd: string) => Promise<string> {
  return async (cmd: string) => {
    for (const [needle, out] of Object.entries(responses)) {
      if (cmd.includes(needle)) return out;
    }
    return "";
  };
}

describe("docs-core.runDocs", () => {
  test("search: returns ranked index lines", async () => {
    const index = "supabase/auth.md\tAuth\trls and auth\nsupabase/db.md\tDB\tauth only";
    const ssh = stubSsh({ "/docs/_index.tsv": index });
    const r = await runDocs("search", { query: "auth rls", source: "supabase" }, ssh);
    expect(r.isError).toBeUndefined();
    // the line hitting both tokens ranks first
    expect(r.text.split("\n")[0]).toContain("rls and auth");
    expect(r.details.query).toBe("auth rls");
  });

  test("search: empty index falls back to filename/content search", async () => {
    const ssh = stubSsh({
      "find '/docs/supabase/'": "/docs/supabase/guides/auth.md",
      "rg -il": "/docs/supabase/db.md",
    });
    const r = await runDocs("search", { query: "auth", source: "supabase" }, ssh);
    expect(r.text).toContain("found via filename/content search");
    expect(r.text).toContain("/docs/supabase/guides/auth.md");
    expect(r.details.via).toBe("fallback");
  });

  test("search: truly-empty -> no results message", async () => {
    const r = await runDocs("search", { query: "zzz", source: "supabase" }, stubSsh({}));
    expect(r.text).toContain('[no results for "zzz" in supabase]');
  });

  test("read: prepends [source] header and passes offset/lines through", async () => {
    const ssh = stubSsh({ "head -3": "line1\nline2\nline3" });
    const r = await runDocs("read", { path: "supabase/x.md", lines: 3 }, ssh);
    expect(r.text).toContain("[source] supabase/x.md");
    expect(r.text).toContain("line1");
    expect(r.details.path).toBe("supabase/x.md");
  });

  test("read: rejects a local-fs path with isError", async () => {
    const r = await runDocs("read", { path: "/Users/erfi/x.md" }, stubSsh({}));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("local filesystem path");
  });

  test("grep: parses rg --json, notes total when it exceeds shown", async () => {
    const ssh = stubSsh({ "--json": RG_JSON, "rg -ic": "9" });
    const r = await runDocs("grep", { query: "row", path: "pg/" }, ssh);
    expect(r.text).toContain("matches");
    expect(r.text).toContain("(showing 2 of 9)");
    expect(r.details.matches).toBe(2);
    expect(r.details.total).toBe(9);
  });

  test("grep: no json + no plain -> no-matches message", async () => {
    const ssh = stubSsh({ "rg -ic": "0" });
    const r = await runDocs("grep", { query: "nope", path: "pg/" }, ssh);
    expect(r.text).toContain('[no matches for "nope" in pg/]');
    expect(r.details.matches).toBe(0);
  });

  test("find: requires a pattern", async () => {
    const r = await runDocs("find", {}, stubSsh({}));
    expect(r.isError).toBe(true);
  });

  test("find: returns raw file list", async () => {
    const ssh = stubSsh({ "find '/docs/supabase/'": "/docs/supabase/auth.md" });
    const r = await runDocs("find", { pattern: "*auth*", source: "supabase" }, ssh);
    expect(r.text).toContain("/docs/supabase/auth.md");
    expect(r.details.pattern).toBe("*auth*");
  });

  test("summary: renders line/byte counts + headings", async () => {
    const ssh = stubSsh({
      "rg -n '^#'": "1:# Title\n5:## Section",
      "wc -l": "120",
      "wc -c": "4096",
    });
    const r = await runDocs("summary", { path: "pg/a.md" }, ssh);
    expect(r.text).toContain("[source] pg/a.md");
    expect(r.text).toContain("120 lines, 4096 bytes");
    expect(r.text).toContain("# Title");
    expect(r.details.lines).toBe(120);
    expect(r.details.bytes).toBe(4096);
  });

  test("sources: passes filter through and returns counts", async () => {
    const ssh = stubSsh({ "/docs/_index.tsv": "postgres: 42 files" });
    const r = await runDocs("sources", { filter: "postgres" }, ssh);
    expect(r.text).toContain("postgres: 42 files");
    expect(r.details.filter).toBe("postgres");
  });

  test("unknown action -> isError", async () => {
    const r = await runDocs("bogus" as never, {}, stubSsh({}));
    expect(r.isError).toBe(true);
  });
});

import { safeHeadN } from "../lib/docs-core.ts";
describe("docs-core.safeHeadN (code-review: head -N injection guard)", () => {
  test("coerces to a bounded positive int; injection/negative -> fallback, float floored, capped", () => {
    expect(safeHeadN(5)).toBe(5);
    expect(safeHeadN(5.9)).toBe(5);
    expect(safeHeadN("5; rm -rf /")).toBe(20);
    expect(safeHeadN(-3)).toBe(20);
    expect(safeHeadN(1e9)).toBe(1000);
  });
});
