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
import { fmtDuration, makeSlug, makeSessionName, decideWaitResult } from "../extensions/bg-tasks.ts";
import { decideInjection, matchesIntent, looksLikeSpec } from "../extensions/superpowers.ts";
import { _internals as osint } from "../extensions/osint.ts";
import { safePath } from "../extensions/docs.ts";
import { extractCdTargets, decideTarget } from "../extensions/cd-agents-reload.ts";
import { rewriteClipboardPaths, shrunkSibling } from "../extensions/clipboard-image-shrink.ts";
import { prune, type AnyMessage } from "../extensions/tool-output-prune.ts";
import { levenshtein, closestCommand } from "../extensions/slash-typo-guard.ts";
import { shouldAbort as stuckShouldAbort, LAST_ACTIVITY_GRACE_MS } from "../extensions/stuck-state-recovery.ts";

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

// ── osint: pure formatters ───────────────────────────────────────────────
//
// formatters consume the `Investigation` shape returned by osint.erfi.io and
// emit terse markdown. The grouping/sort/cap logic is non-trivial enough to
// regress silently — cover the per-formatter happy path + key edge cases.

// ── cd-agents-reload ───────────────────────────────────────────────────────
//
// Pi doesn't re-load AGENTS.md on `cd` mid-session. This extension catches
// the bash call and surfaces the target dir's AGENTS.md before the command
// runs. Pure helpers `extractCdTargets` + `decideTarget` carry the logic.

describe("cd-agents-reload.extractCdTargets", () => {
  test("plain cd at start of command", () => {
    expect(extractCdTargets("cd /home/erfi/whisper-transcribe && docker compose up")).toEqual([
      "/home/erfi/whisper-transcribe",
    ]);
  });
  test("home-shortcut cd", () => {
    expect(extractCdTargets("cd ~/whisper-transcribe && make build")).toEqual([
      "~/whisper-transcribe",
    ]);
  });
  test("chained cds across &&", () => {
    expect(extractCdTargets("cd ~/a && do-thing && cd ~/b && do-other")).toEqual([
      "~/a",
      "~/b",
    ]);
  });
  test("semicolon-separated cds", () => {
    expect(extractCdTargets("cd /tmp/foo; cd /tmp/bar; cd /tmp/baz")).toEqual([
      "/tmp/foo",
      "/tmp/bar",
      "/tmp/baz",
    ]);
  });
  test("quoted target with spaces", () => {
    expect(extractCdTargets("cd '/home/erfi/has space/repo' && ls")).toEqual([
      "/home/erfi/has space/repo",
    ]);
    expect(extractCdTargets('cd "/home/erfi/has space/repo" && ls')).toEqual([
      "/home/erfi/has space/repo",
    ]);
  });
  test("subshell cd", () => {
    // `( cd foo && cmd )` — the inner segment starts after `(` whitespace.
    // Our regex tolerates leading whitespace and `(` is its own segment.
    expect(extractCdTargets("(cd /home/erfi/repo && make test)")).toEqual([]);
    // Variant that does parse — split on pipes too
    expect(extractCdTargets("true | cd /home/erfi/repo && make test")).toEqual([
      "/home/erfi/repo",
    ]);
  });
  test("skips cd with no arg, cd -, cd /, cd $VAR", () => {
    expect(extractCdTargets("cd && ls")).toEqual([]);
    expect(extractCdTargets("cd - && pwd")).toEqual([]);
    expect(extractCdTargets("cd / && ls")).toEqual([]);
    expect(extractCdTargets("cd $HOME && ls")).toEqual([]);
    expect(extractCdTargets('cd "$REPO_ROOT" && make')).toEqual([]);
  });
  test("no cd in command → empty", () => {
    expect(extractCdTargets("docker compose up -d")).toEqual([]);
    expect(extractCdTargets("ls -la")).toEqual([]);
  });
  test("cd in the middle of a chain that's not segment-aligned is missed (acceptable)", () => {
    // We only match `cd` at segment start. `echo cd foo` is not a real cd.
    expect(extractCdTargets("echo cd /tmp/foo")).toEqual([]);
  });
});

describe("cd-agents-reload.decideTarget", () => {
  const startupLoaded = new Set(["/home/erfi/dotfiles", "/home/erfi", "/"]);
  const warned = new Set<string>();

  test("skips when target is in startup-loaded set (ancestor of session cwd)", () => {
    expect(
      decideTarget({
        target: "/home/erfi",
        startupLoaded,
        alreadyWarned: warned,
        fsExists: () => true,
      }),
    ).toBeNull();
  });
  test("skips when already warned this session", () => {
    expect(
      decideTarget({
        target: "/home/erfi/whisper-transcribe",
        startupLoaded,
        alreadyWarned: new Set(["/home/erfi/whisper-transcribe"]),
        fsExists: () => true,
      }),
    ).toBeNull();
  });
  test("returns AGENTS.md path when present and unloaded", () => {
    const target = "/home/erfi/whisper-transcribe";
    expect(
      decideTarget({
        target,
        startupLoaded,
        alreadyWarned: warned,
        fsExists: (p) => p === `${target}/AGENTS.md`,
      }),
    ).toBe(`${target}/AGENTS.md`);
  });
  test("falls back to CLAUDE.md when AGENTS.md absent", () => {
    const target = "/home/erfi/legacy-repo";
    expect(
      decideTarget({
        target,
        startupLoaded,
        alreadyWarned: warned,
        fsExists: (p) => p === `${target}/CLAUDE.md`,
      }),
    ).toBe(`${target}/CLAUDE.md`);
  });
  test("prefers AGENTS.md over CLAUDE.md when both exist", () => {
    const target = "/home/erfi/both";
    expect(
      decideTarget({
        target,
        startupLoaded,
        alreadyWarned: warned,
        fsExists: () => true,
      }),
    ).toBe(`${target}/AGENTS.md`);
  });
  test("returns null when no instruction file exists", () => {
    expect(
      decideTarget({
        target: "/home/erfi/no-instructions",
        startupLoaded,
        alreadyWarned: warned,
        fsExists: () => false,
      }),
    ).toBeNull();
  });
});

