/**
 * lookup-before-ask-core unit tests - pure, no harness, no session, no
 * network. Covers the ASK x FACT x own-estate conjunction, the per-sentence
 * evaluation that keeps long discussion messages quiet, the CC
 * AskUserQuestion payload projection, and the advisory decision.
 *
 *   bun test extensions/tests/lookup-before-ask-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  anchoredToOwnEstate,
  asksForOwnInfraFact,
  decideAskContext,
  LOOKUP_TOOLS,
  NUDGE_LINE,
  questionTextFromInput,
} from "../lib/lookup-before-ask-core.ts";

describe("asksForOwnInfraFact - the failure it fires on", () => {
  test("iperf re-record ask (the observed live failure)", () => {
    expect(
      asksForOwnInfraFact("Could you run iperf again and paste the throughput numbers?"),
    ).toBe(true);
  });

  test("'how long is that run?' - ownership by determiner, no possessive", () => {
    expect(asksForOwnInfraFact("How long is that cable run?")).toBe(true);
  });

  test("possessive-anchored spec ask", () => {
    expect(asksForOwnInfraFact("What is your switch's model number?")).toBe(true);
  });
});

describe("asksForOwnInfraFact - deliberately quiet cases", () => {
  test("preference/design question is NOT this failure", () => {
    expect(asksForOwnInfraFact("Do you want Option A or Option B?")).toBe(false);
  });

  test("third-party fact question (no own-estate anchor) does not fire", () => {
    expect(asksForOwnInfraFact("What is the latest version of Postgres?")).toBe(false);
  });

  test("a fact statement with no ask does not fire", () => {
    expect(asksForOwnInfraFact("Your NIC ran at 9.10 Gbps average.")).toBe(false);
  });

  test("per-sentence: signals scattered across a discussion message do NOT fire", () => {
    // ASK in one sentence, FACT in another, anchor in a third -> vacuous match.
    const discuss =
      "Should we detect asks?\nThe throughput figure matters.\nThat cable run is separate.";
    expect(asksForOwnInfraFact(discuss)).toBe(false);
  });

  test("empty / whitespace text is safe", () => {
    expect(asksForOwnInfraFact("")).toBe(false);
    expect(asksForOwnInfraFact("   \n  ")).toBe(false);
  });
});

describe("anchoredToOwnEstate", () => {
  test("kit noun anchors", () => {
    expect(anchoredToOwnEstate("the iperf output")).toBe(true);
    expect(anchoredToOwnEstate("your rack")).toBe(true);
    expect(anchoredToOwnEstate("that host")).toBe(true);
  });
  test("bare third-party sentence is not anchored", () => {
    expect(anchoredToOwnEstate("the latest release notes")).toBe(false);
  });
});

describe("LOOKUP_TOOLS", () => {
  test("contains the canonical lookup tools that disarm the nudge", () => {
    expect(LOOKUP_TOOLS.has("memledger_search")).toBe(true);
    expect(LOOKUP_TOOLS.has("session_search")).toBe(true);
    expect(LOOKUP_TOOLS.has("search_ledger")).toBe(true);
    expect(LOOKUP_TOOLS.has("Read")).toBe(false);
  });
});

describe("questionTextFromInput - CC AskUserQuestion projection", () => {
  test("questions[] array shape (question + option labels)", () => {
    const input = {
      questions: [
        {
          question: "What throughput did iperf report on that run?",
          header: "throughput",
          options: [{ label: "under 5 Gbps" }, { label: "5-10 Gbps" }],
        },
      ],
    };
    const text = questionTextFromInput(input);
    expect(text).toContain("iperf");
    expect(text).toContain("5-10 Gbps");
  });

  test("bare question string shape", () => {
    expect(questionTextFromInput({ question: "How long is that run?" })).toContain(
      "that run",
    );
  });

  test("prompt shape", () => {
    expect(questionTextFromInput({ prompt: "pick one" })).toBe("pick one");
  });

  test("non-object / empty input yields empty string", () => {
    expect(questionTextFromInput(null)).toBe("");
    expect(questionTextFromInput("nope")).toBe("");
    expect(questionTextFromInput({})).toBe("");
  });
});

describe("decideAskContext - advisory (never denies)", () => {
  test("own-infra fact ask -> additionalContext nudge", () => {
    const decision = decideAskContext({
      questions: [{ question: "Can you paste the iperf throughput numbers again?" }],
    });
    expect(decision).not.toBeNull();
    expect(decision!.additionalContext).toBe(NUDGE_LINE);
  });

  test("preference ask -> null (allow silently)", () => {
    expect(decideAskContext({ questions: [{ question: "Option A or B?" }] })).toBeNull();
  });

  test("empty input -> null", () => {
    expect(decideAskContext({})).toBeNull();
  });
});
