/**
 * ai-tell-core unit tests - pure, no harness.
 *
 *   bun test extensions/tests/ai-tell-core.test.ts
 *
 * Every fixture here is a REAL example from observed AI output (the 2026-08-27
 * Reddit thread roasting an AI-written post about The Mummy bookcase scene, plus
 * the erfi-voice kill-list). The false-positive cases are equally real: prose
 * from this very repo that must keep passing.
 */

import { describe, expect, test } from "bun:test";
import { isProsePath, scanTells, TELL_RULES, tellReason } from "../lib/ai-tell-core.ts";

const ids = (text: string) => scanTells(text).map((h) => h.rule.id);

describe("detection", () => {
  test("not just X, but Y", () => {
    expect(ids("This is not just a cache, but a whole subsystem for reads.")).toContain(
      "negative_parallelism_not_just",
    );
  });

  test("it isn't about X, it's about Y", () => {
    expect(ids("It isn't about the tools, it's about the discipline.")).toContain(
      "negative_parallelism_isnt_about",
    );
  });

  test("No X, no Y. Just Z.", () => {
    expect(ids("No CGI, no extra take. Just a desire to make art.")).toContain(
      "aphorism_no_x_no_y_just_z",
    );
  });

  test("cross-sentence It's not X. It's Y.", () => {
    expect(ids("It's not a bug in the parser. It's a feature of the tokenizer.")).toContain(
      "negative_parallelism_cross_sentence",
    );
  });

  test("the 'not a bug, a feature' joke is caught ON PURPOSE", () => {
    // Looks like a false positive (the joke predates LLMs) and will tempt a
    // future reader to narrow the rule. User decision 2026-08-27: keep it,
    // the line is overused. This test exists to make removing it a visible,
    // deliberate act rather than a quiet 'precision fix'.
    expect(ids("It's not a bug. It's a feature of the design.")).toContain(
      "negative_parallelism_cross_sentence",
    );
  });

  test("mystery-tease variants", () => {
    expect(ids("The stunt hides a classic movie trick from the silent era.")).toContain("mystery_tease");
    expect(ids("Here is what they don't tell you about logical replication.")).toContain("mystery_tease");
    expect(ids("You may not know this, but Postgres rewrites the whole row.")).toContain("mystery_tease");
    expect(ids("A little-known setting controls the WAL flush interval.")).toContain("mystery_tease");
    expect(ids("The secret to fast joins is a covering index.")).toContain("mystery_tease");
  });

  test("slop watchlist", () => {
    expect(ids("Let me delve into the details of the replication slot.")).toContain("slop_watchlist");
    expect(ids("The rich tapestry of Unix tools makes this hard.")).toContain("slop_watchlist");
    expect(ids("Our game-changing approach to caching misses constantly.")).toContain("slop_watchlist");
    expect(ids("This release stands as a testament to the team's work.")).toContain("slop_watchlist");
  });

  test("watchlist words dropped on review are NOT blocked (guidance, not gate)", () => {
    // erfi-voice still flags these; a hard block on them false-positives on
    // quoted upstream docs, so the guard deliberately lets them through.
    for (const s of [
      "This migration is a pivotal moment for the platform team.",
      "The library provides a robust retry mechanism for callers.",
      "Playback is seamless across the two storage backends here.",
      "Foster care records are stored in the same table as this.",
      "Cutting-edge is marketing language, but the API is stable.",
    ]) {
      expect(ids(s)).toEqual([]);
    }
  });

  test("the motivating OP sentence hits multiple rules", () => {
    // shape reconstructed from the Reddit thread: bold, em dash, reveal-tease,
    // tautological participle tail. The guard catches the regex-able subset.
    const hits = ids(
      "The switch **hides a classic movie trick** - a stuntwoman doubling for the lead, making it look like one continuous shot.",
    );
    expect(hits).toContain("mystery_tease");
  });
});

