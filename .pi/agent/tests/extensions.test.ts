/**
 * Unit tests for pure helpers exported from the pi extensions.
 *
 * Run: `bun test .pi/agent/tests/`
 *
 * Scope: parsers + pure logic. Side-effectful code (DB, SSH, HTTP, file I/O,
 * pi.on hooks) is integration territory; we don't cover it here.
 */

import { describe, expect, test } from "bun:test";

import {
  splitSegments,
  extractPatchPaths,
} from "../extensions/tool-guard.ts";
import { parsePatch } from "../extensions/apply-patch.ts";
import {
  HARD_CAP_BYTES,
  SOFT_WARN_BYTES,
  SIDECAR_SUFFIX,
  sidecarPath,
  validateChunk,
} from "../extensions/write-stream.ts";
import { parseImage, versionCompare } from "../extensions/oci-tags.ts";
import {
  dateFromName,
  extractText,
  tokenise,
} from "../extensions/session-search.ts";
import { toFtsQuery } from "../extensions/session-fts/index.ts";
import { parseOsvJson } from "../extensions/osv-scan.ts";
import { parseGitleaksJson, parseNoseyparkerJsonl } from "../extensions/secret-scan.ts";
import { parseHurlJson } from "../extensions/hurl-test.ts";
import { parseGoTestJson } from "../extensions/go-test.ts";
import { parseHyperfineJson } from "../extensions/bench.ts";
import { fmtDuration, makeSlug, makeSessionName } from "../extensions/bg-tasks.ts";
import { decideInjection, matchesIntent, looksLikeSpec } from "../extensions/superpowers.ts";

// ── tool-guard: bash segment splitting ────────────────────────────────────

describe("tool-guard.splitSegments", () => {
  test("single command unchanged", () => {
    expect(splitSegments("git commit -m 'x'")).toEqual(["git commit -m 'x'"]);
  });

  test("&& chain splits", () => {
    expect(splitSegments("cd /r && git commit")).toEqual(["cd /r ", " git commit"]);
  });

  test("|| chain splits", () => {
    expect(splitSegments("a || b")).toEqual(["a ", " b"]);
  });

  test("semicolon splits", () => {
    expect(splitSegments("a; b; c")).toEqual(["a", " b", " c"]);
  });

  test("pipe splits", () => {
    expect(splitSegments("ls | grep foo")).toEqual(["ls ", " grep foo"]);
  });

  test("mixed operators split together", () => {
    expect(splitSegments("a && b | c")).toEqual(["a ", " b ", " c"]);
  });

  test("each segment can be tested independently", () => {
    const segs = splitSegments("cd ~/keycloak-compose && docker compose up -d");
    const dcRe = /^\s*docker\s+compose\s+(up|down|restart|pull|logs|exec)\b/;
    expect(segs.some((s) => dcRe.test(s))).toBe(true);
  });
});

// ── tool-guard: apply_patch path extraction ───────────────────────────────

describe("tool-guard.extractPatchPaths", () => {
  test("extracts Add/Update/Delete paths from envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+const x = 1;",
      "*** Update File: src/old.ts",
      "@@ ctx",
      "-foo",
      "+bar",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractPatchPaths(patch)).toEqual([
      "src/new.ts",
      "src/old.ts",
      "src/gone.ts",
    ]);
  });

  test("handles paths with spaces and special chars", () => {
    const patch = "*** Add File: path with spaces/foo bar.md\n+x";
    expect(extractPatchPaths(patch)).toEqual(["path with spaces/foo bar.md"]);
  });

  test("Move to: also counts as a target", () => {
    const patch = "*** Move to File: dest.ts\n";
    expect(extractPatchPaths(patch)).toContain("dest.ts");
  });

  test("ignores non-marker lines", () => {
    const patch = ["random text", "+more text", "*** End Patch"].join("\n");
    expect(extractPatchPaths(patch)).toEqual([]);
  });

  test("handles CRLF line endings", () => {
    const patch = "*** Add File: a.ts\r\n+x\r\n*** Delete File: b.ts\r\n";
    expect(extractPatchPaths(patch)).toEqual(["a.ts", "b.ts"]);
  });

  test("returns [] for non-string input", () => {
    expect(extractPatchPaths(undefined as unknown as string)).toEqual([]);
    expect(extractPatchPaths("" as string)).toEqual([]);
  });

  test("catches the .env bypass attempt", () => {
    const patch = "*** Begin Patch\n*** Update File: .env\n@@ x\n-a\n+b\n*** End Patch";
    expect(extractPatchPaths(patch)).toEqual([".env"]);
  });

  test("catches .git/config write attempt", () => {
    const patch = "*** Add File: .git/config\n+[remote \"evil\"]\n";
    expect(extractPatchPaths(patch)).toEqual([".git/config"]);
  });
});

// ── apply-patch: parsePatch ───────────────────────────────────────────────

