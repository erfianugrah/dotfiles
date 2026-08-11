/**
 * ascii-core unit tests - pure, no harness. Covers scan + foldToAscii for
 * EVERY code point in the map (including the ones the pi suite in
 * ../../tests/extensions.test.ts does not exercise: figure dash, horizontal
 * bar, hyphens, prime, double prime, guillemets), so a mis-transcribed glyph
 * in the detection table fails here.
 *
 *   bun test extensions/tests/ascii-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { foldToAscii, isProsePath, scan, WRITE_BASH } from "../lib/ascii-core.ts";

// [input code point, expected ASCII, human name fragment]
const CASES: Array<[string, string, string]> = [
  ["—", "-", "em dash"],
  ["–", "-", "en dash"],
  ["‒", "-", "figure"],
  ["―", "-", "horizontal bar"],
  ["‐", "-", "hyphen"],
  ["‑", "-", "non-breaking hyphen"],
  ["‘", "'", "single quote"],
  ["’", "'", "single quote"],
  ["‚", "'", "single quote"],
  ["‛", "'", "single quote"],
  ["“", '"', "double quote"],
  ["”", '"', "double quote"],
  ["„", '"', "double quote"],
  ["‟", '"', "double quote"],
  ["…", "...", "ellipsis"],
  [" ", " ", "non-breaking space"],
  ["′", "'", "prime"],
  ["″", '"', "double prime"],
  ["«", '"', "guillemet"],
  ["»", '"', "guillemet"],
  ["‹", '"', "guillemet"],
  ["›", '"', "guillemet"],
];

describe("ascii-core.foldToAscii - every code point", () => {
  for (const [cp, ascii, label] of CASES) {
    test(`folds ${label} (U+${cp.codePointAt(0)!.toString(16).toUpperCase()}) -> ${JSON.stringify(ascii)}`, () => {
      expect(foldToAscii(`a${cp}b`)).toBe(`a${ascii}b`);
    });
  }

  test("folding a mixed string leaves NO smart punctuation behind", () => {
    const dirty = CASES.map(([cp]) => cp).join("x");
    const folded = foldToAscii(dirty);
    // every fold hit is detected by scan; a clean result must scan empty
    expect(scan(folded)).toEqual([]);
  });

  test("is a no-op on clean ASCII (identity)", () => {
    const s = "plain ascii - quotes ' \" and dots ...";
    expect(foldToAscii(s)).toBe(s);
  });
});

describe("ascii-core.scan - every code point is detected", () => {
  for (const [cp, , label] of CASES) {
    test(`detects ${label}`, () => {
      const found = scan(`x${cp}y`);
      expect(found.length).toBeGreaterThan(0);
    });
  }
});

describe("ascii-core.isProsePath / WRITE_BASH (shared with pi adapter)", () => {
  test("prose extensions + docs/ dirs are prose", () => {
    expect(isProsePath("README.md")).toBe(true);
    expect(isProsePath("src/docs/x.txt")).toBe(true);
    expect(isProsePath("src/index.ts")).toBe(false);
  });
  test("WRITE_BASH matches commit/heredoc/redirect, not a plain echo", () => {
    expect(WRITE_BASH.test("git commit -m x")).toBe(true);
    expect(WRITE_BASH.test("cat > f")).toBe(true);
    expect(WRITE_BASH.test("echo hello")).toBe(false);
  });
});
