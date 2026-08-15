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

  test("neither file exists -> null", () => {
    expect(resolveRulesPath(mkHome())).toBeNull();
  });

  test("legacy-only install -> legacy path", () => {
    const h = mkHome();
    const legacy = join(h, ".config/opencode");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "AGENTS.md"), "rules");
    expect(resolveRulesPath(h)).toBe(join(h, ".config/opencode/AGENTS.md"));
  });

  test("both present -> canonical pi path wins", () => {
    const h = mkHome();
    const canonical = join(h, ".pi/agent/prompts");
    const legacy = join(h, ".config/opencode");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(canonical, "tool-routing.md"), "rules");
    writeFileSync(join(legacy, "AGENTS.md"), "rules");
    expect(resolveRulesPath(h)).toBe(
      join(h, ".pi/agent/prompts/tool-routing.md"),
    );
  });

  test("candidates list order matches resolution priority", () => {
    const c = rulesPathCandidates("/x");
    expect(c[0]).toBe("/x/.pi/agent/prompts/tool-routing.md");
    expect(c[1]).toBe("/x/.config/opencode/AGENTS.md");
  });
});
