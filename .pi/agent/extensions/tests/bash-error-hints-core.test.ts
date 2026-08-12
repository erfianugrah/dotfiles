/**
 * bash-error-hints-core unit tests - pure, no harness, no network, no bash.
 * Exercises the pattern table, $-substitution renderer, matcher, the
 * oncePerSession splitter, the defensive content extractor, and the decorate
 * body builder against realistic stderr fixtures.
 *
 *   bun test extensions/tests/bash-error-hints-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  HINTS,
  HINT_MARKER,
  applyOncePerSession,
  decorate,
  extractText,
  matchHints,
  matchHintsDetailed,
  renderHint,
} from "../lib/bash-error-hints-core.ts";

describe("renderHint - $N substitution", () => {
  test("substitutes capture groups", () => {
    const m = "abc".match(/(a)(b)/)!;
    expect(renderHint("g1=$1 g2=$2 g3=$3", m)).toBe("g1=a g2=b g3=");
  });

  test("leaves literal text intact when there are no captures", () => {
    const m = "x".match(/x/)!;
    expect(renderHint("no groups here", m)).toBe("no groups here");
  });
});

describe("matchHints - realistic stderr fixtures", () => {
  test("git mv on a gitignored file surfaces the check-ignore hint with the filename", () => {
    const stderr =
      "fatal: not under version control, source=notes/plan.md, destination=notes/PLAN.md";
    const hits = matchHints(stderr);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("notes/plan.md");
    expect(hits[0]).toContain("git check-ignore -v notes/plan.md");
  });

  test("pathspec-did-not-match interpolates the pathspec", () => {
    const stderr = "error: pathspec 'src/foo.ts' did not match any file(s) known to git";
    const hits = matchHints(stderr);
    expect(hits[0]).toContain("'src/foo.ts' is unknown to git");
  });

  test("command not found names the missing binary", () => {
    const stderr = "bash: kubctl: command not found";
    const hits = matchHints(stderr);
    expect(hits.some((h) => h.includes("'kubctl' isn't in PATH"))).toBe(true);
  });

  test("git author override is caught in the command echo (preventative, not an error)", () => {
    const cmd = 'git -c user.email=erfi@erfi.io commit -m "wip"';
    const hits = matchHints(cmd);
    expect(hits.some((h) => h.includes("Author/committer override detected"))).toBe(true);
  });

  test("TSIG leak triggers the rotate-now hint", () => {
    const out = ";; ->>HEADER<<- opcode: QUERY\n; TSIG: erfi.io-axfr.";
    const hits = matchHints(out);
    expect(hits.some((h) => h.includes("Rotate now"))).toBe(true);
  });

  test("session jsonl path triggers the session_search routing hint", () => {
    const out = "cat /Users/erfi/.pi/agent/sessions/2026-08-12-abc.jsonl";
    const hits = matchHints(out);
    expect(hits.some((h) => h.includes("session_search"))).toBe(true);
  });

  test("clean output produces no hints", () => {
    expect(matchHints("Cloning into 'repo'...\ndone.")).toEqual([]);
  });

  test("multiple independent footguns in one blob all fire", () => {
    const out =
      "fatal: not a git repository\n" +
      "bash: frobnicate: command not found";
    const hits = matchHints(out);
    expect(hits.length).toBe(2);
  });
});

describe("HINTS - sanity invariants", () => {
  test("every hint has a RegExp pattern and a non-empty string hint", () => {
    for (const h of HINTS) {
      expect(h.pattern).toBeInstanceOf(RegExp);
      expect(typeof h.hint).toBe("string");
      expect(h.hint.length).toBeGreaterThan(0);
    }
  });

  test("exactly one hint is marked oncePerSession (the session-jsonl router)", () => {
    const once = HINTS.filter((h) => h.oncePerSession);
    expect(once.length).toBe(1);
    expect(once[0].pattern.source).toContain("sessions");
  });
});

describe("applyOncePerSession", () => {
  test("first fire of a once-hint is kept and reported as newlyFired", () => {
    const matches = matchHintsDetailed(
      "cat /Users/erfi/.pi/agent/sessions/x.jsonl",
    );
    const { kept, newlyFired } = applyOncePerSession(matches, new Set());
    expect(kept.length).toBe(1);
    expect(newlyFired.length).toBe(1);
  });

  test("a once-hint already fired this session is dropped", () => {
    const matches = matchHintsDetailed(
      "cat /Users/erfi/.pi/agent/sessions/x.jsonl",
    );
    const already = new Set(matches.map((m) => m.hint.pattern.source));
    const { kept, newlyFired } = applyOncePerSession(matches, already);
    expect(kept.length).toBe(0);
    expect(newlyFired.length).toBe(0);
  });

  test("repeatable (error) hints are never suppressed", () => {
    const matches = matchHintsDetailed("fatal: not a git repository");
    const first = applyOncePerSession(matches, new Set());
    const second = applyOncePerSession(matches, new Set(first.newlyFired));
    expect(second.kept.length).toBe(1);
  });
});

describe("extractText - defensive content parsing", () => {
  test("passes a plain string through", () => {
    expect(extractText("hello")).toBe("hello");
  });

  test("concatenates text parts from a content array", () => {
    const content = [
      { type: "text", text: "line1" },
      { type: "image" },
      { type: "text", text: "line2" },
    ];
    expect(extractText(content)).toBe("line1\nline2\n");
  });

  test("non-array non-string yields empty", () => {
    expect(extractText({ foo: "bar" })).toBe("");
  });
});

describe("decorate - body builder", () => {
  test("appends a marker-delimited bullet list of hints", () => {
    const matches = matchHintsDetailed("fatal: not a git repository");
    const body = decorate("fatal: not a git repository", matches)!;
    expect(body).toContain(HINT_MARKER);
    expect(body).toContain("• Wrong cwd");
    expect(body.startsWith("fatal: not a git repository")).toBe(true);
  });

  test("returns null when already decorated (idempotent)", () => {
    const matches = matchHintsDetailed("fatal: not a git repository");
    const once = decorate("fatal: not a git repository", matches)!;
    expect(decorate(once, matches)).toBeNull();
  });

  test("returns null with no matches", () => {
    expect(decorate("all good", [])).toBeNull();
  });
});
