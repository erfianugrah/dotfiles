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
  checkReformulationLoop,
  stripAnsiCSpans,
} from "../extensions/tool-guard.ts";
import { parsePatch, renderApplyDiffs } from "../extensions/apply-patch.ts";
import {
  HARD_CAP_BYTES,
  SOFT_WARN_BYTES,
  SIDECAR_SUFFIX,
  sidecarPath,
  validateChunk,
} from "../extensions/write-stream.ts";
import { parseImage, versionCompare } from "../extensions/oci-tags.ts";
import {
  resolveMediaPath,
  bundleCacheKey,
  mergeUtterances,
  computeOverlap,
  hhmmss,
  parseNameMap,
  applyNameMap,
  type Segment,
  type Bundle,
} from "../extensions/video-review.ts";
import {
  dateFromName,
  extractText,
  formatHit,
  tokenise,
} from "../extensions/session-search.ts";
import {
  toFtsQuery,
  recordSessionName,
  clearSessionName,
  lookupSessionName,
} from "../extensions/session-fts/index.ts";
import {
	isDegenerateSummary,
	ftsQuery as ledgerFtsQuery,
	buildInjectionBlock,
	isReadOnlySql,
	serializeEntriesForSummary,
	extractCompletionText,
} from "../extensions/session-ledger/index.ts";
import { parseOsvJson } from "../extensions/osv-scan.ts";
import { parsePdffonts, assessText, chooseStrategy, sortPageFiles } from "../extensions/pdf.ts";
import { parseGitleaksJson, parseNoseyparkerJsonl } from "../extensions/secret-scan.ts";
import { parseHurlJson } from "../extensions/hurl-test.ts";
import { parseGoTestJson } from "../extensions/go-test.ts";
import { parseHyperfineJson } from "../extensions/bench.ts";
import { fmtDuration, makeSlug, makeSessionName, decideWaitResult, computeStatusLabel } from "../extensions/bg-tasks.ts";
import { decideInjection, matchesIntent, looksLikeSpec } from "../extensions/superpowers.ts";
import { _internals as osint } from "../extensions/osint.ts";
import { safePath, rankByTokenHits } from "../extensions/docs.ts";
import {
  scan as scanAsciiPunct,
  isProsePath as isAsciiProsePath,
  WRITE_BASH as ASCII_WRITE_BASH,
} from "../extensions/ascii-punctuation-guard.ts";
import { extractCdTargets, decideTarget } from "../extensions/cd-agents-reload.ts";
import { rewriteClipboardPaths, shrunkSibling } from "../extensions/clipboard-image-shrink.ts";
import { prune, hasImageContent, type AnyMessage } from "../extensions/tool-output-prune.ts";
import { levenshtein, closestCommand } from "../extensions/slash-typo-guard.ts";
import { matchHints, renderHint, HINTS } from "../extensions/bash-error-hints.ts";
import { findLastUserEntryId } from "../extensions/session-undo.ts";
import {
  isCommitPersist,
  scanForBlocked,
  resolveBashCwd,
  extractMessageFilePaths,
  collectCommitPayload,
} from "../extensions/confidential-write-guard.ts";

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

// ── tool-guard: ANSI-C span stripping (unicode_escape_in_bash exemption) ───
describe("tool-guard.stripAnsiCSpans", () => {
  // The unicode_escape_in_bash rule blocks \uXXXX outside $'...' but must
  // exempt escapes INSIDE $'...' (bash interprets those). The predicate is
  // /\\u[0-9a-fA-F]{4}/.test(stripAnsiCSpans(seg)) -- mirror it here.
  const blocks = (seg: string) => /\\u[0-9a-fA-F]{4}/.test(stripAnsiCSpans(seg));
  const BS = "\\u2014"; // literal backslash + u2014
  const BS2 = "\\u2026";

  test("strips a single ANSI-C span", () => {
    expect(stripAnsiCSpans(`printf $'${BS}'`)).toBe("printf ");
  });

  test("strips multiple escapes within one span", () => {
    expect(stripAnsiCSpans(`echo $'${BS}|${BS2}'`)).toBe("echo ");
  });

  test("leaves double-quoted text intact", () => {
    const s = `echo "${BS}"`;
    expect(stripAnsiCSpans(s)).toBe(s);
  });

  test("FOOTGUN: double-quoted escape in commit msg still blocks", () => {
    expect(blocks(`git commit -m "fix ${BS} thing"`)).toBe(true);
  });

  test("ANSI-C multi-escape no longer false-positives", () => {
    expect(blocks(`grep -nP $'${BS}|${BS2}' f.md`)).toBe(false);
  });

  test("ANSI-C single escape exempt", () => {
    expect(blocks(`printf $'${BS}'`)).toBe(false);
  });

  test("mixed: ANSI-C ok but double-quoted escape present -> blocks", () => {
    expect(blocks(`echo $'a${BS}b' && echo "${BS}"`)).toBe(true);
  });

  test("no backslash before u is not a match", () => {
    expect(blocks(`rg -c 'u2014' file`)).toBe(false);
  });
});

// ── tool-guard: apply_patch path extraction ────────────────────────

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

// ── tool-guard: reformulation-loop guard ──────────────────────────────────

