/**
 * Tests for resume-after-compact.ts + the trigger-compact:auto marker contract.
 *
 * Regression target (incident 2026-08-31): trigger-compact.ts auto-fires every
 * threshold compaction on this box via ctx.compact(), which pi reports with
 * reason "manual" - so resume-after-compact's manual guard silently skipped
 * EVERY auto-compaction and no auto-resume ever fired. The marker is a custom
 * session entry (NOT shared module state: pi's loader isolates lib/ modules
 * per extension - probed 2026-08-31).
 *
 * Second regression (same incident): for extension-triggered compaction,
 * agent_settled fires BEFORE session_compact, so a resume armed in
 * session_compact never had a delivery event. When ctx.isIdle() is true the
 * handler now fires the resume directly from session_compact.
 *
 * Third regression (run15/run16 repro, 2026-08-31): pi's ctx sendUserMessage
 * is fire-and-forget and _emitAgentSettled clears the active flag BEFORE
 * emitting, so waitForIdle() alone returns instantly and print mode disposes
 * the session while the resumed run is still starting - it is aborted before
 * its first event persists. sendResume therefore polls isIdle until the
 * resumed run is actually in flight (with a 30s ceiling for a silently
 * rejected send) and only then parks on waitForIdle; a resuming flag keeps
 * the resumed turn's own agent_settled from re-entering.
 *
 * Run: ./.pi/agent/tests/run.sh resume-after-compact
 */

import { describe, expect, mock, test } from "bun:test";

import resumeAfterCompact from "../extensions/resume-after-compact.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

let sessionSeq = 0;