// ── docs: safePath ─────────────────────────────────────────────────────────
//
// docs_* tools target docs.erfi.io over SSH. If the agent passes a LOCAL
// absolute path by mistake (forgetting /docs/<source>/ prefix), the SSH
// command would silently fail with "bash: /docs/home/...: No such file".
// safePath() catches this up front with a clear error.

describe("docs.safePath", () => {
  test("normalises a relative-looking docs source to /docs/<source>/...", () => {
    expect(safePath("supabase/guides/auth.md")).toBe("/docs/supabase/guides/auth.md");
  });
  test("passes through a well-formed /docs/<source>/... path", () => {
    expect(safePath("/docs/postgres/ddl-rowsecurity.md")).toBe("/docs/postgres/ddl-rowsecurity.md");
  });
  test("strips traversal ../ segments", () => {
    expect(safePath("/docs/foo/../bar/baz.md")).toBe("/docs/foo/bar/baz.md");
  });
  test("strips repeated slashes", () => {
    expect(safePath("/docs//foo///bar.md")).toBe("/docs/foo/bar.md");
  });
  test("preserves bare '..' inside legitimate filenames", () => {
    expect(safePath("/docs/mdn/do..while/index.md")).toBe("/docs/mdn/do..while/index.md");
  });
  test("rejects bare local absolute path (/home/...)", () => {
    expect(() => safePath("/home/erfi/gloryhole/notes.md")).toThrow(/local filesystem path/);
  });
  test("rejects /docs-prefixed local absolute path (the actual bug)", () => {
    // This is the scenario from the bug report: resolvePath got
    // /home/erfi/gloryhole/... and safePath used to prepend /docs blindly.
    expect(() => safePath("/docs/home/erfi/gloryhole/docs/plans/foo.md")).toThrow(
      /local filesystem path/,
    );
  });
  test("rejects all common local roots when /docs-prefixed", () => {
    for (const root of ["home", "root", "Users", "etc", "var", "tmp", "opt", "srv", "mnt", "usr", "dev", "proc", "sys", "private"]) {
      expect(() => safePath(`/docs/${root}/foo`)).toThrow(/local filesystem path/);
      expect(() => safePath(`/${root}/foo`)).toThrow(/local filesystem path/);
    }
  });
  test("rejects tilde-prefixed paths (~/foo)", () => {
    expect(() => safePath("~/gloryhole/notes.md")).toThrow(/local filesystem path/);
  });
  test("./-prefixed paths get traversal-stripped then normalised (agent likely meant a docs source)", () => {
    // Defensive: `../foo/bar` gets `../` stripped first, then normalised.
    // We don't reject these — they're ambiguous, not clearly local.
    expect(safePath("../foo/bar.md")).toBe("/docs/foo/bar.md");
  });
  test("error message names the offending input and points at 'read' / docs_sources", () => {
    try {
      safePath("/home/erfi/foo.md");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("/home/erfi/foo.md");
      expect(msg).toContain("'read' tool");
      expect(msg).toContain("docs_sources");
    }
  });
  test("rejects empty / non-string", () => {
    expect(() => safePath("")).toThrow(/required/);
    // @ts-expect-error — intentionally bad input
    expect(() => safePath(undefined)).toThrow(/required/);
  });
});

// ── bg-tasks: decideWaitResult ────────────────────────────────────────