describe("apply-patch.parsePatch", () => {
  test("parses an Add File op with content", () => {
    const patch = "*** Begin Patch\n*** Add File: x.ts\n+line 1\n+line 2\n*** End Patch";
    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "add", path: "x.ts" });
    if (ops[0].type === "add") {
      expect(ops[0].content).toBe("line 1\nline 2\n");
    }
  });

  test("parses Delete File", () => {
    const patch = "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch";
    const ops = parsePatch(patch);
    expect(ops).toEqual([{ type: "delete", path: "gone.ts" }]);
  });

  test("parses Update File with one hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: f.ts",
      "@@ function foo",
      "-  return 1;",
      "+  return 2;",
      "*** End Patch",
    ].join("\n");
    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("update");
    if (ops[0].type === "update") {
      expect(ops[0].hunks).toHaveLength(1);
      expect(ops[0].hunks[0].oldLines).toEqual(["  return 1;"]);
      expect(ops[0].hunks[0].newLines).toEqual(["  return 2;"]);
    }
  });

  test("rejects Add File body without + prefix", () => {
    const patch = "*** Add File: x.ts\nno plus prefix\n";
    expect(() => parsePatch(patch)).toThrow(/every line must start with '\+'/);
  });

  test("rejects Update with no hunks", () => {
    const patch = "*** Update File: x.ts\n";
    expect(() => parsePatch(patch)).toThrow(/no @@ hunks/);
  });

  test("rejects empty patch", () => {
    expect(() => parsePatch("")).toThrow(/no file operations/);
  });

  test("handles multiple ops in one envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+x",
      "*** Delete File: b.ts",
      "*** End Patch",
    ].join("\n");
    const ops = parsePatch(patch);
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("add");
    expect(ops[1].type).toBe("delete");
  });

  test("handles CRLF line endings (Windows clipboards)", () => {
    const patch = "*** Begin Patch\r\n*** Delete File: x\r\n*** End Patch\r\n";
    expect(parsePatch(patch)).toEqual([{ type: "delete", path: "x" }]);
  });
});

// ── oci-tags: image parsing ───────────────────────────────────────────────

describe("oci-tags.parseImage", () => {
  test("bare name → library/ on Docker Hub", () => {
    expect(parseImage("nginx")).toEqual({
      registry: "registry-1.docker.io",
      repo: "library/nginx",
    });
  });

  test("org/name on Docker Hub", () => {
    expect(parseImage("vaultwarden/server")).toEqual({
      registry: "registry-1.docker.io",
      repo: "vaultwarden/server",
    });
  });

  test("hostname/path on custom registry", () => {
    expect(parseImage("ghcr.io/astral-sh/uv")).toEqual({
      registry: "ghcr.io",
      repo: "astral-sh/uv",
    });
  });

  test("strips :tag suffix", () => {
    expect(parseImage("nginx:1.27").repo).toBe("library/nginx");
  });

  test("strips @digest suffix", () => {
    expect(parseImage("nginx@sha256:abc").repo).toBe("library/nginx");
  });

  test("port number in hostname keeps it as registry", () => {
    expect(parseImage("localhost:5000/foo")).toEqual({
      registry: "localhost:5000",
      repo: "foo",
    });
  });
});

// ── oci-tags: version comparator ──────────────────────────────────────────

describe("oci-tags.versionCompare", () => {
  test("orders numeric versions ascending", () => {
    const tags = ["1.2.10", "1.2.2", "1.2.9", "1.10.0"];
    tags.sort(versionCompare);
    expect(tags).toEqual(["1.2.2", "1.2.9", "1.2.10", "1.10.0"]);
  });

  test("strips leading v", () => {
    expect(versionCompare("v1.2.0", "1.2.0")).toBe(0);
  });

  test("current behaviour with pre-release tags (NOT semver-conformant)", () => {
    // The comparator splits on `.` and `-` then does numeric-or-locale
    // compare per part. For "1.0.0" vs "1.0.0-rc1" it ends up comparing
    // "" (missing 4th part) vs "rc1" via localeCompare — which sorts the
    // bare release BEFORE the pre-release, not after. Strictly speaking
    // semver says rc1 < release. Documenting the actual behaviour here:
    const tags = ["1.0.0", "1.0.0-rc1", "1.0.0-beta"];
    tags.sort(versionCompare);
    expect(tags).toEqual(["1.0.0", "1.0.0-beta", "1.0.0-rc1"]);
    // TODO: if this matters for `oci_tags semver:true` results, the
    // comparator needs a real semver implementation (treat missing
    // pre-release as higher than any pre-release string).
  });

  test("orders date-style tags lexically when numeric match", () => {
    const tags = ["2024-01-15", "2024-02-01", "2023-12-31"];
    tags.sort(versionCompare);
    expect(tags).toEqual(["2023-12-31", "2024-01-15", "2024-02-01"]);
  });
});

// ── session-search: pure helpers ──────────────────────────────────────────

describe("session-search.dateFromName", () => {
  test("extracts ISO date prefix", () => {
    expect(dateFromName("2026-05-20T22-19-40-639Z_uuid.jsonl")).toBe("2026-05-20");
  });

  test("returns ? on unrecognised filename", () => {
    expect(dateFromName("random.jsonl")).toBe("?");
  });

  test("handles short filenames", () => {
    expect(dateFromName("")).toBe("?");
  });
});

describe("session-search.extractText", () => {
  test("plain string passes through", () => {
    expect(extractText("hello")).toBe("hello");
  });

  test("array of strings joins with space", () => {
    expect(extractText(["hello", "world"])).toBe("hello world");
  });

  test("array of objects with .text concatenates", () => {
    expect(extractText([{ text: "foo" }, { text: "bar" }])).toBe("foo bar");
  });

  test("mixed array works", () => {
    expect(extractText(["foo", { text: "bar" }, "baz"])).toBe("foo bar baz");
  });

  test("non-array non-string returns empty", () => {
    expect(extractText({} as unknown)).toBe("");
    expect(extractText(42 as unknown)).toBe("");
    expect(extractText(null as unknown)).toBe("");
  });

  test("skips items without .text property", () => {
    expect(extractText([{ kind: "image" }, { text: "real" }])).toBe("real");
  });
});

