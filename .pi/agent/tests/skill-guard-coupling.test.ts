/**
 * Skill<->guard coupling test for the secret-handling skill.
 *
 * The skill documents escape hatches and anti-patterns in fenced ```bash
 * blocks. The guard (lib/secret-output-guard-core.ts) enforces the same
 * contract at the tool boundary. Before this test, the two were separate
 * artifacts with nothing asserting they agree - and that drift bit live
 * 2026-08-30: the skill's documented `env | grep ^NAME` escape was blocked
 * by the guard itself (four doc locations had to be fixed in one commit).
 *
 * Contract: every fenced bash block in the skill is annotated with an HTML
 * comment immediately above it:
 *   <!-- good -->  - no guard rule may fire on any command line
 *   <!-- bad -->   - every command line must fire at least one guard rule
 *
 * Both directions are load-bearing:
 *   good block fires  -> the skill documents an escape the guard blocks
 *                        (the 2026-08-30 incident, silent until this test)
 *   bad line  no fire -> the guard lost a rule OR the example is wrong,
 *                        so the "Never" section promises protection the
 *                        guard no longer provides
 *
 * Unannotated bash fences fail the suite: new examples must opt into the
 * contract explicitly.
 *
 * Run: ./.pi/agent/tests/run.sh skill-guard-coupling
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { splitSegments } from "../extensions/lib/tool-guard-core.ts";
import {
  envDumpSegment,
  plaintextPipelineSegment,
} from "../extensions/lib/secret-output-guard-core.ts";

const SKILL_PATH = fileURLToPath(
  new URL("../skills/secret-handling/SKILL.md", import.meta.url),
);

type Annotation = "good" | "bad";

interface FencedBlock {
  annotation: Annotation;
  lines: string[];
  startLine: number; // 1-indexed, the opening fence
}

/** Extract (annotation, fenced-bash-block) pairs. A block is annotated by the
 *  nearest preceding HTML comment (`<!-- good -->` / `<!-- bad -->`) with no
 *  other non-blank line between them. */
function parseBlocks(md: string): FencedBlock[] {
  const lines = md.split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith("```bash")) {
      const startLine = i + 1;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      expect(i < lines.length).toBe(true, `unterminated bash fence at line ${startLine}`);
      i++; // closing fence

      // Nearest preceding non-blank line must be the annotation comment.
      let j = startLine - 2; // the line above the opening fence (0-indexed)
      while (j >= 0 && lines[j].trim() === "") j--;
      expect(j >= 0).toBe(true, `bash fence at line ${startLine} has no preceding annotation`);
      const m = lines[j].trim().match(/^<!--\s*(good|bad)\s*-->$/);
      expect(m).not.toBeNull(
        `bash fence at line ${startLine} must be annotated <!-- good --> or <!-- bad --> on the line above, got: ${lines[j].trim()}`,
      );
      blocks.push({
        annotation: m![1] as Annotation,
        lines: body,
        startLine,
      });
    }
    i++;
  }
  return blocks;
}

/** The guard verdict for one command line, exactly as the extension applies
 *  it: splitSegments first, then both rule families. */
function guardHit(line: string): string | null {
  const segments = splitSegments(line);
  return envDumpSegment(segments) ?? plaintextPipelineSegment(segments);
}

/** Command lines: skip blanks and # comments (fence bodies carry intent
 *  comments that are not commands). */
function commandLines(lines: string[]): string[] {
  return lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

const blocks = parseBlocks(readFileSync(SKILL_PATH, "utf8"));

describe("skill-guard-coupling", () => {
  test("the skill carries annotated bash fences", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.some((b) => b.annotation === "good")).toBe(true);
    expect(blocks.some((b) => b.annotation === "bad")).toBe(true);
  });

  for (const block of blocks) {
    const cmds = commandLines(block.lines);
    test(`<!-- ${block.annotation} --> fence @${block.startLine} has command lines`, () => {
      expect(cmds.length).toBeGreaterThan(0, "fence contains no command lines (only comments?)");
    });
    if (block.annotation === "bad") {
      test(`<!-- bad --> fence @${block.startLine}: every line fires`, () => {
        for (const line of cmds) {
          expect(guardHit(line)).not.toBeNull(
            `bad block line must be blocked by the guard, got no rule firing:\n  ${line}`,
          );
        }
      });
    } else {
      test(`<!-- good --> fence @${block.startLine}: no line fires`, () => {
        for (const line of cmds) {
          expect(guardHit(line)).toBeNull(
            `good block line must NOT be blocked - the skill documents this as an allowed form:\n  ${line}`,
          );
        }
      });
    }
  }
});
