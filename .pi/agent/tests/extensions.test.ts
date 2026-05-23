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
import { parseImage, versionCompare } from "../extensions/oci-tags.ts";
import {
  dateFromName,
  extractText,
  tokenise,
} from "../extensions/session-search.ts";
import { toFtsQuery } from "../extensions/session-fts/index.ts";

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
