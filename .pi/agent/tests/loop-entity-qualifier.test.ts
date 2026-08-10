/**
 * SPEC: entity-qualifier-nudge - a bare device identifier used as EVIDENCE
 * must name the host it belongs to.
 *
 * Why this exists. On 2026-08-10 the agent argued for buying better 10G
 * cabling by citing a flap-and-downshift incident "on eth0". That eth0 is an
 * onboard 1G Realtek on a bridge; the 10G path under discussion is a
 * different card entirely. The cited fact was real, the argument built from
 * it was fabricated, and the record it came from HAD the qualifiers - they
 * were dropped in the retelling.
 *
 * This cannot check whether the right entity was picked; that is the
 * reasoning being policed. What it can do is force the disambiguation:
 * writing "servarr's eth0" is the moment the mismatch becomes visible.
 *
 * These tests are the contract. Implement against them; do not edit them.
 *
 * Contract - `needsHostQualifier(text)` is true when ALL hold:
 *   1. the text contains a device identifier: eth0, enp2s0f0np0, eno1, ens5,
 *      wlan0, br0, bond0, nvme0n1, sda, sdb1, or a switch port like eth0/1/1;
 *   2. the text contains evidential/incident vocabulary - it is being used as
 *      EVIDENCE, not merely named (flap, flapped, downshift, incident,
 *      outage, dropped, retrain, errors, crashed, "you had", "we saw",
 *      "last week", "the earlier", "back in");
 *   3. no host qualifier accompanies it: no "on <name>" / "at <name>" /
 *      "for <name>", no "<name>'s <iface>", no "<host>:<iface>".
 *
 * A qualifier must be a NAME, not a date: "events on 2026-08-08" does not
 * qualify anything, and that is exactly the sentence that shipped.
 *
 * Naming an interface without making a claim from it is fine - configuration
 * writing, command lines and plain description must stay silent.
 */

import { describe, expect, test } from "bun:test";
import {
  needsHostQualifier,
  NUDGE_LINE as ENTITY_NUDGE,
} from "../extensions/entity-qualifier-nudge.ts";

describe("entity-qualifier-nudge / fires", () => {
  test("the real sentence that motivated this", () => {
    expect(
      needsHostQualifier(
        "you had eth0 flap and downshift-to-100Mbps events on 2026-08-08, and you don't want cable ambiguity",
      ),
    ).toBe(true);
  });

  test("incident vocabulary with a bare interface", () => {
    expect(needsHostQualifier("the earlier eth0 outage was never root-caused")).toBe(true);
    expect(needsHostQualifier("we saw br0 drop packets last week")).toBe(true);
    expect(needsHostQualifier("nvme0n1 threw errors back in June")).toBe(true);
  });

  test("a switch port identifier counts", () => {
    expect(needsHostQualifier("eth0/1/1 flapped during the incident")).toBe(true);
  });
});

describe("entity-qualifier-nudge / stays quiet", () => {
  test("a host qualifier satisfies it", () => {
    expect(needsHostQualifier("servarr's eth0 flapped and downshifted on 2026-08-08")).toBe(false);
    expect(needsHostQualifier("we saw eth0 flap on servarr last week")).toBe(false);
    expect(needsHostQualifier("the eth0 outage at nixos was never root-caused")).toBe(false);
  });

  test("a date is not a host qualifier", () => {
    // "on 2026-08-08" must NOT count - this is the precise defect.
    expect(needsHostQualifier("eth0 flapped on 2026-08-08")).toBe(true);
  });

  test("naming an interface without an evidential claim is fine", () => {
    expect(needsHostQualifier("eth0 is the onboard NIC and enp2s0f0np0 is the trunk")).toBe(false);
    expect(needsHostQualifier("set the MTU on eth0 to 9014")).toBe(false);
  });

  test("evidential language with no identifier is fine", () => {
    expect(needsHostQualifier("the switch flapped last week during the incident")).toBe(false);
  });

  test("empty input is fine", () => {
    expect(needsHostQualifier("")).toBe(false);
    expect(needsHostQualifier("   \n  ")).toBe(false);
  });
});

// Found by an adversarial pass AFTER the loop went green on the spec above.
// Every one of these is a gap in the original contract, not a loop failure -
// the implementation matched what was written.
describe("entity-qualifier-nudge / adversarial", () => {
  test("three-letter words are not block devices", () => {
    expect(needsHostQualifier("the SDK errors last week were unrelated")).toBe(false);
    expect(needsHostQualifier("our sdk dropped support back in June")).toBe(false);
    // ...but a real one still counts
    expect(needsHostQualifier("sda1 errors last week")).toBe(true);
  });

  test("a hostname directly before the interface qualifies", () => {
    expect(needsHostQualifier("servarr eth0 flapped last week")).toBe(false);
    expect(needsHostQualifier("nixos enp2s0f0np0 dropped packets last week")).toBe(false);
  });

  test("a verb before the interface is not a hostname", () => {
    expect(needsHostQualifier("we saw eth0 flap last week")).toBe(true);
    expect(needsHostQualifier("you had eth0 drop packets")).toBe(true);
  });

  test("a possessive determiner does not name a box", () => {
    expect(needsHostQualifier("I saw errors on my br0 bridge last week")).toBe(true);
    expect(needsHostQualifier("errors on your eth0 last week")).toBe(true);
  });

  test("signals must co-occur in ONE sentence, not across the message", () => {
    const scattered =
      "The trunk is enp2s0f0np0 and it carries five VLANs.\n\n" +
      "Separately, there was an outage last week that we never root-caused.";
    expect(needsHostQualifier(scattered)).toBe(false);

    const together = "Separately, enp2s0f0np0 had an outage last week.";
    expect(needsHostQualifier(together)).toBe(true);
  });
});

describe("entity-qualifier-nudge / message", () => {
  test("the nudge names the failure and the fix", () => {
    expect(ENTITY_NUDGE).toMatch(/host/i);
    expect(ENTITY_NUDGE).toMatch(/PI_ENTITY_NUDGE_OFF/);
  });
});
