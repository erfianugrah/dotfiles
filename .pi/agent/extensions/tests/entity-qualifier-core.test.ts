/**
 * Pure-core tests for entity-qualifier-core. No session, no harness - just the
 * device-id / evidential / host-qualifier detection over realistic sentences.
 *
 *   bun test extensions/tests/entity-qualifier-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  answerText,
  hasDeviceId,
  hasHostQualifier,
  needsHostQualifier,
  NUDGE_LINE,
} from "../lib/entity-qualifier-core.ts";

describe("entity-qualifier-core / fires", () => {
  test("the real sentence that motivated this file", () => {
    expect(
      needsHostQualifier(
        "you had eth0 flap and downshift-to-100Mbps events on 2026-08-08, and you don't want cable ambiguity",
      ),
    ).toBe(true);
  });

  test("a date next to the identifier does not qualify it", () => {
    expect(needsHostQualifier("we saw br0 drop packets on 2026-08-08")).toBe(true);
  });

  test("nvme with an incident and no host", () => {
    expect(needsHostQualifier("nvme0n1 threw errors during the outage last week")).toBe(true);
  });
});

describe("entity-qualifier-core / stays quiet", () => {
  test("host named via possessive", () => {
    expect(needsHostQualifier("servarr's eth0 flapped last week")).toBe(false);
  });

  test("host named via preposition", () => {
    expect(needsHostQualifier("we saw errors on router eth0 during the outage")).toBe(false);
  });

  test("host:iface addressing", () => {
    expect(needsHostQualifier("servarr:eth0 dropped packets in the incident")).toBe(false);
  });

  test("interface merely named, no evidential claim", () => {
    expect(needsHostQualifier("bind the bridge to br0 and set the MTU")).toBe(false);
  });

  test("empty / whitespace input", () => {
    expect(needsHostQualifier("")).toBe(false);
    expect(needsHostQualifier("   \n  ")).toBe(false);
  });
});

describe("entity-qualifier-core / adversarial", () => {
  test("SDK is not a disk", () => {
    expect(hasDeviceId("the SDK errors last week")).toBe(false);
    expect(needsHostQualifier("the SDK threw errors last week")).toBe(false);
  });

  test("sda IS a disk", () => {
    expect(hasDeviceId("sda has bad blocks")).toBe(true);
  });

  test("cross-sentence signals do not conjoin", () => {
    // device id in one sentence, incident vocabulary in another -> no fire.
    const text = "The interface is eth0. Last week there was an outage on the switch.";
    expect(needsHostQualifier(text)).toBe(false);
  });
});

describe("entity-qualifier-core / helpers", () => {
  test("hasHostQualifier recognises possessive and preposition", () => {
    expect(hasHostQualifier("servarr's eth0")).toBe(true);
    expect(hasHostQualifier("on router eth0")).toBe(true);
    expect(hasHostQualifier("eth0 on 2026-08-08")).toBe(false);
  });

  test("answerText flattens string and block content", () => {
    expect(answerText({ content: "plain string" })).toBe("plain string");
    expect(
      answerText({
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", input: {} },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(answerText({})).toBe("");
  });

  test("NUDGE_LINE names the box and the date trap", () => {
    expect(NUDGE_LINE).toContain("host qualifier");
    expect(NUDGE_LINE).toContain("when, not which box");
  });
});