describe("bg-tasks.decideWaitResult", () => {
  const baseState = {
    name: "pi-bg-x-1",
    slug: "x",
    started_at: 1,
    cwd: "/",
    kind: "bash" as const,
    command: "sleep 1",
  };
  test("pattern match wins even if task still running", () => {
    const r = decideWaitResult({
      state: baseState,
      output: "booting...\nlistening on 8080\n",
      live: true,
      pattern: /listening on \d+/,
      untilExit: false,
    });
    expect(r.result).toBe("matched");
    expect(r.matchLine).toBe("listening on 8080");
  });
  test("pattern match wins over completion when both true", () => {
    const r = decideWaitResult({
      state: { ...baseState, completed_at: 5, exit_code: 0 },
      output: "job complete\n",
      live: false,
      pattern: /job complete/,
      untilExit: true,
    });
    expect(r.result).toBe("matched");
  });
  test("untilExit resolves on completion when pattern absent", () => {
    const r = decideWaitResult({
      state: { ...baseState, completed_at: 5, exit_code: 0 },
      output: "",
      live: false,
      untilExit: true,
    });
    expect(r.result).toBe("exited");
  });
  test("pattern given + task exited without match → 'exited' so caller knows it can't match", () => {
    const r = decideWaitResult({
      state: { ...baseState, completed_at: 5, exit_code: 1 },
      output: "some unrelated output\n",
      live: false,
      pattern: /will never appear/,
      untilExit: false,
    });
    expect(r.result).toBe("exited");
  });
  test("still running + no match → pending", () => {
    const r = decideWaitResult({
      state: baseState,
      output: "warming up...\n",
      live: true,
      pattern: /listening/,
      untilExit: false,
    });
    expect(r.result).toBe("pending");
  });
  test("untilExit=false, no pattern, task still running → pending", () => {
    const r = decideWaitResult({
      state: baseState,
      output: "...",
      live: true,
      untilExit: false,
    });
    expect(r.result).toBe("pending");
  });
  test("untilExit=false, no pattern, task done → pending (no condition asked for, never resolves)", () => {
    // Defensive: execute() rejects this combination upstream, but the pure
    // helper must still behave — returning 'pending' lets timeout fire.
    const r = decideWaitResult({
      state: { ...baseState, completed_at: 5, exit_code: 0 },
      output: "done",
      live: false,
      untilExit: false,
    });
    expect(r.result).toBe("pending");
  });
  test("null state + dead tmux pane + untilExit → exited (handles GC'd state)", () => {
    const r = decideWaitResult({
      state: null,
      output: "",
      live: false,
      untilExit: true,
    });
    expect(r.result).toBe("exited");
  });
});

describe("osint.groupByKind", () => {
  test("groups by finding kind, preserves insertion order", () => {
    const out = osint.groupByKind([
      { kind: "a", value: "1" },
      { kind: "b", value: "2" },
      { kind: "a", value: "3" },
    ]);
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect(out.a.map((f) => f.value)).toEqual(["1", "3"]);
    expect(out.b.map((f) => f.value)).toEqual(["2"]);
  });
  test("undefined and empty input return {}", () => {
    expect(osint.groupByKind(undefined)).toEqual({});
    expect(osint.groupByKind([])).toEqual({});
  });
});

describe("osint.metaFooter", () => {
  test("renders sources + elapsed, no errors line when clean", () => {
    const out = osint.metaFooter({
      sources_queried: ["subfinder", "crtsh"],
      elapsed_ms: 1234,
    });
    expect(out).toContain("subfinder, crtsh");
    expect(out).toContain("1234ms");
    expect(out).not.toContain("Issues");
  });
  test("adds Issues line when errors present (truncated to 3)", () => {
    const out = osint.metaFooter({
      sources_queried: [],
      errors: ["e1", "e2", "e3", "e4"],
    });
    expect(out).toContain("(none)"); // empty sources fallback
    expect(out).toContain("Issues: e1; e2; e3");
    expect(out).not.toContain("e4");
  });
  test("appends extras lines", () => {
    const out = osint.metaFooter({ elapsed_ms: 10 }, ["hint A", "hint B"]);
    expect(out).toContain("hint A");
    expect(out).toContain("hint B");
  });
});

