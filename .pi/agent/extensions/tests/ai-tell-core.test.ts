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

  test("mystery-tease variants", () => {
    expect(ids("The stunt hides a classic movie trick from the silent era.")).toContain("mystery_tease");
    expect(ids("Here is what they don't tell you about logical replication.")).toContain("mystery_tease");
    expect(ids("You may not know this, but Postgres rewrites the whole row.")).toContain("mystery_tease");
    expect(ids("A little-known setting controls the WAL flush interval.")).toContain("mystery_tease");
    expect(ids("The secret to fast joins is a covering index.")).toContain("mystery_tease");
  });

  test("slop watchlist", () => {
    expect(ids("Let me delve into the details of the replication slot.")).toContain("slop_watchlist");
    expect(ids("This migration is a pivotal moment for the platform.")).toContain("slop_watchlist");
    expect(ids("The rich tapestry of Unix tools.")).toContain("slop_watchlist");
    expect(ids("Our game-changing approach to caching misses constantly.")).toContain("slop_watchlist");
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

  test("testament in technical identifier context still flags (documented trade-off)", () => {
    // 'testament' as prose word IS the slop tell; as part of code it is masked
    expect(ids("The config file `testament.yml` is generated.")).toEqual([]);
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