describe("tool-guard.checkReformulationLoop", () => {
  let n = 0;
  const freshKey = () => `sess-${Date.now()}-${n++}`;

  test("docs_search reworded 4× fires the loop", () => {
    const k = freshKey();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toMatch(/Reformulation loop/);
  });

  test("docs_grep is a drill-in: does NOT count and resets the counter", () => {
    const k = freshKey();
    // Three fruitless docs_search then the prescribed zero-results escalation.
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    // docs_grep must be allowed (it is the escalation, not a reword) and
    // must reset the loop counter like any other drill-in.
    expect(checkReformulationLoop("docs_grep", k)).toBeNull();
    // After the drill-in the counter is clear, so a follow-up search is fine.
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
  });

  test("a drill-in clears the counter so the next search is not the 4th", () => {
    const k = freshKey();
    // Without the drill-in the 4th call would fire (see test above).
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
    // docs_read is a drill-in: it resets lastDrillInTs.
    expect(checkReformulationLoop("docs_read", k)).toBeNull();
    // The post-drill-in search starts a fresh window instead of being the 4th.
    expect(checkReformulationLoop("docs_search", k)).toBeNull();
  });

  test("loop message points at docs_grep as the zero-results escalation", () => {
    const k = freshKey();
    checkReformulationLoop("docs_search", k);
    checkReformulationLoop("docs_search", k);
    checkReformulationLoop("docs_search", k);
    const msg = checkReformulationLoop("docs_search", k);
    expect(msg).toContain("docs_grep");
  });

  test("non-search tools are ignored entirely", () => {
    const k = freshKey();
    expect(checkReformulationLoop("bash", k)).toBeNull();
    expect(checkReformulationLoop("edit", k)).toBeNull();
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

// ── apply-patch: renderApplyDiffs ─────────────────────────────────────────

describe("apply-patch.renderApplyDiffs", () => {
  // Recognizable stub standing in for pi's bundled generateDiffString. Lets us
  // assert the wiring (which files get diffed, with what content) without
  // depending on pi's exact diff format.
  const stubDiff = (oldC: string, newC: string) => `DIFF(${oldC.length}->${newC.length})`;

  test("renders a diff block for update ops", () => {
    const out = renderApplyDiffs(
      [{ relPath: "src/foo.ts", oldContent: "old", newContent: "newer", isNew: false }],
      stubDiff,
    );
    expect(out).toBe("### src/foo.ts\nDIFF(3->5)");
  });

  test("skips add ops (isNew) — model already knows new file content", () => {
    const out = renderApplyDiffs(
      [{ relPath: "new.ts", oldContent: "", newContent: "brand new", isNew: true }],
      stubDiff,
    );
    expect(out).toBe("");
  });

  test("skips empty/whitespace-only diffs", () => {
    const out = renderApplyDiffs(
      [{ relPath: "x.ts", oldContent: "a", newContent: "a", isNew: false }],
      () => "   \n  ",
    );
    expect(out).toBe("");
  });

  test("joins multiple update blocks with a blank line, drops adds", () => {
    const out = renderApplyDiffs(
      [
        { relPath: "a.ts", oldContent: "1", newContent: "22", isNew: false },
        { relPath: "b.ts", oldContent: "", newContent: "x", isNew: true },
        { relPath: "c.ts", oldContent: "333", newContent: "4444", isNew: false },
      ],
      stubDiff,
    );
    expect(out).toBe("### a.ts\nDIFF(1->2)\n\n### c.ts\nDIFF(3->4)");
  });

  test("returns empty string when no files", () => {
    expect(renderApplyDiffs([], stubDiff)).toBe("");
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

describe("session-search.formatHit", () => {
  const base = { sessionPath: "/s/2026-07-06_x.jsonl", date: "2026-07-06", role: "user", snippet: "hi" };

  test("omits name tag when no name set", () => {
    const out = formatHit(base, 0);
    expect(out).toBe(`1. [2026-07-06] user\n   /s/2026-07-06_x.jsonl\n   hi`);
    expect(out).not.toContain('"');
  });

  test("includes quoted name when present", () => {
    const out = formatHit({ ...base, name: "docs review" }, 2);
    expect(out).toBe(`3. [2026-07-06] user "docs review"\n   /s/2026-07-06_x.jsonl\n   hi`);
  });
});

describe("session-fts.session_names round-trip", () => {
  // getAgentDir is stubbed to /tmp/pi-test-agent-dir by preload.ts, so these
  // hit a real bun:sqlite DB there. Unique paths keep the assertions isolated.
  const p = `/tmp/sess-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;

  test("record then lookup returns the name", () => {
    recordSessionName(p, "my session");
    expect(lookupSessionName(p)).toBe("my session");
  });

  test("record again upserts (latest name wins)", () => {
    recordSessionName(p, "renamed");
    expect(lookupSessionName(p)).toBe("renamed");
  });

  test("clear removes the name", () => {
    clearSessionName(p);
    expect(lookupSessionName(p)).toBeUndefined();
  });

  test("lookup of unknown path is undefined", () => {
    expect(lookupSessionName("/tmp/never-set.jsonl")).toBeUndefined();
  });
});

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

// ── pdf: parsePdffonts / assessText / chooseStrategy / sortPageFiles ──

describe("pdf.parsePdffonts", () => {
  const BORN = [
    "name                                 type              encoding         emb sub uni object ID",
    "------------------------------------ ----------------- ---------------- --- --- --- ---------",
    "BUGWMD+Times-Roman                   Type 1C           WinAnsi          yes yes yes      7  0",
  ].join("\n");
  const SCANNED = [
    "name                                 type              encoding         emb sub uni object ID",
    "------------------------------------ ----------------- ---------------- --- --- --- ---------",
  ].join("\n");

  test("born-digital PDF has a text layer", () => {
    const r = parsePdffonts(BORN);
    expect(r.hasTextLayer).toBe(true);
    expect(r.fonts).toEqual(["BUGWMD+Times-Roman"]);
  });

  test("scanned PDF (header only) has no text layer", () => {
    const r = parsePdffonts(SCANNED);
    expect(r.hasTextLayer).toBe(false);
    expect(r.fonts).toEqual([]);
  });

  test("empty output has no text layer", () => {
    expect(parsePdffonts("").hasTextLayer).toBe(false);
  });

  test("multiple fonts are all captured", () => {
    const raw = `${BORN}\nABCDEF+Helvetica                     TrueType          Custom           yes yes yes      9  0`;
    const r = parsePdffonts(raw);
    expect(r.fonts).toEqual(["BUGWMD+Times-Roman", "ABCDEF+Helvetica"]);
    expect(r.hasTextLayer).toBe(true);
  });
});

describe("pdf.assessText", () => {
  test("counts words and flags non-empty", () => {
    expect(assessText("  hello  world  ")).toEqual({ chars: 12, words: 2, nonEmpty: true });
  });
  test("empty / whitespace-only is empty", () => {
    expect(assessText("   \n  ")).toEqual({ chars: 0, words: 0, nonEmpty: false });
    expect(assessText("")).toEqual({ chars: 0, words: 0, nonEmpty: false });
  });
});

describe("pdf.chooseStrategy", () => {
  test("auto: text layer -> text", () => {
    expect(chooseStrategy({ hasTextLayer: true })).toBe("text");
  });
  test("auto: no text layer -> ocr", () => {
    expect(chooseStrategy({ hasTextLayer: false })).toBe("ocr");
  });
  test("explicit mode always wins over the diagnostic", () => {
    expect(chooseStrategy({ mode: "ocr", hasTextLayer: true })).toBe("ocr");
    expect(chooseStrategy({ mode: "text", hasTextLayer: false })).toBe("text");
    expect(chooseStrategy({ mode: "visual", hasTextLayer: true })).toBe("visual");
    expect(chooseStrategy({ mode: "tables", hasTextLayer: false })).toBe("tables");
  });
  test("unknown mode falls back to the diagnostic", () => {
    expect(chooseStrategy({ mode: "bogus", hasTextLayer: false })).toBe("ocr");
  });
});

describe("pdf.sortPageFiles", () => {
  test("sorts numerically, not lexically (10 after 2)", () => {
    const input = ["page-10.png", "page-2.png", "page-1.png", "page-11.png"];
    expect(sortPageFiles(input)).toEqual(["page-1.png", "page-2.png", "page-10.png", "page-11.png"]);
  });
  test("does not mutate the input array", () => {
    const input = ["page-2.png", "page-1.png"];
    sortPageFiles(input);
    expect(input).toEqual(["page-2.png", "page-1.png"]);
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
    // We don't reject these - they're ambiguous, not clearly local.
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
    // @ts-expect-error - intentionally bad input
    expect(() => safePath(undefined)).toThrow(/required/);
  });
});

// Regression: docs_search used to pass a multi-word query straight to
// `rg -i '<query>'` as ONE literal pattern. A space in a regex matches a
// literal space, so a natural-language query like "password reset email
// verification" required that exact phrase verbatim in a title/summary line
// - which almost never happens, producing false "[no results]" and driving
// the reformulation-loop guard (observed live: 6 docs_search + 5 docs_find
// calls hunting for content that was in the index all along). The fix
// tokenises the query (session_search's auto-OR semantics) before hitting
// rg with multiple -e flags, then ranks matched lines by distinct-token-hit
// count client-side. rankByTokenHits covers the ranking half of that fix.
describe("docs.rankByTokenHits", () => {
  test("single token: returns lines unchanged (no ranking needed)", () => {
    const lines = ["b line", "a line"];
    expect(rankByTokenHits(lines, ["line"])).toEqual(lines);
  });
  test("ranks lines hitting more distinct tokens first", () => {
    const lines = [
      "only password here",
      "password reset AND email verification",
      "unrelated line",
      "password reset only",
    ];
    const tokens = ["password", "reset", "email", "verification"];
    expect(rankByTokenHits(lines, tokens)).toEqual([
      "password reset AND email verification",
      "password reset only",
      "only password here",
      "unrelated line",
    ]);
  });
  test("case-insensitive matching", () => {
    const lines = ["PASSWORD Reset", "nothing"];
    expect(rankByTokenHits(lines, ["password", "reset"])[0]).toBe("PASSWORD Reset");
  });
  test("stable on ties - preserves original (index) order", () => {
    const lines = ["password one", "password two", "password three"];
    expect(rankByTokenHits(lines, ["password", "reset"])).toEqual(lines);
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

// ── bg-tasks: computeStatusLabel ────────────────────────────────

describe("bg-tasks.computeStatusLabel", () => {
  test("live + no completion → running", () => {
    expect(computeStatusLabel({}, true)).toBe("running");
    expect(computeStatusLabel({ exit_code: undefined }, true)).toBe("running");
  });

  test("completed + exit_code 0 → done", () => {
    expect(computeStatusLabel({ completed_at: 1, exit_code: 0 }, false)).toBe("done");
    // Pane still alive within the 30s grace — status is still "done", not "running"
    expect(computeStatusLabel({ completed_at: 1, exit_code: 0 }, true)).toBe("done");
  });

  test("completed + exit_code -1 (bg_kill sentinel) → killed (NOT exit--1)", () => {
    expect(computeStatusLabel({ completed_at: 1, exit_code: -1 }, false)).toBe("killed");
  });

  test("completed + non-zero exit_code → exit-N", () => {
    expect(computeStatusLabel({ completed_at: 1, exit_code: 1 }, false)).toBe("exit-1");
    expect(computeStatusLabel({ completed_at: 1, exit_code: 137 }, false)).toBe("exit-137");
  });

  test("no completion + tmux dead → lost (crashed/OOM/reboot before wrapper patched state)", () => {
    expect(computeStatusLabel({}, false)).toBe("lost");
    expect(computeStatusLabel({ exit_code: undefined }, false)).toBe("lost");
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

  test("image-bearing toolResults are NEVER pruned, even when not newest (the 2026-05-29 fix)", () => {
    // Reproduces the screenshot bug: user pastes a 217KB PNG, agent reads it
    // (~290KB base64), then runs a follow-up bash call. On the NEXT context
    // tick the bash is newest and the image read would (pre-fix) be pruned
    // because its base64 bytes alone blow the 160KB protect window.
    const imageRead: AnyMessage = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "image-read",
      content: [
        { type: "text", text: "[image] /tmp/pi-clipboard-foo.png" },
        // 290KB base64 string — a realistic 217KB PNG envelope.
        { type: "image", data: "A".repeat(290_000), mimeType: "image/png" } as unknown as never,
      ],
    };
    const followUp = toolResult("bash", 50_000, "bash-after-image");
    const msgs: AnyMessage[] = [imageRead, followUp];

    const origImageBytes = (imageRead.content as Array<{ data?: string }>)[1].data!.length;
    const stats = prune(msgs, { protectBytes: 160_000 });

    // Image read totally untouched.
    expect(Array.isArray(imageRead.content)).toBe(true);
    expect((imageRead.content as unknown[]).length).toBe(2);
    expect(((imageRead.content as Array<{ data?: string }>)[1].data ?? "").length).toBe(origImageBytes);
    // The bash follow-up is newest and so kept by rule 2.
    expect(firstTextPart(followUp)).toBe("x".repeat(50_000));
    expect(stats.prunedCount).toBe(0);
    expect(stats.reclaimedBytes).toBe(0);
    // keptNewest tracks newest *non-exempt* result — the bash here.
    expect(stats.keptNewest).toBe(true);
  });

  test("image exemption doesn't burn the newest-protected slot", () => {
    // If an image-bearing result IS newest, the next non-exempt text
    // toolResult should still benefit from rule 2 (kept verbatim).
    const oldBigBash = toolResult("bash", 500_000, "old");      // way over budget
    const newishRead = toolResult("read", 100_000, "newish");   // would-be newest
    const newestImage: AnyMessage = {
      role: "toolResult",
      toolName: "read",
      toolCallId: "newest-image",
      content: [
        { type: "image", data: "B".repeat(200_000), mimeType: "image/png" } as unknown as never,
      ],
    };
    const msgs: AnyMessage[] = [oldBigBash, newishRead, newestImage];
    const stats = prune(msgs, { protectBytes: 160_000 });

    // Image untouched.
    expect((newestImage.content as unknown[]).length).toBe(1);
    // newishRead consumed the newest-protected slot (since image was skipped)
    // — so 100KB read stays verbatim.
    expect(firstTextPart(newishRead)).toBe("x".repeat(100_000));
    // Old 500KB bash gets pruned (cumulative starts at 0 after newish-protected;
    // 500KB > 160KB so doesn't fit).
    expect(firstTextPart(oldBigBash)).toMatch(/\[tool-output-prune\] bash/);
    expect(stats.prunedCount).toBe(1);
    expect(stats.reclaimedBytes).toBe(500_000);
  });
});

describe("tool-output-prune.hasImageContent", () => {
  test("detects image part among text parts", () => {
    expect(
      hasImageContent([
        { type: "text", text: "hi" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
    ).toBe(true);
  });
  test("returns false for text-only content", () => {
    expect(hasImageContent([{ type: "text", text: "hi" }])).toBe(false);
  });
  test("returns false for non-array (string content)", () => {
    expect(hasImageContent("some string")).toBe(false);
  });
  test("returns false for empty array", () => {
    expect(hasImageContent([])).toBe(false);
  });
  test("returns false for null / undefined", () => {
    expect(hasImageContent(null)).toBe(false);
    expect(hasImageContent(undefined)).toBe(false);
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

// ── bash-error-hints: hint dispatch + new session-jsonl trigger ────────────

describe("bash-error-hints.renderHint", () => {
  test("substitutes $1..$9 from match", () => {
    const m = "foo bar baz".match(/(\w+) (\w+) (\w+)/)!;
    expect(renderHint("a=$1 b=$2 c=$3", m)).toBe("a=foo b=bar c=baz");
  });
  test("missing capture group → empty string", () => {
    const m = "x".match(/(x)/)!;
    expect(renderHint("a=$1 b=$2", m)).toBe("a=x b=");
  });
});

describe("bash-error-hints.matchHints — session JSONL trigger", () => {
  test("ls -la on a session jsonl path triggers the hint", () => {
    const out = "/home/erfi/.pi/agent/sessions/--home-erfi-foo--/2026-05-28T10-18-22-095Z_019e6e17.jsonl";
    const hits = matchHints(out);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.includes("session_search"))).toBe(true);
  });

  test("jq -r on a session jsonl triggers the hint", () => {
    const out = "$ jq -r '.role' /home/erfi/.pi/agent/sessions/X/Y.jsonl | head -5";
    expect(matchHints(out).some((h) => h.includes("session_search"))).toBe(true);
  });

  test("path quoted with single quotes still matches", () => {
    const out = "head -1 '/home/erfi/.pi/agent/sessions/foo/bar.jsonl'";
    expect(matchHints(out).some((h) => h.includes("session_search"))).toBe(true);
  });

  test("plain ~/.pi/agent/sessions/ directory listing (no .jsonl) does NOT trigger", () => {
    const out = "$ ls ~/.pi/agent/sessions/\n--home-erfi-foo--/\n--home-erfi-bar--/";
    const hits = matchHints(out);
    expect(hits.some((h) => h.includes("session_search"))).toBe(false);
  });

  test("session-fts.db file path does NOT trigger (no .jsonl extension)", () => {
    const out = "/home/erfi/.pi/agent/session-fts.db";
    expect(matchHints(out).some((h) => h.includes("session_search"))).toBe(false);
  });

  test("unrelated path containing the word 'session' does NOT trigger", () => {
    const out = "/var/log/session-manager.log";
    expect(matchHints(out).some((h) => h.includes("session_search"))).toBe(false);
  });
});

describe("bash-error-hints.matchHints — existing patterns still wired", () => {
  test("git -c user.email override fires the author-override hint", () => {
    const cmd = "$ git -c user.email=fake@example.com commit -m x";
    const hits = matchHints(cmd);
    expect(hits.some((h) => h.includes("Author/committer override"))).toBe(true);
  });

  test("dig TSIG leak fires the rotation hint", () => {
    const out = "; TSIG: hmac-sha256:axfr-out:abcdefXYZ";
    expect(matchHints(out).some((h) => /rotate/i.test(h))).toBe(true);
  });

  test("clean output → no hits", () => {
    expect(matchHints("HEAD is now at abcd123 commit message")).toEqual([]);
  });
});

describe("bash-error-hints.HINTS — sanity invariants", () => {
  test("every hint has a non-empty pattern + hint string", () => {
    for (const h of HINTS) {
      expect(h.pattern).toBeInstanceOf(RegExp);
      expect(typeof h.hint).toBe("string");
      expect(h.hint.length).toBeGreaterThan(20);
    }
  });
});

// ── session-undo: findLastUserEntryId pure helper ─────────────────────────

describe("session-undo.findLastUserEntryId", () => {
  test("empty branch → null", () => {
    expect(findLastUserEntryId([])).toBeNull();
  });

  test("only assistant messages → null", () => {
    expect(
      findLastUserEntryId([
        { type: "message", id: "a1", message: { role: "assistant" } },
        { type: "message", id: "a2", message: { role: "assistant" } },
      ]),
    ).toBeNull();
  });

  test("single user message → that id", () => {
    expect(
      findLastUserEntryId([{ type: "message", id: "u1", message: { role: "user" } }]),
    ).toBe("u1");
  });

  test("user → assistant → user → assistant returns LATEST user id", () => {
    expect(
      findLastUserEntryId([
        { type: "message", id: "u1", message: { role: "user" } },
        { type: "message", id: "a1", message: { role: "assistant" } },
        { type: "message", id: "u2", message: { role: "user" } },
        { type: "message", id: "a2", message: { role: "assistant" } },
      ]),
    ).toBe("u2");
  });

  test("ignores non-message entries (model_change, thinking_level_change, compaction)", () => {
    expect(
      findLastUserEntryId([
        { type: "message", id: "u1", message: { role: "user" } },
        { type: "model_change", id: "mc1" },
        { type: "thinking_level_change", id: "tlc1" },
        { type: "compaction", id: "c1" },
      ]),
    ).toBe("u1");
  });

  test("ignores toolResult role (it's an entry but not a 'user message')", () => {
    expect(
      findLastUserEntryId([
        { type: "message", id: "u1", message: { role: "user" } },
        { type: "message", id: "a1", message: { role: "assistant" } },
        { type: "message", id: "tr1", message: { role: "toolResult" } },
      ]),
    ).toBe("u1");
  });

  test("ignores bashExecution and custom roles too", () => {
    expect(
      findLastUserEntryId([
        { type: "message", id: "u1", message: { role: "user" } },
        { type: "message", id: "be1", message: { role: "bashExecution" } },
        { type: "message", id: "cu1", message: { role: "custom" } },
      ]),
    ).toBe("u1");
  });

  test("entry without a message field is silently skipped (no crash)", () => {
    expect(
      findLastUserEntryId([
        { type: "message", id: "u1", message: { role: "user" } },
        { type: "model_change", id: "mc1" }, // no message field at all
      ]),
    ).toBe("u1");
  });

  test("walks BACKWARD — first matching entry from the end wins", () => {
    // Sanity check that we're not finding the EARLIEST user message
    // (the first 'u1' should NOT win over 'u3').
    expect(
      findLastUserEntryId([
        { type: "message", id: "u1", message: { role: "user" } },
        { type: "message", id: "a1", message: { role: "assistant" } },
        { type: "message", id: "u2", message: { role: "user" } },
        { type: "message", id: "a2", message: { role: "assistant" } },
        { type: "message", id: "u3", message: { role: "user" } },
        { type: "message", id: "a3", message: { role: "assistant" } },
      ]),
    ).toBe("u3");
  });
});

// ── session-ledger: pure helpers ──────────────────────────────────────────

describe("session-ledger.isDegenerateSummary", () => {
  const realDegenerate = `## Goal
(No conversation content was provided to summarize.)

## Constraints & Preferences
- (none)

## Progress
### Done
- (none)

### Blocked
- No conversation messages were included between the \`<conversation>\` tags to summarize.

## Key Decisions
- (none)

## Next Steps
1. Provide the actual conversation content to be summarized.`;

  const realGood = `## Goal
Build the session-ledger extension.

## Key Decisions
- **Capture raw on shutdown, summarise lazily**: avoids hanging quit on a network call.

## Next Steps
1. Wire FTS5 search tool.`;

  test("flags the real degenerate compaction summary", () => {
    expect(isDegenerateSummary(realDegenerate)).toBe(true);
  });
  test("flags empty / null / whitespace", () => {
    expect(isDegenerateSummary("")).toBe(true);
    expect(isDegenerateSummary(null)).toBe(true);
    expect(isDegenerateSummary("   \n  ")).toBe(true);
  });
  test("flags an all-(none) skeleton", () => {
    expect(isDegenerateSummary("## Goal\n- (none)\n## Next Steps\n- (none)")).toBe(true);
  });
  test("keeps a real summary", () => {
    expect(isDegenerateSummary(realGood)).toBe(false);
  });
  test("keeps the SKIP sentinel out by treating short content as degenerate", () => {
    expect(isDegenerateSummary("SKIP")).toBe(true);
  });
});

describe("session-ledger.ftsQuery", () => {
  test("tokenises and OR-joins, dropping punctuation + 1-char tokens", () => {
    expect(ledgerFtsQuery("DNS migration!")).toBe('"dns" OR "migration"');
    expect(ledgerFtsQuery("a knot")).toBe('"knot"');
  });
  test("empty for punctuation-only", () => {
    expect(ledgerFtsQuery("!!! ?")).toBe("");
  });
});

describe("session-ledger.buildInjectionBlock", () => {
  const rows = [
    { id: 2, created_at: Date.UTC(2026, 5, 18, 9, 0), kind: "compaction", git_branch: "main", summary: "## Goal\nB second" },
    { id: 1, created_at: Date.UTC(2026, 5, 17, 9, 0), kind: "shutdown", git_branch: null, summary: "## Goal\nA first" },
  ];
  test("empty for no rows", () => {
    expect(buildInjectionBlock([])).toBe("");
  });
  test("includes header, staleness warning, and both sections", () => {
    const out = buildInjectionBlock(rows);
    expect(out).toContain("# Recent work in this project");
    expect(out).toContain("re-read named files");
    expect(out).toContain("B second");
    expect(out).toContain("A first");
    expect(out).toContain("· main");
  });
  test("byte budget caps sections (header-only => empty string)", () => {
    expect(buildInjectionBlock(rows, 10)).toBe("");
  });
  test("skips rows with null summary", () => {
    const out = buildInjectionBlock([{ id: 3, created_at: Date.now(), kind: "shutdown", git_branch: null, summary: null }]);
    expect(out).toBe("");
  });
});

describe("session-ledger.isReadOnlySql", () => {
  test("allows SELECT and WITH", () => {
    expect(isReadOnlySql("SELECT * FROM ledger").ok).toBe(true);
    expect(isReadOnlySql("with x as (select 1) select * from x").ok).toBe(true);
    expect(isReadOnlySql("  SELECT id FROM ledger;  ").ok).toBe(true);
  });
  test("rejects writes / DDL", () => {
    expect(isReadOnlySql("DELETE FROM ledger").ok).toBe(false);
    expect(isReadOnlySql("UPDATE ledger SET x=1").ok).toBe(false);
    expect(isReadOnlySql("DROP TABLE ledger").ok).toBe(false);
    expect(isReadOnlySql("PRAGMA table_info(ledger)").ok).toBe(false);
    expect(isReadOnlySql("ATTACH DATABASE 'x' AS y").ok).toBe(false);
  });
  test("rejects multiple statements", () => {
    expect(isReadOnlySql("SELECT 1; DROP TABLE ledger").ok).toBe(false);
  });
  test("rejects empty + non-select", () => {
    expect(isReadOnlySql("").ok).toBe(false);
    expect(isReadOnlySql("EXPLAIN SELECT 1").ok).toBe(false);
  });
});

describe("session-ledger.serializeEntriesForSummary", () => {
  test("role-tags and skips empty entries", () => {
    const out = serializeEntriesForSummary([
      { role: "user", content: "hello" },
      { type: "model_change", content: "" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]);
    expect(out).toBe("[user] hello\n[assistant] hi there");
  });
  test("caps total to the most recent content (tail kept)", () => {
    const big = "x".repeat(5000);
    const out = serializeEntriesForSummary([{ role: "user", content: big }], { maxPerEntry: 10000, maxTotal: 100 });
    expect(out.length).toBe(100);
    expect(out.endsWith("x")).toBe(true);
  });
});

describe("session-ledger.extractCompletionText", () => {
  test("string content", () => {
    expect(extractCompletionText({ content: "done" })).toBe("done");
  });
  test("array of text parts", () => {
    expect(extractCompletionText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
  });
  test("defensive on junk", () => {
    expect(extractCompletionText(null)).toBe("");
    expect(extractCompletionText({ content: 42 })).toBe("");
  });
});

// ── confidential-write-guard: scanForBlocked (the security-critical masker) ──

describe("confidential-write-guard.scanForBlocked", () => {
  test("matches a blocked term case-insensitively", () => {
    expect(scanForBlocked("the AcmeCo deal", ["acmeco"])).not.toBeNull();
    expect(scanForBlocked("the acmeco deal", ["AcmeCo"])).not.toBeNull();
  });

  test("respects non-alphanumeric boundaries (no substring false positives)", () => {
    // term appears as a whole token bounded by punctuation/space → match
    expect(scanForBlocked("path is Acme/Foo", ["Acme"])).not.toBeNull();
    expect(scanForBlocked("(Acme)", ["Acme"])).not.toBeNull();
    // term embedded inside a larger alphanumeric token → NO match
    expect(scanForBlocked("the Acmebot service", ["Acme"])).toBeNull();
    expect(scanForBlocked("preAcme", ["Acme"])).toBeNull();
  });

  test("NEVER echoes the blocked term in its output (the core guarantee)", () => {
    const term = "Zephyrus";
    const hit = scanForBlocked("internal codename Zephyrus ships Q3", [term]);
    expect(hit).not.toBeNull();
    expect(hit!.masked).toContain("[REDACTED]");
    expect(hit!.masked.toLowerCase()).not.toContain(term.toLowerCase());
  });

  test("masks only the term, keeping surrounding context", () => {
    const hit = scanForBlocked("before Widget after", ["Widget"]);
    expect(hit!.masked).toBe("before [REDACTED] after");
  });

  test("adds ellipsis when context is truncated on both sides", () => {
    const long = "x".repeat(40) + " SECRET " + "y".repeat(40);
    const hit = scanForBlocked(long, ["SECRET"]);
    expect(hit!.masked.startsWith("…")).toBe(true);
    expect(hit!.masked.endsWith("…")).toBe(true);
    expect(hit!.masked).toContain("[REDACTED]");
  });

  test("returns null when no blocked term is present", () => {
    expect(scanForBlocked("nothing sensitive here", ["Acme", "Zephyrus"])).toBeNull();
  });

  test("returns null on empty text or empty blocklist", () => {
    expect(scanForBlocked("", ["Acme"])).toBeNull();
    expect(scanForBlocked("Acme", [])).toBeNull();
  });

  test("masks the first blocked term it finds (block list order)", () => {
    // iterates the block list in order → "Beta" is checked first and redacted
    const hit = scanForBlocked("Alpha then Beta", ["Beta", "Alpha"]);
    expect(hit).not.toBeNull();
    expect(hit!.masked).toContain("[REDACTED]");
    expect(hit!.masked).not.toContain("Beta"); // the matched term never leaks
  });

  test("escapes regex metacharacters in terms (treated literally)", () => {
    expect(scanForBlocked("project a.b.c here", ["a.b.c"])).not.toBeNull();
    // the dots are literal, so a different separator must NOT match
    expect(scanForBlocked("project axbxc here", ["a.b.c"])).toBeNull();
  });
});

// ── confidential-write-guard: isCommitPersist (commit/PR vet-nudge trigger) ──

describe("confidential-write-guard.isCommitPersist", () => {
  test("matches git commit in all its forms", () => {
    expect(isCommitPersist("git commit -m 'x'")).toBe(true);
    expect(isCommitPersist("git commit -F -")).toBe(true);
    expect(isCommitPersist("cd ~/repo && git commit --amend --no-edit")).toBe(true);
    expect(isCommitPersist("git commit -F - <<'EOF'\nfeat: x\nEOF")).toBe(true);
  });

  test("matches git tag and git notes (message-bearing)", () => {
    expect(isCommitPersist("git tag -a v1 -m 'release'")).toBe(true);
    expect(isCommitPersist("git notes add -m 'note'")).toBe(true);
  });

  test("matches gh pr/issue/release create|edit|comment (remote prose bodies)", () => {
    expect(isCommitPersist("gh pr create --title x --body y")).toBe(true);
    expect(isCommitPersist("gh pr edit 3 --body z")).toBe(true);
    expect(isCommitPersist("gh issue create -t x -b y")).toBe(true);
    expect(isCommitPersist("gh issue comment 5 -b 'thanks'")).toBe(true);
    expect(isCommitPersist("gh release create v2 --notes '...'")).toBe(true);
  });

  test("does NOT match read-only or non-persisting commands (the false-positive class)", () => {
    expect(isCommitPersist("git status")).toBe(false);
    expect(isCommitPersist("git log --oneline -5")).toBe(false);
    expect(isCommitPersist("git diff --cached")).toBe(false);
    expect(isCommitPersist("gh pr view 3")).toBe(false);
    // regression: read/search/scrub commands that the OLD WRITE_BASH matched via
    // its `>>?` / tee / sd / dd tokens must NOT be treated as writes now.
    expect(isCommitPersist("grep 'order_history' src/ 2>/dev/null")).toBe(false);
    expect(isCommitPersist("rg 'AcmeCo' | tee /tmp/out")).toBe(false);
    expect(isCommitPersist("git log | rg AcmeCo")).toBe(false);
    expect(isCommitPersist("git filter-repo --replace-text expr.txt")).toBe(false);
    expect(isCommitPersist("echo done > /tmp/status")).toBe(false);
    expect(isCommitPersist("sed -i 's/a/b/' file.md")).toBe(false);
    expect(isCommitPersist("gh pr list")).toBe(false);
    expect(isCommitPersist("echo committing now")).toBe(false);
  });
});

// ── confidential-write-guard: resolveBashCwd (the cd-tracking fix) ───────────
// Regression: `bash` spawns a fresh subprocess per call, so a `cd <dir> &&`
// prefix only moves that subprocess's directory - pi's own process.cwd()
// never changes. The guard used to check process.cwd() unconditionally,
// which meant `cd ~/other-repo && git commit ...` got attributed to pi's
// startup repo: wrong repo named in the COMMIT_NUDGE message, and (more
// seriously) the WRONG per-repo blocked-terms store consulted for the scan.

describe("confidential-write-guard.resolveBashCwd", () => {
  test("no cd in the command -> falls back to the given cwd", () => {
    expect(resolveBashCwd("git commit -m x", "/home/erfi/dotfiles")).toBe("/home/erfi/dotfiles");
  });

  test("cd <dir> && <write> -> resolves to the cd target, not the fallback", () => {
    expect(resolveBashCwd("cd ~/docs-ssh && git commit -F -", "/home/erfi/dotfiles")).toBe(
      resolveBashCwd("cd ~/docs-ssh", "/home/erfi/dotfiles"),
    );
    expect(resolveBashCwd("cd /home/erfi/docs-ssh && git commit -F -", "/home/erfi/dotfiles")).toBe(
      "/home/erfi/docs-ssh",
    );
  });

  test("relative cd resolves against the fallback cwd", () => {
    expect(resolveBashCwd("cd ../sibling-repo && git commit -m x", "/home/erfi/dotfiles")).toBe(
      "/home/erfi/sibling-repo",
    );
  });

  test("multiple cd segments -> uses the LAST one (the active dir when the write runs)", () => {
    expect(resolveBashCwd("cd ~/a && cd /home/erfi/b && git commit -m x", "/home/erfi/dotfiles")).toBe(
      "/home/erfi/b",
    );
  });

  test("cd with no write command still resolves (used for the commit-persist bash branch)", () => {
    expect(resolveBashCwd("cd ~/docs-ssh", "/home/erfi/dotfiles")).toBe(`${require("node:os").homedir()}/docs-ssh`);
  });
});

// ── confidential-write-guard: extractMessageFilePaths (payload file sourcing) ──
// A commit's persisted payload includes the CONTENTS of -F / --body-file, not
// just argv. These paths get read + scanned so an identifier in a message file
// (never in the command string) is still caught.
describe("confidential-write-guard.extractMessageFilePaths", () => {
  test("extracts -F and --file (space and = forms)", () => {
    expect(extractMessageFilePaths("git commit -F msg.txt")).toEqual(["msg.txt"]);
    expect(extractMessageFilePaths("git commit --file=/tmp/m")).toEqual(["/tmp/m"]);
    expect(extractMessageFilePaths("git tag -a v1 -F notes.md")).toEqual(["notes.md"]);
  });

  test("extracts gh --body-file", () => {
    expect(extractMessageFilePaths("gh pr create --body-file body.md")).toEqual(["body.md"]);
    expect(extractMessageFilePaths("gh issue create --body-file=./b.md")).toEqual(["./b.md"]);
  });

  test("unwraps quotes around the path", () => {
    expect(extractMessageFilePaths(`git commit -F "notes.md"`)).toEqual(["notes.md"]);
    expect(extractMessageFilePaths("git commit -F 'notes.md'")).toEqual(["notes.md"]);
  });

  test("excludes the stdin sentinel `-`", () => {
    expect(extractMessageFilePaths("git commit -F -")).toEqual([]);
    expect(extractMessageFilePaths("git commit -F - <<'EOF'\nfeat: x\nEOF")).toEqual([]);
  });

  test("returns empty when there is no message file", () => {
    expect(extractMessageFilePaths("git commit -m 'inline'")).toEqual([]);
    expect(extractMessageFilePaths("gh pr create --title x --body y")).toEqual([]);
  });
});

// ── confidential-write-guard: collectCommitPayload (what actually gets scanned) ─
describe("confidential-write-guard.collectCommitPayload", () => {
  const noDiff = () => "";
  const noFile = () => "";

  test("always includes the command string (catches inline -m / --body)", () => {
    const parts = collectCommitPayload("git commit -m 'AcmeCo ships'", "/repo", noFile, noDiff);
    expect(parts).toContain("git commit -m 'AcmeCo ships'");
  });

  test("pulls in -F message-file contents (identifier not in argv)", () => {
    const parts = collectCommitPayload("git commit -F msg.txt", "/repo", () => "secret AcmeCo body", noDiff);
    expect(parts.some((p) => p.includes("AcmeCo"))).toBe(true);
  });

  test("includes staged diff for `git commit` (identifier in staged content)", () => {
    const parts = collectCommitPayload("git commit -m x", "/repo", noFile, () => "+const customer = 'AcmeCo';");
    expect(parts.some((p) => p.includes("AcmeCo"))).toBe(true);
  });

  test("does NOT pull a staged diff for tag / gh (no `git commit`)", () => {
    let called = false;
    const diff = () => {
      called = true;
      return "leak";
    };
    collectCommitPayload("gh pr create --body y", "/repo", noFile, diff);
    collectCommitPayload("git tag -a v1 -m x", "/repo", noFile, diff);
    expect(called).toBe(false);
  });

  test("end-to-end: a blocked term only in the staged diff is detectable", () => {
    const parts = collectCommitPayload("git commit -m 'chore: cleanup'", "/repo", noFile, () => "+// re: AcmeCo");
    const hit = parts.map((p) => scanForBlocked(p, ["AcmeCo"])).find(Boolean);
    expect(hit).toBeTruthy();
    expect(hit!.masked).toContain("[REDACTED]");
  });
});

describe("ascii-punctuation-guard / scan", () => {
  test("detects em dash and maps to ASCII hyphen", () => {
    const found = scanAsciiPunct("foo \u2014 bar");
    expect(found.length).toBe(1);
    expect(found[0].name).toContain("em dash");
    expect(found[0].ascii).toBe("-");
    expect(found[0].count).toBe(1);
  });

  test("counts multiple occurrences of the same char", () => {
    const found = scanAsciiPunct("a \u2014 b \u2014 c \u2014 d");
    expect(found.length).toBe(1);
    expect(found[0].count).toBe(3);
  });

  test("detects en dash, smart quotes, and ellipsis together", () => {
    const found = scanAsciiPunct("range 1\u20135, \u201Cquoted\u201D and \u2018single\u2019\u2026");
    const names = found.map((f) => f.name).join(" ");
    expect(names).toContain("en dash");
    expect(names).toContain("smart double quote");
    expect(names).toContain("smart single quote");
    expect(names).toContain("ellipsis");
  });

  test("maps smart quotes and ellipsis to correct ASCII", () => {
    const found = scanAsciiPunct("\u201Cx\u201D \u2018y\u2019 z\u2026");
    const byName = Object.fromEntries(found.map((f) => [f.name.split(" (")[0], f.ascii]));
    expect(byName["smart double quote"]).toBe('"');
    expect(byName["smart single quote"]).toBe("'");
    expect(byName["ellipsis"]).toBe("...");
  });

  test("detects non-breaking space", () => {
    const found = scanAsciiPunct("a\u00A0b");
    expect(found.length).toBe(1);
    expect(found[0].ascii).toBe(" ");
  });

  test("returns empty for clean ASCII text", () => {
    expect(scanAsciiPunct("plain ascii - no smart punctuation here...")).toEqual([]);
  });

  test("returns empty for empty string", () => {
    expect(scanAsciiPunct("")).toEqual([]);
  });

  test("includes a masked context snippet for the first hit", () => {
    const found = scanAsciiPunct("the quick brown fox \u2014 jumps over");
    expect(found[0].sample.length).toBeGreaterThan(0);
  });
});

describe("ascii-punctuation-guard / isProsePath", () => {
  test("flags markdown and text extensions as prose", () => {
    expect(isAsciiProsePath("README.md")).toBe(true);
    expect(isAsciiProsePath("notes.txt")).toBe(true);
    expect(isAsciiProsePath("doc.mdx")).toBe(true);
  });

  test("flags paths under a docs/ directory", () => {
    expect(isAsciiProsePath("src/docs/guide.html")).toBe(true);
    expect(isAsciiProsePath("doc/page.html")).toBe(true);
  });

  test("does not flag code files", () => {
    expect(isAsciiProsePath("src/index.ts")).toBe(false);
    expect(isAsciiProsePath("main.go")).toBe(false);
  });
});

describe("ascii-punctuation-guard / WRITE_BASH", () => {
  test("matches commands that persist text", () => {
    expect(ASCII_WRITE_BASH.test('git commit -m "msg"')).toBe(true);
    expect(ASCII_WRITE_BASH.test("echo hi >> file")).toBe(true);
    expect(ASCII_WRITE_BASH.test("echo hi > file")).toBe(true);
    expect(ASCII_WRITE_BASH.test("foo | tee file")).toBe(true);
    expect(ASCII_WRITE_BASH.test("sed -i 's/a/b/' file")).toBe(true);
    expect(ASCII_WRITE_BASH.test("git tag -a v1 -m x")).toBe(true);
  });

  test("ignores read-only / printing commands", () => {
    expect(ASCII_WRITE_BASH.test("echo hello")).toBe(false);
    expect(ASCII_WRITE_BASH.test("rg pattern src/")).toBe(false);
    expect(ASCII_WRITE_BASH.test("git log --oneline")).toBe(false);
  });
});

// ── video-review ────────────────────────────────────────────────────────────

describe("video-review / resolveMediaPath", () => {
  const files = [
    { name: "2026-07-17 12-50-00.mkv", path: "/media/2026-07-17 12-50-00.mkv" },
    { name: "2026-07-17 11-29-45.mkv", path: "/media/2026-07-17 11-29-45.mkv" },
  ];
  test("passes server-side paths through untouched", () => {
    expect(resolveMediaPath("/media/foo.mkv", files)).toBe("/media/foo.mkv");
    expect(resolveMediaPath("/tmp/x.wav", files)).toBe("/tmp/x.wav");
  });
  test("latest/newest -> first (newest-first list)", () => {
    expect(resolveMediaPath("latest", files)).toBe("/media/2026-07-17 12-50-00.mkv");
    expect(resolveMediaPath("newest", files)).toBe("/media/2026-07-17 12-50-00.mkv");
  });
  test("substring match, newest wins", () => {
    expect(resolveMediaPath("11-29", files)).toBe("/media/2026-07-17 11-29-45.mkv");
  });
  test("no match -> null", () => {
    expect(resolveMediaPath("nope", files)).toBeNull();
    expect(resolveMediaPath("", files)).toBeNull();
  });
});

describe("video-review / bundleCacheKey", () => {
  test("stable + params-sensitive", () => {
    const a = bundleCacheKey("/media/x.mkv", { diarize: true });
    const b = bundleCacheKey("/media/x.mkv", { diarize: true });
    const c = bundleCacheKey("/media/x.mkv", { diarize: false });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe("video-review / hhmmss", () => {
  test("formats", () => {
    expect(hhmmss(0)).toBe("0:00");
    expect(hhmmss(65)).toBe("1:05");
    expect(hhmmss(3661)).toBe("1:01:01");
    expect(hhmmss(-5)).toBe("0:00");
  });
});

// Build a segment carrying word-level speaker timing.
function seg(speaker: string, words: [string, number, number][]): Segment {
  return {
    start: words[0][1],
    end: words[words.length - 1][2],
    text: words.map((w) => w[0]).join(" "),
    speaker,
    words: words.map(([word, start, end]) => ({ word, start, end, speaker })),
  };
}

describe("video-review / mergeUtterances", () => {
  test("merges same-speaker words within gap, splits on speaker change", () => {
    const segs = [
      seg("A", [["hello", 0, 0.4], ["there", 0.5, 0.9]]),
      seg("B", [["hi", 1.2, 1.5]]),
      seg("A", [["again", 5.0, 5.4]]), // big gap -> new utterance
    ];
    const u = mergeUtterances(segs, 0.6);
    expect(u).toHaveLength(3);
    expect(u[0].speaker).toBe("A");
    expect(u[0].wordCount).toBe(2);
    expect(u[1].speaker).toBe("B");
    expect(u[2].speaker).toBe("A");
  });
  test("skips words lacking timing/speaker", () => {
    const segs: Segment[] = [
      { start: 0, end: 1, text: "x", speaker: "A", words: [{ word: "x" }] },
    ];
    expect(mergeUtterances(segs)).toHaveLength(0);
  });
});

describe("video-review / computeOverlap", () => {
  test("detects a talk-over: B starts inside A's utterance and A yields", () => {
    // A talks 0-3s; B comes in at 2.0s and runs to 4s -> A ends first (yields).
    const segs = [
      seg("A", [["long", 0, 1], ["winded", 1, 2], ["point", 2, 3]]),
      seg("B", [["wait", 2.0, 2.6], ["actually", 2.6, 4.0]]),
    ];
    const r = computeOverlap(mergeUtterances(segs), 0.3);
    expect(r.events).toHaveLength(1);
    const e = r.events[0];
    expect(e.interrupter).toBe("B");
    expect(e.interruptee).toBe("A");
    expect(e.yielded).toBe("A"); // A ends (3s) before B (4s)
    expect(e.overlapSec).toBeCloseTo(1.0, 1);
    const a = r.speakers.find((s) => s.speaker === "A")!;
    const b = r.speakers.find((s) => s.speaker === "B")!;
    expect(b.startedOverOthers).toBe(1);
    expect(a.wasStartedOver).toBe(1);
    expect(r.pairCounts[0].pair).toBe("B over A");
  });
  test("clean turns with a gap produce no overlaps", () => {
    const segs = [
      seg("A", [["done", 0, 1]]),
      seg("B", [["ok", 2, 3]]),
    ];
    const r = computeOverlap(mergeUtterances(segs), 0.3);
    expect(r.events).toHaveLength(0);
    expect(r.totalOverlapSec).toBe(0);
  });
  test("sub-threshold backchannel is filtered", () => {
    const segs = [
      seg("A", [["a", 0, 1], ["b", 1, 2]]),
      seg("B", [["mm", 1.9, 2.0]]), // 0.1s overlap < 0.3 threshold
    ];
    const r = computeOverlap(mergeUtterances(segs), 0.3);
    expect(r.events).toHaveLength(0);
  });
});

describe("video-review / parseNameMap", () => {
  test("parses JSON form", () => {
    expect(parseNameMap('{"M-SPEAKER_00":"Erfi","M-SPEAKER_01":"Alice"}')).toEqual({
      "M-SPEAKER_00": "Erfi",
      "M-SPEAKER_01": "Alice",
    });
  });
  test("parses compact k=v form (comma + newline)", () => {
    expect(parseNameMap("M-SPEAKER_00=Erfi, M-SPEAKER_01=Alice")).toEqual({
      "M-SPEAKER_00": "Erfi",
      "M-SPEAKER_01": "Alice",
    });
    expect(parseNameMap("A=Erfi\nB=Bob")).toEqual({ A: "Erfi", B: "Bob" });
  });
  test("handles names with spaces and empty input", () => {
    expect(parseNameMap("SPEAKER_00=Jane Doe")).toEqual({ SPEAKER_00: "Jane Doe" });
    expect(parseNameMap("")).toEqual({});
    expect(parseNameMap("garbage")).toEqual({});
  });
});

describe("video-review / applyNameMap", () => {
  function bundle(): Bundle {
    return {
      file: "/media/x.mkv",
      language: "",
      duration: 5,
      segments: [
        { start: 0, end: 1, text: "hi", speaker: "M-SPEAKER_00", words: [{ word: "hi", start: 0, end: 1, speaker: "M-SPEAKER_00" }] },
        { start: 1, end: 2, text: "yo", speaker: "M-SPEAKER_01", words: [{ word: "yo", start: 1, end: 2, speaker: "M-SPEAKER_01" }] },
      ],
      speakers: ["M-SPEAKER_00", "M-SPEAKER_01"],
      hasWordSpeakers: true,
      speakerEmbeddings: { "M-SPEAKER_00": [1, 0], "M-SPEAKER_01": [0, 1] },
      createdAt: "now",
      params: {},
    };
  }
  test("rewrites segments, words, speakers list, embeddings keys, and records names", () => {
    const b = bundle();
    applyNameMap(b, { "M-SPEAKER_00": "Erfi" });
    expect(b.segments[0].speaker).toBe("Erfi");
    expect(b.segments[0].words![0].speaker).toBe("Erfi");
    expect(b.segments[1].speaker).toBe("M-SPEAKER_01"); // unmapped untouched
    expect(b.speakers).toEqual(["Erfi", "M-SPEAKER_01"]);
    expect(b.speakerEmbeddings!["Erfi"]).toEqual([1, 0]);
    expect(b.speakerEmbeddings!["M-SPEAKER_00"]).toBeUndefined();
    expect(b.names).toEqual({ "M-SPEAKER_00": "Erfi" });
  });
  test("merges successive maps into names", () => {
    const b = bundle();
    applyNameMap(b, { "M-SPEAKER_00": "Erfi" });
    applyNameMap(b, { "M-SPEAKER_01": "Alice" });
    expect(b.names).toEqual({ "M-SPEAKER_00": "Erfi", "M-SPEAKER_01": "Alice" });
    expect(b.speakers).toEqual(["Alice", "Erfi"]); // applyNameMap sorts speakers
  });
});