describe("osint.formatDomain", () => {
  const inv = {
    entity: "example.com",
    findings: [
      { kind: "dns_record", value: "93.184.216.34", extra: { type: "A" } },
      { kind: "dns_record", value: "2606:2800:220:1::1", extra: { type: "AAAA" } },
      { kind: "dns_record", value: "a.iana-servers.net", extra: { type: "NS" } },
      { kind: "dns_record", value: "b.iana-servers.net", extra: { type: "NS" } },
      { kind: "subdomain", value: "www.example.com" },
      { kind: "subdomain", value: "mail.example.com" },
      { kind: "subdomain", value: "www.example.com" }, // dup — must dedupe
      {
        kind: "certificate",
        value: "sha1",
        extra: {
          total_certs: 42,
          issuer: "DigiCert TLS RSA SHA256 2020 CA1",
          not_before: "2024-01-01T00:00:00",
          not_after: "2025-01-01T00:00:00",
        },
      },
      { kind: "whois_field", value: "RESERVED-Internet", extra: { field: "registrar" } },
      { kind: "whois_field", value: "1995-08-14", extra: { field: "created" } },
      { kind: "whois_field", value: "IGNORED", extra: { field: "random_unwanted" } },
    ],
    sources_queried: ["subfinder"],
    elapsed_ms: 100,
  };
  test("summary mode renders header + sections + dedupes subdomains", () => {
    const out = osint.formatDomain(inv, "summary");
    expect(out).toMatch(/^# Domain investigation: example\.com/);
    expect(out).toContain("## DNS");
    expect(out).toContain("A: 93.184.216.34");
    expect(out).toContain("## Subdomains (2 unique)");
    expect(out).toContain("mail.example.com, www.example.com"); // sorted
    expect(out).toContain("## Certificates (crt.sh)");
    expect(out).toContain("Total: 42");
    expect(out).toContain("Valid 2024-01-01 \u2192 2025-01-01");
    expect(out).toContain("registrar=RESERVED-Internet");
    expect(out).not.toContain("random_unwanted"); // unknown WHOIS fields dropped
  });
  test("summary mode caps subdomains at 15 with 'showing X of Y' note", () => {
    const many = {
      entity: "e.com",
      findings: Array.from({ length: 30 }, (_, i) => ({
        kind: "subdomain",
        value: `s${String(i).padStart(2, "0")}.e.com`,
      })),
    };
    const out = osint.formatDomain(many, "summary");
    expect(out).toContain("## Subdomains (30 unique)");
    expect(out).toContain("showing 15 of 30");
    expect(out).toContain('mode="full"');
  });
  test("full mode emits every subdomain, no truncation note", () => {
    const many = {
      entity: "e.com",
      findings: Array.from({ length: 30 }, (_, i) => ({
        kind: "subdomain",
        value: `s${String(i).padStart(2, "0")}.e.com`,
      })),
    };
    const out = osint.formatDomain(many, "full");
    expect(out).not.toContain("showing 15 of");
    expect(out).toContain("s29.e.com");
  });
  test("empty findings still renders header + footer", () => {
    const out = osint.formatDomain({ entity: "e.com" }, "summary");
    expect(out).toContain("# Domain investigation: e.com");
    expect(out).toContain("_Sources:");
  });
});

describe("osint.formatIp", () => {
  test("separates CVE tags from plain tags, sorts + dedupes ports", () => {
    const out = osint.formatIp({
      entity: "1.2.3.4",
      findings: [
        {
          kind: "geolocation",
          value: "US",
          extra: { country: "US", city: "Ashburn", org: "Amazon" },
        },
        { kind: "hostname", value: "a.example" },
        { kind: "hostname", value: "a.example" }, // dup
        { kind: "open_port", value: "443" },
        { kind: "open_port", value: "22" },
        { kind: "open_port", value: "443" }, // dup
        { kind: "vuln_tag", value: "self-signed" },
        { kind: "vuln_tag", value: "CVE-2024-1234", extra: { is_cve: true } },
      ],
    });
    expect(out).toContain("US \u00b7 Ashburn \u00b7 Amazon");
    expect(out).toContain("## Hostnames\na.example");
    expect(out).toContain("## Open ports");
    expect(out).toMatch(/22, 443/); // sorted asc, deduped
    expect(out).toContain("## Tags\nself-signed");
    expect(out).toContain("## CVEs\nCVE-2024-1234");
  });
  test("caps shared_host at 15 with CDN hint", () => {
    const out = osint.formatIp({
      entity: "1.1.1.1",
      findings: Array.from({ length: 50 }, (_, i) => ({
        kind: "shared_host",
        value: `host${String(i).padStart(3, "0")}.example`,
      })),
    });
    expect(out).toContain("## Shared hosts (50 unique)");
    expect(out).toContain("showing 15 of 50");
    expect(out).toContain("may be a shared CDN");
  });
});

describe("osint.formatEmail", () => {
  test("renders Holehe hits + HIBP breaches", () => {
    const out = osint.formatEmail({
      entity: "a@b.com",
      findings: [
        { kind: "platform_registration", value: "github" },
        { kind: "platform_registration", value: "twitter" },
        {
          kind: "breach",
          value: "linkedin-2012",
          extra: {
            title: "LinkedIn",
            breach_date: "2012-05-05",
            pwn_count: 164_611_595,
            data_classes: ["emails", "passwords", "a", "b", "c", "d"],
          },
        },
      ],
      sources_queried: ["holehe", "haveibeenpwned"],
    });
    expect(out).toContain("Registered on 2 services");
    expect(out).toContain("github, twitter");
    expect(out).toContain("Breaches (HIBP) \u2014 1 known");
    expect(out).toContain("**LinkedIn**");
    expect(out).toContain("164611595 accounts");
    // data_classes capped at 5
    expect(out).toContain("emails, passwords, a, b, c");
    expect(out).not.toMatch(/, d\b/);
  });
  test("HIBP-not-queried: hints at missing API key", () => {
    const out = osint.formatEmail({
      entity: "a@b.com",
      sources_queried: ["holehe"], // no haveibeenpwned
    });
    expect(out).toContain("No platform registrations");
    expect(out).toContain("HIBP_API_KEY");
  });
  test("HIBP queried but no breaches: explicit 'No breaches found'", () => {
    const out = osint.formatEmail({
      entity: "a@b.com",
      sources_queried: ["holehe", "haveibeenpwned"],
    });
    expect(out).toContain("No breaches found");
  });
});

describe("osint.formatUsername", () => {
  test("fast mode caps at 30, hints at show_all + deep mode", () => {
    const accounts = Array.from({ length: 50 }, (_, i) => ({
      kind: "account",
      value: `https://example.com/u${i}`,
      extra: { platform: `site${i}` },
    }));
    const out = osint.formatUsername(
      { entity: "alice", findings: accounts },
      "fast",
      false,
    );
    expect(out).toContain("(fast)");
    expect(out).toContain("(50 hits)");
    expect(out).toContain("showing top 30, pass show_all=true");
    expect(out).toContain("site29"); // boundary, included
    expect(out).not.toContain("site30"); // first dropped
    expect(out).toContain('Run with mode="deep"'); // hint only in fast mode
  });
  test("deep mode + show_all dumps everything, no deep-hint", () => {
    const accounts = Array.from({ length: 50 }, (_, i) => ({
      kind: "account",
      value: `https://example.com/u${i}`,
      extra: { platform: `site${i}` },
    }));
    const out = osint.formatUsername(
      { entity: "alice", findings: accounts },
      "deep",
      true,
    );
    expect(out).toContain("site49");
    expect(out).not.toContain("showing top");
    expect(out).not.toContain('mode="deep"');
  });
  test("no accounts: explicit message", () => {
    const out = osint.formatUsername({ entity: "alice" }, "fast", false);
    expect(out).toContain("No accounts found");
  });
});

describe("osint.formatThreat", () => {
  test("verdict line reflects malicious > suspicious > clean", () => {
    const mk = (m: number, s: number) =>
      osint.formatThreat({
        entity: "sha",
        entity_kind: "hash",
        findings: [
          {
            kind: "reputation",
            value: "sha",
            extra: { malicious: m, suspicious: s, harmless: 50, undetected: 10, total: 70 },
          },
        ],
      });
    expect(mk(3, 1)).toContain("\u26a0 malicious");
    expect(mk(0, 2)).toContain("? suspicious");
    expect(mk(0, 0)).toContain("clean");
  });
  test("missing VT_API_KEY info \u2192 explicit explanation", () => {
    const out = osint.formatThreat({
      entity: "x",
      entity_kind: "hash",
      info: ["vt: VT_API_KEY not set"],
    });
    expect(out).toContain("VT_API_KEY not set");
  });
  test("unclassifiable target \u2192 'could not auto-detect' message", () => {
    const out = osint.formatThreat({
      entity: "???",
      entity_kind: "unknown",
      info: ["vt: could not classify"],
    });
    expect(out).toContain("Could not auto-detect");
  });
  test("facts and tags rendered when present", () => {
    const out = osint.formatThreat({
      entity: "hash",
      entity_kind: "hash",
      findings: [
        {
          kind: "reputation",
          value: "x",
          extra: {
            malicious: 1,
            suspicious: 0,
            harmless: 0,
            total: 1,
            magic: "PE32 executable",
            size: 4096,
            tags: ["signed", "upx"],
          },
        },
      ],
    });
    expect(out).toContain("type: PE32 executable");
    expect(out).toContain("size (B): 4096");
    expect(out).toContain("## Tags\nsigned, upx");
  });
});

describe("osint.formatCve", () => {
  test("renders score, severity, dates, truncates long description", () => {
    const longDesc = "a".repeat(900);
    const out = osint.formatCve({
      entity: "CVE-2021-44228",
      findings: [
        {
          kind: "cve",
          value: "CVE-2021-44228",
          extra: {
            cvss_score: 10.0,
            cvss_severity: "CRITICAL",
            cvss_version: "3.1",
            cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
            published: "2021-12-10T10:15:00",
            modified: "2024-02-01T00:00:00",
            description: longDesc,
            cwes: ["CWE-20", "CWE-502"],
            references: ["https://nvd.nist.gov/x", "https://logging.apache.org/log4j"],
            ref_total: 99,
          },
        },
      ],
    });
    expect(out).toContain("# CVE lookup: CVE-2021-44228");
    expect(out).toContain("CVSS v3.1: **10 (CRITICAL)**");
    expect(out).toContain("Published: 2021-12-10");
    expect(out).toContain("Modified: 2024-02-01");
    expect(out).toContain("\u2026"); // ellipsis on truncated description
    // proves trimming happened: the description SECTION should be capped at
    // ~700 chars + ellipsis, well under the 900-char input.
    const descSection = out.split("## Description\n")[1].split("\n\n")[0];
    expect(descSection.length).toBeLessThanOrEqual(701); // 700 + ellipsis
    expect(out).toContain("CWE-20, CWE-502");
    expect(out).toContain("## References (99)");
    expect(out).toContain("showing 5 of 99"); // only 2 refs given, but ref_total > cap
  });
  test("invalid CVE id \u2192 format hint", () => {
    const out = osint.formatCve({
      entity: "foo",
      info: ["nvd: not a valid CVE id"],
    });
    expect(out).toContain("not a valid CVE id");
    expect(out).toContain("CVE-YYYY-NNNNN");
  });
  test("unknown CVE \u2192 'no record' message", () => {
    const out = osint.formatCve({
      entity: "CVE-9999-99999",
      info: ["nvd: no record for"],
    });
    expect(out).toContain("NVD has no record");
  });
});

describe("osint.formatHarvest", () => {
  test("renders emails + hosts sections with cap-at-30", () => {
    const out = osint.formatHarvest({
      entity: "e.com",
      findings: [
        ...Array.from({ length: 40 }, (_, i) => ({
          kind: "harvested_email",
          value: `u${String(i).padStart(2, "0")}@e.com`,
        })),
        { kind: "harvested_host", value: "a.e.com" },
        { kind: "harvested_host", value: "b.e.com" },
      ],
    });
    expect(out).toContain("## Emails (40)");
    expect(out).toContain("showing 30 of 40");
    expect(out).toContain("## Hosts (2)");
    expect(out).toContain("a.e.com, b.e.com");
  });
  test("empty harvest \u2192 explicit message", () => {
    const out = osint.formatHarvest({ entity: "e.com" });
    expect(out).toContain("No emails or hosts harvested");
  });
});

describe("osint.formatUrl", () => {
  test("empty scans \u2192 submit hint", () => {
    const out = osint.formatUrl({ entity: "https://e.com" });
    expect(out).toContain("No urlscan.io scans found");
    expect(out).toContain("`submit=true`");
  });
  test("renders scan results with malicious badge", () => {
    const out = osint.formatUrl({
      entity: "https://e.com",
      findings: [
        {
          kind: "scan_result",
          value: "scan1",
          extra: {
            url: "https://e.com/path",
            ip: "1.2.3.4",
            country: "US",
            asn: "AS13335",
            asnname: "Cloudflare",
            scan_time: "2025-01-01",
            malicious: true,
          },
        },
      ],
    });
    expect(out).toContain("https://e.com/path");
    expect(out).toContain("AS13335 Cloudflare");
    expect(out).toContain("\u26a0 malicious");
  });
});

describe("osint.formatPhone", () => {
  test("empty findings \u2192 free-tier hint", () => {
    const out = osint.formatPhone({ entity: "+14155551234" });
    expect(out).toContain("No data returned");
    expect(out).toContain("API keys");
  });
  test("groups fields by scanner, drops null/empty/empty-array values", () => {
    const out = osint.formatPhone({
      entity: "+14155551234",
      findings: [
        {
          kind: "phone_info",
          value: "local",
          extra: {
            scanner: "local",
            valid: true,
            country: "US",
            blank: "",
            nothing: null,
            empties: [],
          },
        },
        {
          kind: "phone_info",
          value: "truecaller",
          extra: { scanner: "truecaller", carrier: "Verizon" },
        },
      ],
    });
    expect(out).toContain("## local");
    expect(out).toContain("valid: true");
    expect(out).toContain("country: \"US\"");
    expect(out).not.toContain("blank");
    expect(out).not.toContain("nothing");
    expect(out).not.toContain("empties");
    expect(out).toContain("## truecaller");
    expect(out).toContain("carrier: \"Verizon\"");
  });
});

describe("osint.authHeaders", () => {
  const orig = process.env.RESEARCH_TOKEN;
  test("empty when token unset", () => {
    delete process.env.RESEARCH_TOKEN;
    expect(osint.authHeaders()).toEqual({});
  });
  test("populated when token set, trimmed", () => {
    process.env.RESEARCH_TOKEN = "  secret123  ";
    expect(osint.authHeaders()).toEqual({ authorization: "Bearer secret123" });
    // restore
    if (orig === undefined) delete process.env.RESEARCH_TOKEN;
    else process.env.RESEARCH_TOKEN = orig;
  });
});

// ── clipboard-image-shrink: pure helpers ──────────────────────────────────

describe("clipboard-image-shrink.shrunkSibling", () => {
  test("appends -small before extension (png)", () => {
    expect(
      shrunkSibling("/tmp/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png"),
    ).toBe("/tmp/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-small.png");
  });
  test("preserves jpg extension", () => {
    expect(
      shrunkSibling("/tmp/pi-clipboard-11111111-2222-3333-4444-555555555555.jpg"),
    ).toBe("/tmp/pi-clipboard-11111111-2222-3333-4444-555555555555-small.jpg");
  });
});

describe("clipboard-image-shrink.rewriteClipboardPaths", () => {
  test("text without any clipboard path returns unchanged", async () => {
    const { text, decisions } = await rewriteClipboardPaths("hello, no images here", null);
    expect(text).toBe("hello, no images here");
    expect(decisions).toEqual([]);
  });

  test("nonexistent clipboard path is a no-op (skip, not rewrite)", async () => {
    // Path looks clipboard-shaped but doesn't exist → decision is no-op.
    const fake = "/tmp/pi-clipboard-deadbeef-dead-beef-dead-beefdeadbeef.png";
    const { text, decisions } = await rewriteClipboardPaths(`look at ${fake}`, null);
    expect(text).toBe(`look at ${fake}`);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision.shrunk).toBe(false);
  });

  test("non-clipboard /tmp paths are ignored", async () => {
    // Plain /tmp/foo.png doesn't match the UUID-shaped clipboard regex.
    const txt = "see /tmp/foo.png and /tmp/pi-clipboard-not-a-uuid.png";
    const { text, decisions } = await rewriteClipboardPaths(txt, null);
    expect(text).toBe(txt);
    expect(decisions).toEqual([]);
  });

  test("duplicate paths in one message dedupe to one decision", async () => {
    const p = "/tmp/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
    const { decisions } = await rewriteClipboardPaths(`${p} and again ${p}`, null);
    expect(decisions).toHaveLength(1);
  });

  test("matches all five supported extensions", async () => {
    const base = "/tmp/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const txt = [`${base}.png`, `${base}.jpg`, `${base}.jpeg`, `${base}.webp`, `${base}.gif`].join(
      " ",
    );
    const { decisions } = await rewriteClipboardPaths(txt, null);
    expect(decisions).toHaveLength(5);
  });
});

