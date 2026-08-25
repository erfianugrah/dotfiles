/**
 * Unit tests for describeStatus() in continue-after-error.ts.
 *
 * The 402 split is the point: OpenRouter has two 402 flavors -
 * balance exhausted (openrouter_credits, no Retry-After) vs in-flight
 * budget exhausted (openrouter_in_flight_budget, Retry-After set).
 * The remedies differ (top up vs wait), so must the guidance.
 *
 * Run: ./.pi/agent/tests/run.sh continue-after-error
 */

import { describe, expect, test } from "bun:test";

import { describeStatus } from "../extensions/continue-after-error.ts";

describe("describeStatus", () => {
  test("402 without Retry-After = credits exhausted", () => {
    const { headline, suggest } = describeStatus(402, {}, 1);
    expect(headline).toBe("Provider 402 (payment required).");
    expect(suggest).toContain("Credits exhausted");
    expect(suggest).not.toContain("in-flight");
  });

  test("402 with Retry-After = in-flight budget exhausted, mentions window and credits ceiling", () => {
    const { headline, suggest } = describeStatus(402, { "retry-after": "120" }, 1);
    expect(headline).toContain("in-flight budget exhausted");
    expect(headline).toContain("Retry-After: 120s");
    expect(suggest).toContain("120s");
    expect(suggest).toContain("in-flight requests to settle");
    // the "raises the in-flight budget" credit hint is present too
    expect(suggest).toContain("raises the in-flight budget");
    // but NOT the misleading "credits exhausted" advice
    expect(suggest).not.toContain("Credits exhausted");
  });

  test("402 x-ratelimit-reset header is accepted as discriminator", () => {
    const { headline } = describeStatus(402, { "x-ratelimit-reset": "30" }, 1);
    expect(headline).toContain("Retry-After: 30s");
  });

  test("429 surfaces Retry-After", () => {
    const { headline, suggest } = describeStatus(429, { "retry-after": "60" }, 1);
    expect(headline).toContain("rate-limited");
    expect(headline).toContain("60");
    expect(suggest).toContain("then /continue");
  });

  test("consecutive >= 2 appends switch-model hint on all statuses", () => {
    for (const status of [401, 402, 429]) {
      const { suggest } = describeStatus(status, {}, 2);
      expect(suggest).toContain("RETRY ALREADY FAILED");
      expect(suggest).toContain("/model");
    }
  });

  test("401 points at opencode-zen credits / key rotation", () => {
    const { headline, suggest } = describeStatus(401, {}, 1);
    expect(headline).toContain("401");
    expect(suggest).toContain("auth.json");
  });

  test("unknown status falls through to generic guidance", () => {
    const { headline, suggest } = describeStatus(500, {}, 1);
    expect(headline).toBe("Provider 500.");
    expect(suggest).toContain("billing");
  });
});
