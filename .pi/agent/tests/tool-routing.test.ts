/**
 * Unit tests for the pure/path helpers in tool-routing.ts.
 *
 * Run: ./.pi/agent/tests/run.sh tool-routing
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  rulesPathCandidates,
  resolveRulesPath,
  sliceRules,
} from "../extensions/tool-routing.ts";

describe("sliceRules", () => {
  test("slices above the end marker", () => {
    const content = "rules here\n\n<!-- tool-routing:end -->\nopencode-only tail";
    expect(sliceRules(content)).toBe("rules here");
  });

  test("falls back to the legacy Documentation boundary", () => {
    const content = "rules here\n\n## Documentation\n\ndocs tail";
    expect(sliceRules(content)).toBe("rules here");
  });

  test("end marker wins over the legacy boundary", () => {
    const content =
      "rules\n\n<!-- tool-routing:end -->\ntail\n\n## Documentation\n\nmore";
    expect(sliceRules(content)).toBe("rules");
  });

  test("no marker returns the whole trimmed file", () => {
    expect(sliceRules("  everything\n")).toBe("everything");
  });

  test("whitespace-only file returns null", () => {
    expect(sliceRules("   \n")).toBeNull();
  });

  test("marker at position 0 falls through to the whole file (legacy semantics)", () => {
    // end > 0 guard in sliceRules: a marker at offset 0 is treated as
    // "no usable slice", same as the pre-refactor code.
    const content = "<!-- tool-routing:end -->\ntail";
    expect(sliceRules(content)).toBe(content);
  });
});

describe("resolveRulesPath", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function mkHome(): string {
    home = mkdtempSync(join(tmpdir(), "tool-routing-test-"));
    return home;
  }

  test("nothing exists -> null", () => {
    expect(resolveRulesPath(mkHome(), undefined)).toBeNull();
  });

  test("home prompts path is found (hand-rolled / stow live install)", () => {
    const h = mkHome();
    const prompts = join(h, ".pi/agent/prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "tool-routing.md"), "rules");
    expect(resolveRulesPath(h, undefined)).toBe(
      join(h, ".pi/agent/prompts/tool-routing.md"),
    );
  });

  test("self-relative path wins (pi-package checkout layout)", () => {
    const h = mkHome();
    // fake package checkout: <pkg>/.pi/agent/{extensions,prompts}
    const pkg = join(h, "pkg/.pi/agent");
    const extDir = join(pkg, "extensions");
    mkdirSync(extDir, { recursive: true });
    mkdirSync(join(pkg, "prompts"), { recursive: true });
    writeFileSync(join(pkg, "prompts", "tool-routing.md"), "rules");
    // home path ALSO exists - self-relative must win
    const prompts = join(h, ".pi/agent/prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "tool-routing.md"), "rules");
    expect(resolveRulesPath(h, extDir)).toBe(
      join(pkg, "prompts", "tool-routing.md"),
    );
  });

  test("candidates: selfDir omitted -> home path only", () => {
    expect(rulesPathCandidates("/x", undefined)).toEqual([
      "/x/.pi/agent/prompts/tool-routing.md",
    ]);
  });

  test("candidates: selfDir present -> self-relative first, home second", () => {
    // join() normalizes the ".." away
    expect(rulesPathCandidates("/x", "/pkg/extensions")).toEqual([
      "/pkg/prompts/tool-routing.md",
      "/x/.pi/agent/prompts/tool-routing.md",
    ]);
  });
});