function makeHarness(
  opts: {
    hasUI?: boolean;
    /** fixed isIdle override; when undefined, isIdle reflects the fake run state */
    idle?: boolean;
    /** keep the fake resumed run busy until finishRun() is called */
    holdRun?: boolean;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const notified: string[] = [];
  const entries: unknown[] = [];
  const runState = { busy: false };
  const idleWaiters: Array<() => void> = [];
  let idleOverride: boolean | undefined = opts.idle;

  const finishRun = () => {
    runState.busy = false;
    for (const r of idleWaiters.splice(0)) r();
  };

  const pi = {
    on: (type: string, h: Handler) => {
      const arr = handlers.get(type) ?? [];
      arr.push(h);
      handlers.set(type, arr);
    },
    // The real binding is fire-and-forget: the nested prompt() flips the
    // active flag only after several awaits. Simulated by flipping busy on a
    // queued microtask, so any await of sendUserMessage sees busy already set.
    sendUserMessage: mock(async (text: string) => {
      sent.push(text);
      queueMicrotask(() => {
        runState.busy = true;
        if (!opts.holdRun) setTimeout(finishRun, 5);
      });
    }),
  };
  const file = `/tmp/rac-test-${++sessionSeq}.jsonl`;
  const ctx = {
    hasUI: opts.hasUI ?? false,
    ui: { notify: (msg: string) => notified.push(msg) },
    sessionManager: { getSessionFile: () => file, getEntries: () => entries },
    isIdle: async () => idleOverride ?? !runState.busy,
    waitForIdle: async () => {
      if (!runState.busy) return;
      await new Promise<void>((r) => idleWaiters.push(r));
    },
  };
  const fire = async (type: string, event: unknown = {}) => {
    for (const h of handlers.get(type) ?? []) await h(event, ctx);
  };
  const addMarker = (id: string, ageMs = 1000) => {
    entries.push({
      id,
      type: "custom",
      customType: "trigger-compact:auto",
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      data: { at: Date.now() - ageMs },
    });
  };
  const setIdleOverride = (v: boolean | undefined) => {
    idleOverride = v;
  };
  return { pi, fire, sent, notified, entries, addMarker, finishRun, setIdleOverride, runState };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const cleanTurn = {
  messages: [{ role: "assistant", stopReason: "stop" }],
};
const errorTurn = {
  messages: [
    { role: "user" },
    { role: "assistant", stopReason: "error", errorMessage: "The operation was aborted." },
  ],
};

describe("resume-after-compact", () => {
  test("error turn + marked manual compaction, agent idle -> resume sent from session_compact", async () => {
    const { pi, fire, sent, addMarker } = makeHarness();
    resumeAfterCompact(pi as never);

    await fire("agent_end", errorTurn);
    addMarker("m1");
    await fire("session_compact", { reason: "manual", willRetry: false });

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("interrupted before completing");
  });

  test("error turn + genuine user /compact (no marker entry) -> no resume", async () => {
    const { pi, fire, sent } = makeHarness();
    resumeAfterCompact(pi as never);

    await fire("agent_end", errorTurn);
    await fire("session_compact", { reason: "manual", willRetry: false });
    await fire("agent_settled");

    expect(sent.length).toBe(0);
  });

  test("already-consumed marker id -> treated as user /compact", async () => {
    const { pi, fire, sent, addMarker } = makeHarness();
    resumeAfterCompact(pi as never);

    await fire("agent_end", errorTurn);
    addMarker("m1");
    await fire("session_compact", { reason: "manual", willRetry: false });
    expect(sent.length).toBe(1);

    // A second compaction citing the same marker must not resume again.
    await fire("agent_end", errorTurn);
    await fire("session_compact", { reason: "manual", willRetry: false });
    expect(sent.length).toBe(1);
  });

  test("stale marker (older than max age) -> no resume", async () => {
    const { pi, fire, sent, addMarker } = makeHarness();
    resumeAfterCompact(pi as never);

    await fire("agent_end", errorTurn);
    addMarker("m-old", 10 * 60_000);
    await fire("session_compact", { reason: "manual", willRetry: false });

    expect(sent.length).toBe(0);
  });

  test("clean turn + marked manual compaction, headless -> resume sent", async () => {
    const { pi, fire, sent, addMarker } = makeHarness({ hasUI: false });
    resumeAfterCompact(pi as never);

    await fire("agent_end", cleanTurn);
    addMarker("m2");
    await fire("session_compact", { reason: "manual", willRetry: false });

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("session was compacted");
  });

  test("clean turn + marked manual compaction, TUI -> notify only, no resume", async () => {
    const { pi, fire, sent, notified, addMarker } = makeHarness({ hasUI: true });
    resumeAfterCompact(pi as never);

    await fire("agent_end", cleanTurn);
    addMarker("m3");
    await fire("session_compact", { reason: "manual", willRetry: false });
    await fire("agent_settled");

    expect(sent.length).toBe(0);
    expect(notified.some((m) => m.includes("Continue"))).toBe(true);
  });

  test("clean turn + genuine user /compact (no marker) -> silent skip", async () => {
    const { pi, fire, sent, notified } = makeHarness({ hasUI: true });
    resumeAfterCompact(pi as never);

    await fire("agent_end", cleanTurn);
    await fire("session_compact", { reason: "manual", willRetry: false });
    await fire("agent_settled");

    expect(sent.length).toBe(0);
    expect(notified.length).toBe(0);
  });

  test("busy agent (pi-core mid-run compaction) arms; agent_settled re-checks idle", async () => {
    const { pi, fire, sent } = makeHarness({ idle: false });
    resumeAfterCompact(pi as never);

    await fire("agent_end", errorTurn);
    await fire("session_compact", { reason: "threshold", willRetry: false });
    expect(sent.length).toBe(0); // armed, not fired

    // agent_settled with the agent still busy: resume must not fire.
    await fire("agent_settled");
    expect(sent.length).toBe(0);
  });

  test("threshold reason (pi core path) with idle agent fires without a marker", async () => {
    const { pi, fire, sent } = makeHarness();
    resumeAfterCompact(pi as never);

    await fire("agent_end", errorTurn);
    await fire("session_compact", { reason: "threshold", willRetry: false });

    expect(sent.length).toBe(1);
  });

  test("sendResume holds the handler open until the resumed run settles (print-mode keep-alive)", async () => {
    const h = makeHarness({ holdRun: true });
    resumeAfterCompact(h.pi as never);

    await h.fire("agent_end", cleanTurn);
    h.addMarker("m-wait");
    const pending = h.fire("session_compact", { reason: "manual", willRetry: false });
    await tick();

    // Resume sent, fake run in flight, handler parked on waitForIdle.
    expect(h.sent.length).toBe(1);
    expect(h.runState.busy).toBe(true);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    h.finishRun();
    await pending;
    await tick();
    expect(settled).toBe(true);
  });

  test("agent_settled does not re-enter while a resume is still awaiting waitForIdle", async () => {
    const h = makeHarness({ holdRun: true });
    resumeAfterCompact(h.pi as never);

    // pi-core busy compaction: arms for agent_settled.
    h.setIdleOverride(false);
    await h.fire("agent_end", cleanTurn);
    await h.fire("session_compact", { reason: "threshold", willRetry: false });
    expect(h.sent.length).toBe(0);

    // Agent settles; handler sends the resume and parks on waitForIdle.
    h.setIdleOverride(undefined);
    const first = h.fire("agent_settled");
    await tick();
    expect(h.sent.length).toBe(1);
    expect(h.runState.busy).toBe(true);

    // While that handler is still parked: the resumed turn ends clean,
    // re-compacts mid-run (busy -> arms), and the next agent_settled must
    // NOT send a second resume.
    await h.fire("agent_end", cleanTurn);
    await h.fire("session_compact", { reason: "threshold", willRetry: false });
    await h.fire("agent_settled");
    expect(h.sent.length).toBe(1);

    h.finishRun();
    await first;
    expect(h.sent.length).toBe(1);
  });
});
