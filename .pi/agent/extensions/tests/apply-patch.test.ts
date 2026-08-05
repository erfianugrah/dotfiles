/**
 * Unit tests for the pure core of the apply_patch extension.
 *
 * Run: bun test .pi/agent/extensions/tests/apply-patch.test.ts
 *
 * Lives in tests/ (which has no index.ts) so pi's extension discovery globs
 * for `.ts` files and `<subdir>/index.ts` entry points do not load it.
 */

import { describe, expect, test } from "bun:test";
import { applyHunks, parsePatch, renderApplyDiffs } from "../lib/apply-patch-core.ts";

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch\n`;

describe("parsePatch", () => {
  test("parses add / update / delete in one patch", () => {
    const ops = parsePatch(
      envelope(
        [
          "*** Add File: a.ts",
          "+const a = 1;",
          "*** Update File: b.ts",
          "@@ ctx",
          "-old",
          "+new",
          "*** Delete File: c.ts",
        ].join("\n"),
      ),
    );
    expect(ops).toEqual([
      { type: "add", path: "a.ts", content: "const a = 1;\n" },
      { type: "update", path: "b.ts", hunks: [{ context: "ctx", oldLines: ["old"], newLines: ["new"] }] },
      { type: "delete", path: "c.ts" },
    ]);
  });

  test("works without the Begin/End envelope", () => {
    const ops = parsePatch("*** Delete File: gone.ts");
    expect(ops).toEqual([{ type: "delete", path: "gone.ts" }]);
  });

  test("normalises CRLF", () => {
    const ops = parsePatch("*** Begin Patch\r\n*** Add File: a.ts\r\n+x\r\n*** End Patch\r\n");
    expect(ops).toEqual([{ type: "add", path: "a.ts", content: "x\n" }]);
  });

  // Regression: a blank separator line before the next *** header used to
  // throw "every line must start with '+'".
  test("tolerates a blank separator line at the end of an Add block", () => {
    const ops = parsePatch(
      envelope(["*** Add File: a.ts", "+one", "+two", "", "*** Delete File: c.ts"].join("\n")),
    );
    expect(ops[0]).toEqual({ type: "add", path: "a.ts", content: "one\ntwo\n" });
    expect(ops[1]).toEqual({ type: "delete", path: "c.ts" });
  });

  test("keeps interior blank lines that are followed by more content", () => {
    const ops = parsePatch(envelope(["*** Add File: a.ts", "+one", "", "+three"].join("\n")));
    expect(ops[0]).toEqual({ type: "add", path: "a.ts", content: "one\n\nthree\n" });
  });

  test("preserves '+'-prefixed empty lines", () => {
    const ops = parsePatch(envelope(["*** Add File: a.ts", "+one", "+", "+three"].join("\n")));
    expect(ops[0]).toEqual({ type: "add", path: "a.ts", content: "one\n\nthree\n" });
  });

  test("empty Add File yields empty content, not a stray newline", () => {
    const ops = parsePatch(envelope("*** Add File: empty.ts"));
    expect(ops).toEqual([{ type: "add", path: "empty.ts", content: "" }]);
  });

  test("rejects a non-'+' line inside an Add block", () => {
    expect(() => parsePatch(envelope(["*** Add File: a.ts", "+ok", "bad"].join("\n")))).toThrow(
      /must start with '\+'/,
    );
  });

  test("rejects an Update with no @@ hunks", () => {
    expect(() => parsePatch(envelope("*** Update File: b.ts"))).toThrow(/no @@ hunks found/);
  });

  test("rejects a patch with no operations", () => {
    expect(() => parsePatch(envelope("just some prose"))).toThrow(/no file operations/);
  });

  test("parses multiple hunks in one Update", () => {
    const ops = parsePatch(
      envelope(
        ["*** Update File: b.ts", "@@ first", "-a", "+A", "", "@@ second", "-b", "+B"].join("\n"),
      ),
    );
    expect(ops[0]).toMatchObject({
      type: "update",
      hunks: [
        { context: "first", oldLines: ["a"], newLines: ["A"] },
        { context: "second", oldLines: ["b"], newLines: ["B"] },
      ],
    });
  });

  test("trims whitespace around paths", () => {
    const ops = parsePatch(envelope("*** Delete File:   spaced.ts  "));
    expect(ops[0]).toEqual({ type: "delete", path: "spaced.ts" });
  });
});

describe("applyHunks", () => {
  const file = "alpha\nbeta\ngamma\n";

  test("replaces a unique block", () => {
    const out = applyHunks("f.ts", file, [
      { context: "", oldLines: ["beta"], newLines: ["BETA"] },
    ]);
    expect(out).toBe("alpha\nBETA\ngamma\n");
  });

  test("applies hunks in sequence", () => {
    const out = applyHunks("f.ts", file, [
      { context: "", oldLines: ["alpha"], newLines: ["ALPHA"] },
      { context: "", oldLines: ["gamma"], newLines: ["GAMMA"] },
    ]);
    expect(out).toBe("ALPHA\nbeta\nGAMMA\n");
  });

  test("supports deletion (empty new block)", () => {
    const out = applyHunks("f.ts", file, [
      { context: "", oldLines: ["beta\n"], newLines: [] },
    ]);
    expect(out).toBe("alpha\ngamma\n");
  });

  test("errors when the old block is missing", () => {
    expect(() =>
      applyHunks("f.ts", file, [{ context: "", oldLines: ["nope"], newLines: ["x"] }]),
    ).toThrow(/old block not found/);
  });

  test("errors when the old block is ambiguous, and does not blame @@ context", () => {
    const dup = "x\nx\n";
    expect(() =>
      applyHunks("f.ts", dup, [{ context: "", oldLines: ["x"], newLines: ["y"] }]),
    ).toThrow(/matches multiple times/);
    // Regression: the old message said "add @@ context to disambiguate", which
    // the replacement path never consults.
    expect(() =>
      applyHunks("f.ts", dup, [{ context: "", oldLines: ["x"], newLines: ["y"] }]),
    ).not.toThrow(/add @@ context to disambiguate/);
  });

  test("inserts after the @@ context line when the old block is empty", () => {
    const out = applyHunks("f.ts", file, [
      { context: "beta", oldLines: [], newLines: ["inserted"] },
    ]);
    expect(out).toBe("alpha\nbeta\ninserted\ngamma\n");
  });

  test("pure insertion requires a context line", () => {
    expect(() => applyHunks("f.ts", file, [{ context: "", oldLines: [], newLines: ["x"] }])).toThrow(
      /pure insertion needs @@ context/,
    );
  });

  test("pure insertion errors when the context is missing", () => {
    expect(() =>
      applyHunks("f.ts", file, [{ context: "delta", oldLines: [], newLines: ["x"] }]),
    ).toThrow(/not found/);
  });

  // Regression: the insertion path took the first indexOf hit with no
  // uniqueness check, so a duplicated context line inserted at the wrong spot.
  test("pure insertion errors when the context is ambiguous", () => {
    expect(() =>
      applyHunks("f.ts", "dup\nmid\ndup\n", [
        { context: "dup", oldLines: [], newLines: ["x"] },
      ]),
    ).toThrow(/matches multiple times/);
  });

  test("inserts at EOF when the context line is last and unterminated", () => {
    const out = applyHunks("f.ts", "alpha\nomega", [
      { context: "omega", oldLines: [], newLines: ["tail"] },
    ]);
    expect(out).toBe("alpha\nomega\ntail\n");
  });

  test("leaves content untouched for an empty hunk list", () => {
    expect(applyHunks("f.ts", file, [])).toBe(file);
  });

  test("error messages carry the 1-based hunk index", () => {
    expect(() =>
      applyHunks("f.ts", file, [
        { context: "", oldLines: ["alpha"], newLines: ["A"] },
        { context: "", oldLines: ["nope"], newLines: ["x"] },
      ]),
    ).toThrow(/hunk 2:/);
  });
});

describe("renderApplyDiffs", () => {
  const fakeDiff = (o: string, n: string) => (o === n ? "" : `-${o}+${n}`);

  test("renders a heading per changed file", () => {
    const out = renderApplyDiffs(
      [
        { relPath: "a.ts", oldContent: "1", newContent: "2", isNew: false },
        { relPath: "b.ts", oldContent: "3", newContent: "4", isNew: false },
      ],
      fakeDiff,
    );
    expect(out).toBe("### a.ts\n-1+2\n\n### b.ts\n-3+4");
  });

  test("skips new files", () => {
    const out = renderApplyDiffs(
      [{ relPath: "new.ts", oldContent: "", newContent: "body", isNew: true }],
      fakeDiff,
    );
    expect(out).toBe("");
  });

  test("skips no-op diffs", () => {
    const out = renderApplyDiffs(
      [{ relPath: "same.ts", oldContent: "x", newContent: "x", isNew: false }],
      fakeDiff,
    );
    expect(out).toBe("");
  });

  test("empty input yields an empty string", () => {
    expect(renderApplyDiffs([], fakeDiff)).toBe("");
  });
});