// ── tool-output-prune: pure algorithm ──────────────────────────────

/** Build a fake toolResult message with `size` bytes of text content. */
function toolResult(toolName: string, size: number, callId = "call_x"): AnyMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId: callId,
    content: [{ type: "text", text: "x".repeat(size) }],
  };
}

function firstTextPart(m: AnyMessage): string {
  if (!Array.isArray(m.content)) return "";
  const p = m.content[0] as { type?: string; text?: string };
  return p?.type === "text" ? p.text ?? "" : "";
}

describe("tool-output-prune.prune", () => {
  test("empty messages array → no-op", () => {
    const stats = prune([]);
    expect(stats).toEqual({ prunedCount: 0, reclaimedBytes: 0, keptNewest: false });
  });

  test("single tool result is ALWAYS kept, even when >protectBytes (the regression fix)", () => {
    // 200KB single result, protect window 160KB. Old algorithm would prune.
    const msgs: AnyMessage[] = [toolResult("read", 200_000)];
    const before = firstTextPart(msgs[0]);
    const stats = prune(msgs, { protectBytes: 160_000 });
    expect(stats.prunedCount).toBe(0);
    expect(stats.reclaimedBytes).toBe(0);
    expect(stats.keptNewest).toBe(true);
    expect(firstTextPart(msgs[0])).toBe(before); // unchanged
  });

  test("newest result protected, older results pruned when over budget", () => {
    // Newest (last in array) is 200KB; older 100KB pushes cumulative over
    // the 160KB window once the newest is protected (newest doesn't count).
    // After protecting newest: cumulative=0, then older 100KB → fits (cum=100K).
    // Add ANOTHER 100KB older: 100K+100K=200K > 160K → pruned.
    const msgs: AnyMessage[] = [
      toolResult("bash", 100_000, "old1"),  // oldest
      toolResult("bash", 100_000, "old2"),
      toolResult("read", 200_000, "newest"), // newest
    ];
    const stats = prune(msgs, { protectBytes: 160_000 });
    expect(stats.keptNewest).toBe(true);
    expect(stats.prunedCount).toBe(1);
    expect(firstTextPart(msgs[2])).toBe("x".repeat(200_000)); // newest untouched
    expect(firstTextPart(msgs[1])).toBe("x".repeat(100_000)); // 2nd-newest fits
    expect(firstTextPart(msgs[0])).toMatch(/\[tool-output-prune\] bash/); // oldest pruned
  });

  test("protected tool names skipped entirely, don't consume newest slot", () => {
    // `memory` is in PROTECTED_TOOLS — it should be skipped in the iteration,
    // so the newest non-protected result still counts as `keptNewest`.
    const msgs: AnyMessage[] = [
      toolResult("bash", 50_000, "big-old"),
      toolResult("bash", 200_000, "big-newer"),
      toolResult("memory", 500_000, "newest-but-protected"),
    ];
    const stats = prune(msgs, { protectBytes: 100_000 });
    // memory message untouched (protected by name)
    expect(firstTextPart(msgs[2])).toBe("x".repeat(500_000));
    // the bash 200KB result IS the newest non-protected → kept
    expect(firstTextPart(msgs[1])).toBe("x".repeat(200_000));
    // the bash 50KB result is older; cumulative(0)+50K=50K ≤ 100K → kept
    expect(firstTextPart(msgs[0])).toBe("x".repeat(50_000));
    expect(stats.keptNewest).toBe(true);
    expect(stats.prunedCount).toBe(0);
  });

  test("already-pruned messages are idempotent (no double-prune)", () => {
    const alreadyPrunedMarker: AnyMessage = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "old",
      content: [{ type: "text", text: "[tool-output-prune] bash — 50KB of output pruned" }],
    };
    const msgs: AnyMessage[] = [
      alreadyPrunedMarker,
      toolResult("read", 50_000, "newest"),
    ];
    const stats = prune(msgs, { protectBytes: 10_000 });
    expect(stats.prunedCount).toBe(0);
    expect(stats.keptNewest).toBe(true);
    // already-pruned msg unchanged
    expect(firstTextPart(msgs[0])).toMatch(/^\[tool-output-prune\]/);
  });

  test("empty content / non-toolResult messages skipped", () => {
    const msgs: AnyMessage[] = [
      { role: "user", content: "hello" },
      { role: "toolResult", toolName: "bash", content: [] },
      toolResult("read", 200_000, "newest"),
    ];
    const stats = prune(msgs, { protectBytes: 1000 });
    expect(stats.keptNewest).toBe(true);
    expect(stats.prunedCount).toBe(0); // nothing eligible to prune
  });

  test("custom protectBytes honored", () => {
    const msgs: AnyMessage[] = [
      toolResult("bash", 5_000, "old1"),
      toolResult("bash", 5_000, "old2"),
      toolResult("bash", 5_000, "old3"),
      toolResult("read", 100_000, "newest"),
    ];
    // Tight 8KB window: newest protected (free), then 5K fits (cum=5K),
    // then 5K → cum 10K > 8K → pruned, then 5K → same fate.
    const stats = prune(msgs, { protectBytes: 8_000 });
    expect(stats.keptNewest).toBe(true);
    expect(stats.prunedCount).toBe(2);
    expect(firstTextPart(msgs[3])).toBe("x".repeat(100_000));
    expect(firstTextPart(msgs[2])).toBe("x".repeat(5_000));
    expect(firstTextPart(msgs[1])).toMatch(/\[tool-output-prune\]/);
    expect(firstTextPart(msgs[0])).toMatch(/\[tool-output-prune\]/);
  });

  test("keptNewest=false when no tool results exist", () => {
    const msgs: AnyMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const stats = prune(msgs);
    expect(stats.keptNewest).toBe(false);
  });
});

