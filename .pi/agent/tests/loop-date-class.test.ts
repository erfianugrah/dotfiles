/**
 * SPEC: a `date` claim class for epistemic-guard.
 *
 * Why this exists. On 2026-08-10 the agent was told "10g works right now,
 * I've tested" and wrote `tested 2026-08-10` into a planning doc. The test had
 * actually run in late July; the date was fabricated wholesale from a sentence
 * that contained no date at all, and it survived into a committed artifact
 * because epistemic-guard has no date class - its classes are version, url,
 * cve, perf, flag, syspath. A date that appears in NO tool result and NO user
 * message is recalled by construction, exactly like a version number, and the
 * existing corpus/provenance/footer/block plumbing already knows how to say so.
 *
 * These tests are the contract. Implement against them; do not edit them.
 *
 * Contract:
 *   - ClaimClass gains "date".
 *   - ISO dates (2026-08-10) are claims, keyed verbatim.
 *   - Worded dates ("10 August 2026", "August 10, 2026", "August 2026",
 *     "late July 2026") are claims. Key is normalised: lowercased, commas
 *     stripped, whitespace collapsed, and any leading vagueness qualifier
 *     (early/mid/late) dropped so "late July 2026" and "July 2026" share a key
 *     - the month is the claim, the qualifier is not a separate fact.
 *   - Provenance works the usual way: a date present in absorbed text is
 *     silenced. ISO and worded forms of the SAME month must cross-match, so
 *     absorbing "2026-07" or "July 2026" silences "late July 2026".
 *   - Bookkeeping is not a claim: changelog headings (`## [1.2.0] - 2026-08-10`),
 *     frontmatter/field lines (`date: 2026-08-10`, `Date: 2026-08-10`), and
 *     ISO timestamps inside a longer datetime (2026-08-10T04:03:48Z) are skipped.
 *   - Fenced code blocks yield no date claims (same rule as versions: a fence
 *     is an instruction, not an assertion).
 *   - A date labelled unverified NEXT to the claim is exempt (hedgedNear).
 *   - VERIFY_HINT has a date entry that routes to the session stores, since
 *     that is where a date about the user's own history actually lives.
 */

import { describe, expect, test } from "bun:test";
import {
  extractClaims,
  newCorpus,
  absorb,
  unprovenanced,
  blockReason,
} from "../extensions/epistemic-guard.ts";

const keysOf = (text: string, mode: "prose" | "code" = "prose") =>
  extractClaims(text, mode)
    .filter((c) => c.cls === "date")
    .map((c) => c.key);

describe("epistemic-guard.date / extraction", () => {
  test("ISO dates are claims", () => {
    expect(keysOf("the run was tested 2026-08-10 and passed")).toEqual(["2026-08-10"]);
  });

  test("worded dates are claims, normalised", () => {
    expect(keysOf("shipped 10 August 2026")).toEqual(["10 august 2026"]);
    expect(keysOf("shipped August 10, 2026")).toEqual(["august 10 2026"]);
    expect(keysOf("shipped August 2026")).toEqual(["august 2026"]);
  });

  test("a vagueness qualifier is not part of the claim", () => {
    expect(keysOf("measured late July 2026")).toEqual(["july 2026"]);
    expect(keysOf("measured early July 2026")).toEqual(["july 2026"]);
  });

  test("the same date twice is one claim", () => {
    expect(keysOf("2026-08-10 and again 2026-08-10")).toEqual(["2026-08-10"]);
  });

  test("a bare year or a bare month is not a date claim", () => {
    expect(keysOf("sometime in 2026 it changed")).toEqual([]);
    expect(keysOf("we did it in August")).toEqual([]);
  });

  test("a version triple is not a date", () => {
    expect(keysOf("Caddy 2.11.4 is current")).toEqual([]);
  });
});

describe("epistemic-guard.date / non-assertions", () => {
  test("changelog headings are bookkeeping", () => {
    expect(keysOf("## [1.2.0] - 2026-08-10")).toEqual([]);
    expect(keysOf("## 2026-08-10")).toEqual([]);
  });

  test("frontmatter and field lines are bookkeeping", () => {
    expect(keysOf("date: 2026-08-10")).toEqual([]);
    expect(keysOf("Date: 2026-08-10")).toEqual([]);
    expect(keysOf("Last updated: 2026-08-10")).toEqual([]);
  });

  test("an ISO timestamp is machine output, not a prose date claim", () => {
    expect(keysOf("session 2026-08-10T04:03:48.863Z started")).toEqual([]);
  });

  test("fenced blocks are instructions, not assertions", () => {
    const doc = "prose here.\n\n```\ngit log --since 2026-08-10\n```\n";
    expect(keysOf(doc)).toEqual([]);
  });

  test("a hedge next to the date exempts it", () => {
    expect(keysOf("tested around 2026-08-10 (unverified)")).toEqual([]);
  });
});

describe("epistemic-guard.date / provenance", () => {
  test("a date seen in tool output is silenced", () => {
    const c = newCorpus();
    absorb(c, "commit 4a214e6 authored 2026-08-10");
    const claims = extractClaims("we shipped it 2026-08-10", "prose");
    expect(unprovenanced(c, claims, new Set())).toEqual([]);
  });

  test("an unseen date is surfaced", () => {
    const c = newCorpus();
    absorb(c, "commit 4a214e6 authored 2026-07-31");
    const claims = extractClaims("we shipped it 2026-08-10", "prose");
    const hits = unprovenanced(c, claims, new Set());
    expect(hits.map((h) => h.key)).toEqual(["2026-08-10"]);
  });

  test("ISO provenance silences the worded form of the same month", () => {
    const c = newCorpus();
    absorb(c, "iperf run recorded 2026-07-31");
    const claims = extractClaims("measured late July 2026", "prose");
    expect(unprovenanced(c, claims, new Set())).toEqual([]);
  });

  test("worded provenance silences the worded claim", () => {
    const c = newCorpus();
    absorb(c, "the capture happened in July 2026");
    const claims = extractClaims("measured late July 2026", "prose");
    expect(unprovenanced(c, claims, new Set())).toEqual([]);
  });

  test("a different month is NOT provenance", () => {
    const c = newCorpus();
    absorb(c, "the capture happened in June 2026");
    const claims = extractClaims("measured late July 2026", "prose");
    expect(unprovenanced(c, claims, new Set()).length).toBe(1);
  });
});

describe("epistemic-guard.date / messaging", () => {
  test("the block message routes a date to the session stores", () => {
    const claims = extractClaims("we tested it 2026-08-10", "prose");
    const msg = blockReason(claims, "write");
    expect(msg).toContain("2026-08-10");
    expect(msg).toMatch(/memledger|session store|ledger/i);
  });

  test("the real regression: a fabricated test date is caught", () => {
    // Verbatim shape of the 2026-08-10 miss - the user said "I've tested",
    // the agent supplied a date nothing had stated.
    const c = newCorpus();
    absorb(c, "10g works right now, I've tested");
    const claims = extractClaims("The existing wall run is proven (tested 2026-08-10).", "prose");
    const hits = unprovenanced(c, claims, new Set());
    expect(hits.some((h) => h.cls === "date" && h.key === "2026-08-10")).toBe(true);
  });
});