describe("session-search.tokenise", () => {
  test("splits whitespace", () => {
    expect(tokenise("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("dedupes tokens", () => {
    expect(tokenise("foo foo bar")).toEqual(["foo", "bar"]);
  });

  test("splits on punctuation", () => {
    expect(tokenise("opencode/pi-migration")).toEqual(["opencode", "pi", "migration"]);
  });

  test("quoted phrase passes as single token", () => {
    expect(tokenise('"web research"')).toEqual(['"web research"']);
  });

  test("OR/AND/NOT pass as single token", () => {
    expect(tokenise("foo OR bar")).toEqual(["foo OR bar"]);
    expect(tokenise("a AND b")).toEqual(["a AND b"]);
    expect(tokenise("not_this NOT that")).toEqual(["not_this NOT that"]);
  });

  test("empty / whitespace returns empty array", () => {
    expect(tokenise("")).toEqual([]);
    expect(tokenise("   ")).toEqual([]);
  });
});

// ── session-fts: toFtsQuery ───────────────────────────────────────────────

describe("session-fts.toFtsQuery", () => {
  test("multi-word becomes OR query", () => {
    expect(toFtsQuery("opencode pi migration")).toBe("opencode OR pi OR migration");
  });

  test("structured query passes through unchanged", () => {
    expect(toFtsQuery("foo OR bar")).toBe("foo OR bar");
    expect(toFtsQuery('"web research"')).toBe('"web research"');
    expect(toFtsQuery("foo*")).toBe("foo*");
  });

  test("splits on dotted / slashed tokens", () => {
    expect(toFtsQuery("session-fts/index.ts")).toBe("session OR fts OR index OR ts");
  });

  test("single word stays single", () => {
    expect(toFtsQuery("supabase")).toBe("supabase");
  });
});

// ── osv-scan: parseOsvJson ────────────────────────────────────────

describe("osv-scan.parseOsvJson", () => {
  test("empty results return []", () => {
    expect(parseOsvJson('{"results":[]}')).toEqual([]);
  });

  test("flattens one vuln correctly", () => {
    const raw = JSON.stringify({
      results: [
        {
          source: { path: "/repo/go.mod" },
          packages: [
            {
              package: { name: "foo", version: "1.0.0", ecosystem: "Go" },
              vulnerabilities: [
                {
                  id: "GO-2024-001",
                  aliases: ["CVE-2024-1234"],
                  summary: "Buffer overflow",
                  database_specific: { severity: "HIGH" },
                  affected: [{ ranges: [{ events: [{ fixed: "1.0.1" }] }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const result = parseOsvJson(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      package: "foo",
      version: "1.0.0",
      ecosystem: "Go",
      id: "GO-2024-001",
      aliases: ["CVE-2024-1234"],
      severity: "HIGH",
      fixed: "1.0.1",
      summary: "Buffer overflow",
      source: "/repo/go.mod",
    });
  });

  test("missing optional fields default cleanly", () => {
    const raw = JSON.stringify({
      results: [
        {
          source: { path: "a" },
          packages: [
            {
              package: { name: "x", version: "1", ecosystem: "npm" },
              vulnerabilities: [{ id: "GHSA-xxxx" }],
            },
          ],
        },
      ],
    });
    const result = parseOsvJson(raw);
    expect(result[0]).toMatchObject({
      package: "x",
      id: "GHSA-xxxx",
      severity: null,
      fixed: null,
      summary: "",
      aliases: [],
    });
  });

  test("invalid JSON returns []", () => {
    expect(parseOsvJson("not json")).toEqual([]);
    expect(parseOsvJson("")).toEqual([]);
  });

  test("falls back to CVSS score if no database_specific.severity", () => {
    const raw = JSON.stringify({
      results: [
        {
          source: { path: "a" },
          packages: [
            {
              package: { name: "y", version: "2", ecosystem: "PyPI" },
              vulnerabilities: [
                {
                  id: "PYSEC-1",
                  severity: [{ type: "CVSS_V3", score: "9.8" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseOsvJson(raw)[0].severity).toBe("9.8");
  });
});

// ── secret-scan parsers ──────────────────────────────────────────────

describe("secret-scan.parseGitleaksJson", () => {
  test("returns truncated secret prefix, never full value", () => {
    const raw = JSON.stringify([
      {
        RuleID: "aws-access-key",
        File: "/secrets.txt",
        StartLine: 5,
        EndLine: 5,
        Secret: "AKIAIOSFODNN7EXAMPLE",
        Description: "AWS access key",
      },
    ]);
    const r = parseGitleaksJson(raw);
    expect(r).toHaveLength(1);
    expect(r[0].secretPrefix).toContain("AKIAIOSFODNN");
    expect(r[0].secretPrefix).toContain("20 chars");
    // The full secret value should NOT appear
    expect(r[0].secretPrefix).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("empty array input", () => {
    expect(parseGitleaksJson("[]")).toEqual([]);
  });

  test("invalid JSON returns []", () => {
    expect(parseGitleaksJson("oops")).toEqual([]);
  });

  test("preserves commit when present", () => {
    const raw = JSON.stringify([
      { RuleID: "x", File: "f", StartLine: 1, Secret: "s", Commit: "abc123def456" },
    ]);
    expect(parseGitleaksJson(raw)[0].commit).toBe("abc123def456");
  });
});

describe("secret-scan.parseNoseyparkerJsonl", () => {
  test("parses one finding per line", () => {
    const jsonl = JSON.stringify({
      rule_name: "AWS Key",
      matches: [
        {
          provenance: [{ path: "/repo/.env" }],
          location: { source_span: { start: { line: 12 } } },
          snippet: { matching: "AKIAIOSFODNN7EXAMPLE" },
        },
      ],
    });
    const r = parseNoseyparkerJsonl(jsonl);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      rule: "AWS Key",
      file: "/repo/.env",
      line: 12,
    });
    expect(r[0].secretPrefix).toContain("AKIAIOSFODNN");
    expect(r[0].secretPrefix).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("skips malformed lines without crashing", () => {
    const jsonl = `{"valid":true}\nnotjson\n${JSON.stringify({
      rule_name: "R",
      matches: [{ provenance: [{ path: "f" }], location: { source_span: { start: { line: 1 } } }, snippet: { matching: "x" } }],
    })}`;
    expect(parseNoseyparkerJsonl(jsonl)).toHaveLength(1);
  });
});

// ── hurl-test: parseHurlJson ────────────────────────────────────────

describe("hurl-test.parseHurlJson", () => {
  test("all-success run", () => {
    const raw = JSON.stringify({
      success: true,
      entries: [
        {
          index: 1,
          request: { method: "GET", url: "https://example.com" },
          response: { status: 200 },
          time: 42,
          asserts: [{ success: true }],
        },
      ],
    });
    const r = parseHurlJson(raw);
    expect(r.allSuccess).toBe(true);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].success).toBe(true);
    expect(r.entries[0].failedAsserts).toEqual([]);
  });

  test("failed assert is captured", () => {
    const raw = JSON.stringify({
      success: false,
      entries: [
        {
          index: 1,
          request: { method: "POST", url: "http://api/x" },
          response: { status: 500 },
          time: 100,
          asserts: [
            {
              success: false,
              predicate: { kind: "equal" },
              expected: 200,
              actual: 500,
              message: "status equals 200",
            },
          ],
        },
      ],
    });
    const r = parseHurlJson(raw);
    expect(r.allSuccess).toBe(false);
    expect(r.entries[0].success).toBe(false);
    expect(r.entries[0].failedAsserts).toHaveLength(1);
    expect(r.entries[0].failedAsserts[0].kind).toBe("equal");
  });

  test("handles array-of-runs input", () => {
    const raw = JSON.stringify([
      { success: true, entries: [{ index: 1, request: { method: "GET", url: "a" }, response: { status: 200 }, asserts: [] }] },
      { success: true, entries: [{ index: 1, request: { method: "GET", url: "b" }, response: { status: 200 }, asserts: [] }] },
    ]);
    expect(parseHurlJson(raw).entries).toHaveLength(2);
  });

  test("reads request/response from calls[] (hurl 8+ format)", () => {
    const raw = JSON.stringify({
      success: false,
      entries: [
        {
          index: 2,
          time: 8,
          calls: [{ request: { method: "GET", url: "https://example.com/" }, response: { status: 200 } }],
          asserts: [
            { success: true, line: 10 },
            { success: false, line: 12, message: "body assertion failed" },
          ],
        },
      ],
    });
    const r = parseHurlJson(raw);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].method).toBe("GET");
    expect(r.entries[0].url).toBe("https://example.com/");
    expect(r.entries[0].status).toBe(200);
    expect(r.entries[0].failedAsserts).toHaveLength(1);
    expect(r.entries[0].failedAsserts[0].message).toBe("body assertion failed");
  });

  test("invalid JSON", () => {
    const r = parseHurlJson("not json");
    expect(r.entries).toEqual([]);
    expect(r.allSuccess).toBe(false);
  });
});

// ── go-test: parseGoTestJson ────────────────────────────────────────

describe("go-test.parseGoTestJson", () => {
  test("all-pass run", () => {
    const events = [
      { Time: "t", Action: "run", Package: "pkg/x", Test: "TestA" },
      { Time: "t", Action: "output", Package: "pkg/x", Test: "TestA", Output: "PASS\n" },
      { Time: "t", Action: "pass", Package: "pkg/x", Test: "TestA", Elapsed: 0.01 },
      { Time: "t", Action: "pass", Package: "pkg/x", Elapsed: 0.02 },
    ];
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
    const s = parseGoTestJson(jsonl);
    expect(s.totalTests).toBe(1);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.failures).toEqual([]);
  });

  test("captures failure with output excerpt", () => {
    const events = [
      { Action: "run", Package: "pkg/y", Test: "TestFail" },
      { Action: "output", Package: "pkg/y", Test: "TestFail", Output: "=== RUN   TestFail\n" },
      { Action: "output", Package: "pkg/y", Test: "TestFail", Output: "   foo_test.go:10: expected 1 got 2\n" },
      { Action: "output", Package: "pkg/y", Test: "TestFail", Output: "--- FAIL: TestFail (0.00s)\n" },
      { Action: "fail", Package: "pkg/y", Test: "TestFail", Elapsed: 0.0 },
    ];
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
    const s = parseGoTestJson(jsonl);
    expect(s.failed).toBe(1);
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0].test).toBe("TestFail");
    expect(s.failures[0].outputExcerpt).toContain("expected 1 got 2");
    // Should strip the === RUN scaffold line
    expect(s.failures[0].outputExcerpt).not.toContain("=== RUN");
  });

  test("skips invalid JSON lines without crashing", () => {
    const jsonl = `{"Action":"run","Package":"x","Test":"T"}\nNOT JSON\n{"Action":"pass","Package":"x","Test":"T"}`;
    const s = parseGoTestJson(jsonl);
    expect(s.passed).toBe(1);
  });
});

// ── bench: parseHyperfineJson ───────────────────────────────────────

describe("bench.parseHyperfineJson", () => {
  test("identifies winner and speedup", () => {
    const raw = JSON.stringify({
      results: [
        { command: "slow", mean: 1.0, stddev: 0.1, min: 0.9, max: 1.1, median: 1.0, times: [1, 1, 1, 1] },
        { command: "fast", mean: 0.5, stddev: 0.05, min: 0.45, max: 0.55, median: 0.5, times: [0.5, 0.5] },
      ],
    });
    const r = parseHyperfineJson(raw);
    expect(r.winner).toBe("fast");
    expect(r.speedupX).toBeCloseTo(2.0, 5);
    expect(r.results).toHaveLength(2);
  });

  test("single result returns no speedup", () => {
    const raw = JSON.stringify({
      results: [{ command: "one", mean: 1.0, stddev: 0, min: 1, max: 1, median: 1, times: [1] }],
    });
    const r = parseHyperfineJson(raw);
    expect(r.winner).toBe("one");
    expect(r.speedupX).toBe(1);
  });

  test("invalid JSON", () => {
    expect(parseHyperfineJson("bad")).toEqual({ results: [], winner: null, speedupX: null });
  });
});

// ── bg-tasks pure helpers ────────────────────────────────────────────

describe("bg-tasks.fmtDuration", () => {
  test("sub-second", () => {
    expect(fmtDuration(0)).toBe("0ms");
    expect(fmtDuration(42)).toBe("42ms");
    expect(fmtDuration(999)).toBe("999ms");
  });
  test("seconds", () => {
    expect(fmtDuration(1000)).toBe("1s");
    expect(fmtDuration(59_000)).toBe("59s");
  });
  test("minutes", () => {
    expect(fmtDuration(60_000)).toBe("1m00s");
    expect(fmtDuration(125_000)).toBe("2m05s");
    expect(fmtDuration(59 * 60_000)).toBe("59m00s");
  });
  test("hours", () => {
    expect(fmtDuration(60 * 60_000)).toBe("1h00m");
    expect(fmtDuration(125 * 60_000)).toBe("2h05m");
  });
  test("negative", () => {
    expect(fmtDuration(-1)).toBe("-");
  });
});

describe("bg-tasks.makeSlug", () => {
  test("basic lowercase + hyphen", () => {
    expect(makeSlug("Refactor auth module")).toBe("refactor-auth-module");
  });
  test("strips punctuation", () => {
    expect(makeSlug("Run TS!! tests, please.")).toBe("run-ts-tests-please");
  });
  test("caps at 4 tokens", () => {
    expect(makeSlug("one two three four five six")).toBe("one-two-three-four");
  });
  test("caps at 30 chars", () => {
    const slug = makeSlug("superlongwordoneverywhereyouevervisit anotherreallylongword");
    expect(slug.length).toBeLessThanOrEqual(30);
  });
  test("fallback when empty", () => {
    expect(makeSlug("!!! ??? ...")).toBe("task");
    expect(makeSlug("")).toBe("task");
  });
  test("drops 1-char tokens", () => {
    expect(makeSlug("a be c done")).toBe("be-done");
  });
});

describe("bg-tasks.makeSessionName", () => {
  test("has prefix + slug + timestamp", () => {
    const n = makeSessionName("foo");
    expect(n).toMatch(/^pi-bg-foo-\d+$/);
  });
  test("different calls produce different names (1s apart)", async () => {
    const n1 = makeSessionName("x");
    await new Promise((r) => setTimeout(r, 1100));
    const n2 = makeSessionName("x");
    expect(n1).not.toBe(n2);
  });
});

// ── superpowers intent classifier ─────────────────────────────────────────

describe("superpowers.decideInjection", () => {
  // Force token always wins
  test("<superpowers> token forces injection", () => {
    expect(decideInjection("<superpowers> please help me think about this")).toBe("forced");
  });

  test("<superpowers> + spec promotes to forced-spec", () => {
    const spec = `<superpowers>\n\nI want to add etymology cards.\n\nRequirements:\n` +
      `1. fetch from dict API\n2. cache in valkey\n3. show below board\n` +
      `${"x".repeat(500)}`;
    expect(decideInjection(spec)).toBe("forced-spec");
  });

  // Hedges win over intent (small-change signal)
  test("'just fix this typo' is skipped despite 'fix'", () => {
    expect(decideInjection("just fix this typo in the README")).toBe("skip");
  });
  test("'quick one-liner to bump deps' is skipped", () => {
    expect(decideInjection("quick one-liner to bump the urllib3 version")).toBe("skip");
  });
  test("'trivial config tweak' is skipped", () => {
    expect(decideInjection("trivial config tweak, set timeout to 30s")).toBe("skip");
  });

  // Real implementation intent fires
  test("'implement etymology cards' fires intent", () => {
    expect(decideInjection("implement etymology cards from the spec")).toBe("intent");
  });
  test("'add a new compose stack' fires", () => {
    expect(decideInjection("add a new compose stack for ntfy")).toBe("intent");
  });
  test("'refactor auth.go into per-route guards' fires", () => {
    expect(decideInjection("refactor auth.go into per-route guards")).toBe("intent");
  });
  test("'fix the bug in the websocket handler' fires", () => {
    expect(decideInjection("fix the bug in the websocket handler")).toBe("intent");
  });
  test("'write unit tests for parseHurlJson' fires", () => {
    expect(decideInjection("write unit tests for parseHurlJson")).toBe("intent");
  });
  test("'TDD this new endpoint' fires", () => {
    expect(decideInjection("TDD this new endpoint")).toBe("intent");
  });

  // Question-only is skipped
  test("'how does the FTS5 indexer work?' is skipped", () => {
    expect(decideInjection("how does the FTS5 indexer work?")).toBe("skip");
  });
  test("'why is the test failing?' is skipped", () => {
    expect(decideInjection("why is the test failing?")).toBe("skip");
  });
  test("'show me how memory.ts caches' is skipped", () => {
    expect(decideInjection("show me how memory.ts caches the memories")).toBe("skip");
  });
  test("'review the extensions in this repo' is skipped", () => {
    expect(decideInjection("review the extensions in this repo")).toBe("skip");
  });
  test("'look at the bg-tasks implementation' is skipped", () => {
    expect(decideInjection("look at the bg-tasks implementation and tell me what's wrong")).toBe("skip");
  });

  // Bare verb without object should NOT fire
  test("'implement?' alone is skipped", () => {
    expect(decideInjection("implement?")).toBe("skip");
  });
  test("'what should I add?' is skipped (question + verb but no object)", () => {
    expect(decideInjection("what should I add?")).toBe("skip");
  });

  // Spec mode
  test("intent + numbered list + >500 chars → intent-spec", () => {
    const txt = `implement etymology cards.\n\n1. fetch from API\n2. cache results\n3. show below board\n` +
      `${"x".repeat(500)}`;
    expect(decideInjection(txt)).toBe("intent-spec");
  });
  test("intent + 'spec:' marker + >500 chars → intent-spec", () => {
    const txt = `implement the new feature.\n\nspec: lots of detail here ` +
      `${"x".repeat(500)}`;
    expect(decideInjection(txt)).toBe("intent-spec");
  });
  test("intent + bullet list short → intent (not spec, too short)", () => {
    expect(decideInjection("add a feature.\n- step one\n- step two")).toBe("intent");
  });
});

describe("superpowers.matchesIntent", () => {
  test("verb + object pattern matches", () => {
    expect(matchesIntent("refactor auth.go")).toBe(true);
    expect(matchesIntent("add etymology cards")).toBe(true);
  });
  test("bare verb without object doesn't match", () => {
    expect(matchesIntent("implement")).toBe(false);
    expect(matchesIntent("refactor?")).toBe(false);
  });
  test("verbs added in tighter pass", () => {
    expect(matchesIntent("swap the old client for the new one")).toBe(true);
    expect(matchesIntent("port the websocket handler to gorilla")).toBe(true);
    expect(matchesIntent("harden the auth endpoint")).toBe(true);
  });
});

describe("superpowers.looksLikeSpec", () => {
  test("short text never a spec", () => {
    expect(looksLikeSpec("add etymology cards")).toBe(false);
  });
  test("long text without markers not a spec", () => {
    expect(looksLikeSpec("x".repeat(800))).toBe(false);
  });
  test("long + bullets is a spec", () => {
    expect(looksLikeSpec(`- one\n- two\n${"x".repeat(500)}`)).toBe(true);
  });
  test("long + numbered list is a spec", () => {
    expect(looksLikeSpec(`1. one\n2. two\n${"x".repeat(500)}`)).toBe(true);
  });
  test("long + 'requirements:' is a spec", () => {
    expect(looksLikeSpec(`Requirements: ${"x".repeat(500)}`)).toBe(true);
  });
  test("long + code fence is a spec", () => {
    expect(looksLikeSpec(`\`\`\`\ncode\n\`\`\`\n${"x".repeat(500)}`)).toBe(true);
  });
});

// ── yank: code-block extraction ───────────────────────────────────────────

import { parseCodeBlocks } from "../extensions/yank.ts";

describe("yank.parseCodeBlocks", () => {
  test("simple bash fence", () => {
    const r = parseCodeBlocks("Hello\n```bash\necho one\n```\nWorld");
    expect(r).toEqual([{ language: "bash", body: "echo one" }]);
  });

  test("powershell one-liner stays single line (the user's pain case)", () => {
    const cmd =
      "New-Item -Path 'foo' -Force | Out-Null; Set-Content -Path 'bar' -Value 'baz'";
    const r = parseCodeBlocks("```powershell\n" + cmd + "\n```");
    expect(r[0].body).toBe(cmd);
    expect(r[0].body.includes("\n")).toBe(false);
  });

  test("multiple blocks preserved in order", () => {
    const r = parseCodeBlocks(
      "First:\n```js\nconst a = 1;\n```\nSecond:\n```py\nprint(2)\n```",
    );
    expect(r).toHaveLength(2);
    expect(r[0].language).toBe("js");
    expect(r[1].language).toBe("py");
  });

  test("nested fences via 4-backtick outer", () => {
    const r = parseCodeBlocks("````md\n```js\nx\n```\n````");
    expect(r).toHaveLength(1);
    expect(r[0].language).toBe("md");
    expect(r[0].body).toContain("```js");
  });

  test("tilde fence accepted", () => {
    const r = parseCodeBlocks("~~~bash\nls\n~~~");
    expect(r[0].body).toBe("ls");
  });

  test("no language tag yields empty language", () => {
    const r = parseCodeBlocks("```\nplain text\n```");
    expect(r[0].language).toBe("");
    expect(r[0].body).toBe("plain text");
  });

  test("empty input yields no blocks", () => {
    expect(parseCodeBlocks("")).toEqual([]);
    expect(parseCodeBlocks("just prose, no code")).toEqual([]);
  });

  test("trailing blank lines trimmed inside block", () => {
    const r = parseCodeBlocks("```\nbody\n\n\n```");
    expect(r[0].body).toBe("body");
  });

  test("multi-line bash preserved with internal newlines", () => {
    const r = parseCodeBlocks("```bash\necho one\necho two\n```");
    expect(r[0].body).toBe("echo one\necho two");
    expect(r[0].body.split("\n")).toHaveLength(2);
  });
});

import { parseYankArgs } from "../extensions/yank.ts";

describe("yank.parseYankArgs", () => {
  test("empty → block 1, latest message", () => {
    expect(parseYankArgs("")).toMatchObject({ n: 1, back: 0, list: false });
  });
  test("numeric → block N", () => {
    expect(parseYankArgs("2")).toMatchObject({ n: 2, back: 0, list: false });
  });
  test("negative → from-end indexing", () => {
    expect(parseYankArgs("-1")).toMatchObject({ n: -1, back: 0, list: false });
  });
  test("? → list mode", () => {
    expect(parseYankArgs("?")).toMatchObject({ n: null, back: 0, list: true });
  });
  test("^ → one message back", () => {
    expect(parseYankArgs("^")).toMatchObject({ n: 1, back: 1, list: false });
  });
  test("^^^ → three messages back", () => {
    expect(parseYankArgs("^^^")).toMatchObject({ n: 1, back: 3, list: false });
  });
  test("2^ → block 2, one back", () => {
    expect(parseYankArgs("2^")).toMatchObject({ n: 2, back: 1, list: false });
  });
  test("?^^ → list, two back", () => {
    expect(parseYankArgs("?^^")).toMatchObject({ n: null, back: 2, list: true });
  });
  test("legacy 'back N' still works", () => {
    expect(parseYankArgs("back 2")).toMatchObject({ n: 1, back: 2, list: false });
    expect(parseYankArgs("list back 1")).toMatchObject({ n: null, back: 1, list: true });
  });
  test("unknown token → error", () => {
    expect(parseYankArgs("xyz").error).toContain("unknown");
  });
  test("too many args → error", () => {
    expect(parseYankArgs("1 2").error).toContain("too many");
  });
});

import { isFlattenable, flattenLineContinuations } from "../extensions/yank.ts";

describe("yank.parseYankArgs flatten flag", () => {
  test("'!' alone → flatten + defaults", () => {
    expect(parseYankArgs("!")).toMatchObject({ n: 1, back: 0, list: false, flatten: true });
  });
  test("'2!' → block 2 flattened", () => {
    expect(parseYankArgs("2!")).toMatchObject({ n: 2, flatten: true });
  });
  test("'!^' → flatten + 1 back", () => {
    expect(parseYankArgs("!^")).toMatchObject({ n: 1, back: 1, flatten: true });
  });
  test("'2^!' → flatten allowed AFTER carets", () => {
    expect(parseYankArgs("2^!")).toMatchObject({ n: 2, back: 1, flatten: true });
  });
  test("'2!^' → flatten allowed BEFORE carets too", () => {
    expect(parseYankArgs("2!^")).toMatchObject({ n: 2, back: 1, flatten: true });
  });
  test("'?!' → list mode with flatten flag", () => {
    expect(parseYankArgs("?!")).toMatchObject({ list: true, flatten: true });
  });
  test("no '!' → flatten false", () => {
    expect(parseYankArgs("2").flatten).toBe(false);
    expect(parseYankArgs("?^").flatten).toBe(false);
  });
});

describe("yank.isFlattenable", () => {
  test("real user pain case: 3-line PS pipeline ending in |", () => {
    const body = "Get-WinEvent -FilterHashtable @{x=1} -MaxEvents 5 |\n    Where-Object {$_.Foo} |\n    Format-List X";
    expect(isFlattenable(body)).toBe(true);
  });
  test("bash backslash-continuation chain", () => {
    expect(isFlattenable("docker run \\\n  --rm \\\n  alpine ls")).toBe(true);
  });
  test("PowerShell backtick continuation", () => {
    expect(isFlattenable("Get-Foo `\n  | Where-Object")).toBe(true);
  });
  test("single line → not flattenable", () => {
    expect(isFlattenable("echo hello")).toBe(false);
  });
  test("multi-line script without continuation markers", () => {
    expect(isFlattenable("for f in *.txt; do\n  echo $f\ndone")).toBe(false);
  });
  test("blank line in middle → not flattenable (would inject empty pipe stage)", () => {
    expect(isFlattenable("echo a |\n\n  echo b")).toBe(false);
  });
  test("empty string → not flattenable", () => {
    expect(isFlattenable("")).toBe(false);
  });
});

describe("yank.flattenLineContinuations", () => {
  test("PS pipeline → single line with ' | ' joins", () => {
    const ps = "Get-WinEvent -FilterHashtable @{x=1} |\n    Where-Object {$_.Foo} |\n    Format-List";
    const flat = flattenLineContinuations(ps);
    expect(flat.includes("\n")).toBe(false);
    expect(flat).toContain("| Where-Object");
    expect(flat).toContain("| Format-List");
  });
  test("bash backslash → joined with space, no leftover backslash", () => {
    const flat = flattenLineContinuations("docker run \\\n  --rm \\\n  alpine ls");
    expect(flat.includes("\n")).toBe(false);
    expect(flat.includes("\\")).toBe(false);
    expect(flat).toBe("docker run --rm alpine ls");
  });
  test("PS backtick → joined with space, no leftover backtick", () => {
    const flat = flattenLineContinuations("Get-Foo `\n  -Name 'x' `\n  -Path 'y'");
    expect(flat.includes("\n")).toBe(false);
    expect(flat.includes("`")).toBe(false);
    expect(flat).toBe("Get-Foo -Name 'x' -Path 'y'");
  });
  test("idempotent on already-flat input", () => {
    const flat = "echo one two three";
    expect(flattenLineContinuations(flat)).toBe(flat);
  });
});

import {
  asciiFold,
  isShellLang,
  stripCommentLines,
  joinStatements,
  isJoinable,
  makePasteFriendly,
} from "../extensions/yank.ts";

describe("yank.asciiFold", () => {
  test("em-dash to hyphen", () => {
    expect(asciiFold("a — b")).toEqual({ out: "a - b", folded: 1 });
  });
  test("en-dash to hyphen", () => {
    expect(asciiFold("1 – 5")).toEqual({ out: "1 - 5", folded: 1 });
  });
  test("smart double quotes", () => {
    expect(asciiFold("say “foo”")).toEqual({ out: 'say "foo"', folded: 2 });
  });
  test("ellipsis", () => {
    expect(asciiFold("wait…")).toEqual({ out: "wait...", folded: 1 });
  });
  test("nbsp", () => {
    expect(asciiFold("a b")).toEqual({ out: "a b", folded: 1 });
  });
  test("zero-width chars removed", () => {
    expect(asciiFold("a​b‍c")).toEqual({ out: "abc", folded: 2 });
  });
  test("plain ASCII unchanged", () => {
    expect(asciiFold("hello world")).toEqual({ out: "hello world", folded: 0 });
  });
});

describe("yank.isShellLang", () => {
  test("powershell variants", () => {
    expect(isShellLang("powershell")).toBe(true);
    expect(isShellLang("ps")).toBe(true);
    expect(isShellLang("pwsh")).toBe(true);
    expect(isShellLang("PowerShell")).toBe(true);
  });
  test("unix shells", () => {
    expect(isShellLang("bash")).toBe(true);
    expect(isShellLang("zsh")).toBe(true);
    expect(isShellLang("fish")).toBe(true);
  });
  test("non-shell rejected", () => {
    expect(isShellLang("python")).toBe(false);
  });
});

describe("yank.stripCommentLines", () => {
  test("strips full-line # comments", () => {
    expect(stripCommentLines("# c1\nfoo\n  # c2\nbar")).toEqual({ out: "foo\nbar", stripped: 2 });
  });
  test("preserves mid-line #", () => {
    expect(stripCommentLines("foo  # trailing")).toEqual({ out: "foo  # trailing", stripped: 0 });
  });
});

describe("yank.joinStatements", () => {
  test("joins multi-line", () => {
    expect(joinStatements("a\nb\nc")).toBe("a ; b ; c");
  });
  test("strips trailing semicolons", () => {
    expect(joinStatements("a;\nb;\nc")).toBe("a ; b ; c");
  });
});

describe("yank.isJoinable", () => {
  test("PS multi-statement is joinable", () => {
    expect(isJoinable("$x = 1\nif (-not $x) { Write-Host 'no' }\n\"x: $x\"", "powershell")).toBe(true);
  });
  test("unclosed brace across lines NOT joinable", () => {
    expect(isJoinable("function Foo {\n  Write-Host 'hi'\n}", "powershell")).toBe(false);
  });
  test("non-shell rejected", () => {
    expect(isJoinable("a\nb\nc", "python")).toBe(false);
  });
});

// ── write-stream: validateChunk ─────────────────────────────────

describe("write-stream.sidecarPath", () => {
  test("appends .write-stream.tmp suffix", () => {
    expect(sidecarPath("/tmp/foo.md")).toBe(`/tmp/foo.md${SIDECAR_SUFFIX}`);
    expect(sidecarPath("./a/b/c")).toBe(`./a/b/c${SIDECAR_SUFFIX}`);
  });
});

describe("write-stream.validateChunk", () => {
  test("size cap: under hard cap returns null", () => {
    expect(validateChunk("only", HARD_CAP_BYTES - 1, false, false)).toBeNull();
    expect(validateChunk("first", HARD_CAP_BYTES - 1, false, false)).toBeNull();
  });

  test("size cap: at hard cap returns null (boundary inclusive)", () => {
    expect(validateChunk("only", HARD_CAP_BYTES, false, false)).toBeNull();
  });

  test("size cap: above hard cap returns split-further error", () => {
    const err = validateChunk("only", HARD_CAP_BYTES + 1, false, false);
    expect(err).toBeTruthy();
    expect(err).toContain("above the");
    expect(err).toContain("per-chunk cap");
    expect(err).toContain("Split this chunk");
  });

  test("soft warn threshold is below hard cap", () => {
    expect(SOFT_WARN_BYTES).toBeLessThan(HARD_CAP_BYTES);
  });

  test("only: errors when sidecar already exists", () => {
    const err = validateChunk("only", 100, true, false);
    expect(err).toBeTruthy();
    expect(err).toContain("sidecar already exists");
  });

  test("only: ok when sidecar absent (target may exist or not)", () => {
    expect(validateChunk("only", 100, false, false)).toBeNull();
    expect(validateChunk("only", 100, false, true)).toBeNull();
  });

  test("first: always ok (truncates any existing sidecar)", () => {
    expect(validateChunk("first", 100, false, false)).toBeNull();
    expect(validateChunk("first", 100, true, false)).toBeNull();
    expect(validateChunk("first", 100, true, true)).toBeNull();
  });

  test("middle: requires existing sidecar", () => {
    const err = validateChunk("middle", 100, false, false);
    expect(err).toBeTruthy();
    expect(err).toContain("no stream sidecar exists");
    expect(err).toContain('chunk="first"');
    expect(validateChunk("middle", 100, true, false)).toBeNull();
  });

  test("last: requires existing sidecar", () => {
    const err = validateChunk("last", 100, false, false);
    expect(err).toBeTruthy();
    expect(err).toContain("no stream sidecar exists");
    expect(validateChunk("last", 100, true, false)).toBeNull();
  });

  test("size cap takes precedence over state errors", () => {
    // Even with a valid state (sidecar exists for middle), oversized chunk
    // should hit the cap error first — the agent needs to fix size before
    // anything else matters.
    const err = validateChunk("middle", HARD_CAP_BYTES + 1, true, false);
    expect(err).toBeTruthy();
    expect(err).toContain("per-chunk cap");
  });
});

describe("yank.makePasteFriendly", () => {
  test("full pipeline on cdb-style block", () => {
    const body = "# Find cdb.exe — winget installs it\n$cdb = (Get-ChildItem \"x\").FullName\nif (-not $cdb) { $cdb = \"y\" }\n\"cdb at: $cdb\"";
    const r = makePasteFriendly(body, "powershell");
    expect(r.out.includes("\n")).toBe(false);
    expect(r.out.includes("—")).toBe(false);
    expect(r.out.includes("# Find")).toBe(false);
    expect(r.out.includes(" ; ")).toBe(true);
    expect(r.steps.some((s) => s.includes("Unicode"))).toBe(true);
    expect(r.steps.some((s) => s.includes("comment"))).toBe(true);
    expect(r.steps.some((s) => s.includes("joined"))).toBe(true);
  });
  test("pipeline block flattens (not joins)", () => {
    const r = makePasteFriendly("Get-Foo |\n  Where-Object {$_.X} |\n  Format-List", "powershell");
    expect(r.out.includes("\n")).toBe(false);
    expect(r.out.includes(" | Where-Object")).toBe(true);
    expect(r.steps.some((s) => s.includes("flattened"))).toBe(true);
  });
  test("non-shell language: ASCII-fold only", () => {
    const r = makePasteFriendly("# python\nx = 1\ny = 2", "python");
    expect(r.out.includes("# python")).toBe(true);
    expect(r.out.includes("\n")).toBe(true);
  });
  test("clean block: no-op", () => {
    const r = makePasteFriendly("echo hello", "bash");
    expect(r.out).toBe("echo hello");
    expect(r.steps).toEqual([]);
  });
});