// ── slash-typo-guard ──────────────────────────────────────────────────────

describe("slash-typo-guard.levenshtein", () => {
  test("equal strings → 0", () => {
    expect(levenshtein("quit", "quit")).toBe(0);
  });
  test("empty vs non-empty → length", () => {
    expect(levenshtein("", "quit")).toBe(4);
    expect(levenshtein("quit", "")).toBe(4);
  });
  test("single insertion", () => {
    expect(levenshtein("quit", "qauit")).toBe(1); // /qauit → /quit
  });
  test("single transposition counts as 2", () => {
    expect(levenshtein("quti", "quit")).toBe(2); // pure Levenshtein, no Damerau
  });
  test("compaction typo", () => {
    expect(levenshtein("comapct", "compact")).toBe(2); // transposition
    expect(levenshtein("compac", "compact")).toBe(1);
  });
  test("far apart", () => {
    expect(levenshtein("hotkeys", "quit")).toBeGreaterThan(2);
  });
});

describe("slash-typo-guard.closestCommand", () => {
  const known = new Set([
    "quit", "compact", "model", "settings", "tree", "fork", "clone",
    "new", "name", "session", "resume", "reload", "hotkeys", "changelog",
  ]);

  test("/qauit → /quit (dist 1)", () => {
    expect(closestCommand("qauit", known)).toEqual({ name: "quit", dist: 1 });
  });
  test("/comapct → /compact (dist 2)", () => {
    expect(closestCommand("comapct", known)).toEqual({ name: "compact", dist: 2 });
  });
  test("/quti → /quit (dist 2)", () => {
    expect(closestCommand("quti", known)).toEqual({ name: "quit", dist: 2 });
  });
  test("/foo at dist 2 finds /fork (caller must restrict for short cmds)", () => {
    // 3-letter 'foo' is 2 edits from 'fork' (insert 'r', insert 'k').
    // closestCommand itself returns it at default maxDist=2; the input
    // handler protects against false positives by passing maxDist=1
    // for cmd.length ≤ 3.
    expect(closestCommand("foo", known)).toEqual({ name: "fork", dist: 2 });
    expect(closestCommand("foo", known, 1)).toBeNull();
  });
  test("/dance → null (intentional plain text)", () => {
    expect(closestCommand("dance", known)).toBeNull();
  });
  test("exact match returns dist 0", () => {
    expect(closestCommand("quit", known)).toEqual({ name: "quit", dist: 0 });
  });
  test("respects custom maxDist", () => {
    // "quti" → "quit" is 2 edits; with maxDist=1 should reject.
    expect(closestCommand("quti", known, 1)).toBeNull();
  });
  test("length pre-filter doesn't hide near matches", () => {
    // "newm" → "new" is 1, "name" is 2 → should pick "new"
    expect(closestCommand("newm", known)).toEqual({ name: "new", dist: 1 });
  });
  test("ties broken by name for stability", () => {
    const small = new Set(["aaa", "bbb"]);
    // "ccc" is dist 3 from both, beyond default maxDist → null
    expect(closestCommand("ccc", small)).toBeNull();
    // "aab" is dist 1 from "aaa", dist 2 from "bbb" → "aaa"
    expect(closestCommand("aab", small)).toEqual({ name: "aaa", dist: 1 });
  });
});