describe("false positives must not fire", () => {
  test("plain technical prose from this repo", () => {
    const prose = [
      "The cache stores a response for each request. A later request with the same key reads that stored response instead of calling the model again.",
      "When two prompts differ only in wording, the exact-match cache misses. This costs a full model call.",
      "Install the component before you start the service. If hot oil touches your skin, it can cause burns.",
      "We do not rely on theoretical values alone. Test them and report what you actually observed.",
    ];
    for (const p of prose) expect(ids(p)).toEqual([]);
  });

  test("ordinary 'but' contrast without the 'not just' scaffold", () => {
    expect(ids("The tool is fast, but it skips symlinks.")).toEqual([]);
  });

  test("negation that is not parallelism", () => {
    expect(ids("This is not a misconfiguration - the image needs the tunnel.")).toEqual([]);
    expect(ids("The feature is not available in the free tier.")).toEqual([]);
  });

  test("'No' sentences that are just negation", () => {
    expect(ids("No valid Arr instances found in the config.")).toEqual([]);
    expect(ids("No, that path is not the one we took.")).toEqual([]);
  });

  test("quoted / code-span examples are masked", () => {
    // this is exactly how erfi-voice's own kill-list documents the tells
    expect(ids('Kill on sight: "not just X, but Y" and "No X, no Y. Just Z."')).toEqual([]);
    expect(ids("The tell: `not just X, but Y` in any form.")).toEqual([]);
  });

  test("short fragments below minWords are skipped", () => {
    expect(ids("not just one, but two")).toEqual([]);
  });

  test("code-span content is masked", () => {
    expect(ids("The generated config file `tapestry.yml` holds the mapping.")).toEqual([]);
  });
});

describe("bash surface (regression: quoted-span masking must not blank the payload)", () => {
  // Found in review 2026-08-27: with file-surface masking, a double-quoted
  // commit message scanned CLEAN while the single-quoted form was caught -
  // i.e. the guard was silently dead for the most common commit idiom.
  const bashIds = (t: string) => scanTells(t, undefined, "bash").map((h) => h.rule.id);

  test("double-quoted commit message is scanned", () => {
    expect(bashIds('git commit -m "This is not just a cache, but a whole subsystem"')).toContain(
      "negative_parallelism_not_just",
    );
  });

  test("single-quoted commit message is scanned", () => {
    expect(bashIds("git commit -m 'No CGI, no extra take. Just a desire to make art.'")).toContain(
      "aphorism_no_x_no_y_just_z",
    );
  });

  test("heredoc body is scanned", () => {
    expect(bashIds("cat >> notes.md <<EOF\nIt is not just a stunt, but a showcase of the era\nEOF")).toContain(
      "negative_parallelism_not_just",
    );
  });

  test("code spans are still masked on the bash surface", () => {
    expect(bashIds('git commit -m "document the `not just X, but Y` tell"')).toEqual([]);
  });

  test("file surface keeps quoted-example masking", () => {
    expect(scanTells('Never write "not just X, but Y" in any doc you publish.', undefined, "file")).toEqual([]);
  });
});

describe("reason output", () => {
  test("includes rule id, count, sample, and kill switch", () => {
    const hits = scanTells("This is not just a cache, but a whole subsystem for reads.");
    const r = tellReason(hits, "write -> README.md");
    expect(r).toContain("ai-tell-guard");
    expect(r).toContain("negative_parallelism_not_just");
    expect(r).toContain("PI_AI_TELL_GUARD_OFF=1");
    expect(r).toContain("README.md");
  });

  test("file surface advertises the quoting escape; bash surface must NOT", () => {
    const hits = scanTells("This is not just a cache, but a whole subsystem for reads.");
    expect(tellReason(hits, "write -> x.md", "file")).toContain("double quotes");
    // On bash the quoting 'escape' does not exist, and advertising it would be
    // both false and an invitation to quote-wrap prose to evade the guard.
    const bash = tellReason(hits, "bash (writes/commits)", "bash");
    expect(bash).not.toContain("double quotes");
    expect(bash).toContain("Rewrite the sentence");
  });
});

describe("isProsePath", () => {
  test("prose extensions and docs dirs", () => {
    expect(isProsePath("README.md")).toBe(true);
    expect(isProsePath("notes.txt")).toBe(true);
    expect(isProsePath("docs/guide.md")).toBe(true);
  });
  test("code and config files are not prose", () => {
    expect(isProsePath("main.ts")).toBe(false);
    expect(isProsePath("compose.yaml")).toBe(false);
    expect(isProsePath("ai-tell-core.ts")).toBe(false);
  });
});

describe("rule table sanity", () => {
  test("every rule has id, pattern, reason; patterns are global+case-insensitive", () => {
    for (const r of TELL_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.reason.length).toBeGreaterThan(20);
      expect(r.pattern.flags).toContain("g");
      expect(r.pattern.flags).toContain("i");
    }
  });
});
