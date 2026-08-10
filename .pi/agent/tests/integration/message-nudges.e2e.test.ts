/**
 * message_end nudge extensions END-TO-END: loads each module's DEFAULT EXPORT
 * and drives the real hook through a fake pi runtime.
 *
 * Why this file exists. On 2026-08-10 a self-correcting-loop run turned every
 * sensor green, and moments later the live session threw
 * `absorb is not defined` out of epistemic-guard's message_end hook. That
 * particular error came from pi re-importing the module while the loop was
 * still writing it, so the committed file was fine - but nothing in the suite
 * would have caught the real version of that bug. The unit tests only exercise
 * pure helpers; the default export, the hook wiring and the module's top-level
 * evaluation were never executed under test. A guard whose helpers all pass
 * while its extension throws on every assistant message is worse than no
 * guard, because the failure is invisible until it fires in a live turn.
 *
 * Scope: wiring and runtime integrity, not classification (that is unit-tested
 * exhaustively next door). Each test asserts the module loads, registers, runs
 * without throwing, and honours once-per-session and headless suppression.
 *
 * Run: ./.pi/agent/tests/run.sh   (separate bun process from the unit suite)
 */
import { describe, expect, test } from "bun:test";

import epistemicGuard from "../../extensions/epistemic-guard.ts";
import lookupBeforeAsk from "../../extensions/lookup-before-ask.ts";
import entityQualifier from "../../extensions/entity-qualifier-nudge.ts";

type HookFn = (e: unknown, c: unknown) => Promise<unknown> | unknown;

interface Harness {
  hooks: Record<string, HookFn[]>;
  ctx: unknown;
}

function mount(ext: (pi: never) => void, opts: { hasUI?: boolean; file?: string } = {}): Harness {
  const hooks: Record<string, HookFn[]> = {};
  const pi = {
    on: (evt: string, fn: HookFn) => {
      (hooks[evt] ||= []).push(fn);
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as never;
  ext(pi);
  const ctx = {
    hasUI: opts.hasUI !== false,
    sessionManager: {
      getSessionFile: () => opts.file ?? "/tmp/e2e-nudges.jsonl",
      getEntries: () => [],
      getSystemPrompt: () => "",
    },
    ui: { notify: () => {} },
  };
  return { hooks, ctx };
}

/** Drive message_end with an assistant message; return the text after hooks. */
async function say(h: Harness, text: string): Promise<string> {
  const message = { role: "assistant", content: [{ type: "text", text }] };
  let current = message;
  for (const fn of h.hooks["message_end"] ?? []) {
    const out = (await fn({ message: current }, h.ctx)) as
      | { message?: typeof message }
      | undefined;
    if (out?.message) current = out.message;
  }
  return current.content.map((b) => b.text).join("\n");
}

describe("message_end nudges / runtime integrity", () => {
  test("every module loads, registers a message_end hook, and runs without throwing", async () => {
    for (const ext of [epistemicGuard, lookupBeforeAsk, entityQualifier]) {
      const h = mount(ext as never);
      expect((h.hooks["message_end"] ?? []).length).toBeGreaterThan(0);
      await say(h, "A perfectly ordinary sentence with nothing to flag.");
    }
  });

  test("epistemic-guard annotates a recalled specific end-to-end", async () => {
    const h = mount(epistemicGuard as never);
    const out = await say(h, "We shipped Caddy 2.11.4 last cycle.");
    expect(out).toContain("epistemic-guard");
    expect(out).toContain("2.11.4");
  });

  test("epistemic-guard marks a derived number and a fabricated date", async () => {
    const h = mount(epistemicGuard as never);
    const out = await say(
      h,
      "It shares one trunk so it caps at 5 Gbps, and we tested it 2026-08-10.",
    );
    expect(out).toContain("derived");
    expect(out).toContain("2026-08-10");
  });

  test("lookup-before-ask fires once per session, then stays quiet", async () => {
    const h = mount(lookupBeforeAsk as never);
    const first = await say(h, "How long is that run, and what model is the switch?");
    expect(first).toContain("lookup-before-ask");
    const second = await say(h, "And what speed does the link report on your box?");
    expect(second).not.toContain("lookup-before-ask");
  });

  test("a lookup tool call disarms lookup-before-ask", async () => {
    const h = mount(lookupBeforeAsk as never);
    for (const fn of h.hooks["tool_call"] ?? []) {
      await fn({ toolName: "memledger_search", input: {} }, h.ctx);
    }
    const out = await say(h, "How long is that run, and what model is the switch?");
    expect(out).not.toContain("lookup-before-ask");
  });

  test("entity-qualifier nudges an unqualified device citation", async () => {
    const h = mount(entityQualifier as never);
    const out = await say(h, "you had eth0 flap and downshift events on 2026-08-08");
    expect(out).toContain("entity-qualifier-nudge");
  });

  test("naming the host keeps entity-qualifier quiet", async () => {
    const h = mount(entityQualifier as never);
    const out = await say(h, "servarr's eth0 flapped last week");
    expect(out).not.toContain("entity-qualifier-nudge");
  });

  test("headless runs are never annotated - the text is a machine payload", async () => {
    for (const ext of [epistemicGuard, lookupBeforeAsk, entityQualifier]) {
      const h = mount(ext as never, { hasUI: false });
      const out = await say(
        h,
        "you had eth0 flap on 2026-08-08 and Caddy 2.11.4 caps at 5 Gbps; how long is that run?",
      );
      expect(out).not.toContain("nudge:");
      expect(out).not.toContain("epistemic-guard:");
    }
  });

  test("session_shutdown clears state without throwing", async () => {
    for (const ext of [epistemicGuard, lookupBeforeAsk, entityQualifier]) {
      const h = mount(ext as never);
      for (const fn of h.hooks["session_shutdown"] ?? []) {
        await fn({}, h.ctx);
      }
    }
  });
});