// ── stuck-state-recovery: shouldAbort decision ─────────────────────────

describe("stuck-state-recovery.shouldAbort", () => {
  test("idle pi → no abort (healthy state)", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: true, sinceActivityMs: 100 })).toBe(false);
  });
  test("idle + long silence → no abort (idle is the real signal)", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: true, sinceActivityMs: 999_999 })).toBe(false);
  });
  test("non-idle + recent activity → no abort (legit streaming, allow steer)", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: false, sinceActivityMs: 2_000 })).toBe(false);
  });
  test("non-idle + just-under-grace → no abort (boundary)", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: false, sinceActivityMs: LAST_ACTIVITY_GRACE_MS - 1 })).toBe(false);
  });
  test("non-idle + just-over-grace → ABORT (wedged stream, force-clean)", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: false, sinceActivityMs: LAST_ACTIVITY_GRACE_MS + 1 })).toBe(true);
  });
  test("non-idle + 60s silence → ABORT (definitively wedged)", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: false, sinceActivityMs: 60_000 })).toBe(true);
  });
  test("extension-source input never aborts (avoid feedback loops)", () => {
    expect(stuckShouldAbort({ source: "extension", idle: false, sinceActivityMs: 60_000 })).toBe(false);
  });
  test("rpc-source input never aborts (caller controls its own state)", () => {
    expect(stuckShouldAbort({ source: "rpc", idle: false, sinceActivityMs: 60_000 })).toBe(false);
  });
  test("custom graceMs override honored", () => {
    expect(stuckShouldAbort({ source: "interactive", idle: false, sinceActivityMs: 1_000, graceMs: 500 })).toBe(true);
    expect(stuckShouldAbort({ source: "interactive", idle: false, sinceActivityMs: 1_000, graceMs: 2_000 })).toBe(false);
  });
});
