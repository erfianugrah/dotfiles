// .pi/agent/tests/history-first.test.ts
import { describe, expect, test } from "bun:test";
import {
  decideContext,
  freshState,
  HISTORY_FIRST_MARKER,
  isLookupTool,
} from "../extensions/lib/history-first-core.ts";

const U = (text: string) => ({ role: "user", content: text });
const S = (text: string) => ({ role: "system", content: text });

const TASK = U("fix the parse error in crypto.zsh line 445 near )");

describe("isLookupTool", () => {
  test("known lookup tools disarm", () => {
    expect(isLookupTool("memledger_search")).toBe(true);
    expect(isLookupTool("session_search")).toBe(true);
    expect(isLookupTool("search_ledger")).toBe(true);
    expect(isLookupTool("ledger_sql")).toBe(true);
  });
  test("non-lookup tools do not", () => {
    expect(isLookupTool("grep")).toBe(false);
    expect(isLookupTool("bash")).toBe(false);
  });
});

describe("decideContext", () => {
  test("injects at end of context on a substantive task message", () => {
    const state = freshState(3);
    const msgs = [S("system prompt"), U("hello"), TASK];
    const out = decideContext(state, msgs);
    expect(out).toBeDefined();
    const last = out!.messages[out!.messages.length - 1];
    expect(last.role).toBe("system");
    expect((last.content as string).includes(HISTORY_FIRST_MARKER)).toBe(true);
    expect(state.fires).toBe(1);
  });

  test("does not inject before any user message", () => {
    const state = freshState(3);
    const out = decideContext(state, [S("system prompt")]);
    expect(out).toBeUndefined();
    expect(state.fires).toBe(0);
  });

  test("does not fire on trivial one-line control messages", () => {
    const state = freshState(3);
    expect(decideContext(state, [U("y")])).toBeUndefined();
    expect(decideContext(state, [U("continue")])).toBeUndefined();
    expect(state.fires).toBe(0);
  });

  test("re-fires (replaces old copy, no accumulation) while undisarmed", () => {
    const state = freshState(3);
    const first = decideContext(state, [TASK])!;
    expect(first.messages).toHaveLength(2);
    // Second turn: the messages array may or may not carry our previous
    // injected copy (depends on pi's persistence semantics).
    const without = decideContext(state, [TASK]);
    expect(without!.messages.filter((m) => (typeof m.content === "string" ? m.content.includes(HISTORY_FIRST_MARKER) : false))).toHaveLength(1);
    const withStale = decideContext(state, [...first.messages]);
    const marks = withStale!.messages.filter((m) =>
      typeof m.content === "string" ? m.content.includes(HISTORY_FIRST_MARKER) : false,
    );
    expect(marks).toHaveLength(1);
    expect(state.fires).toBe(3);
  });

  test("disarmed by searched: strips any stale copy, never injects", () => {
    const state = freshState(3);
    const injected = decideContext(state, [TASK])!;
    state.searched = true;
    const out = decideContext(state, injected.messages)!;
    expect(out.messages.some((m) => typeof m.content === "string" && m.content.includes(HISTORY_FIRST_MARKER))).toBe(false);
  });

  test("capped at maxFires", () => {
    const state = freshState(2);
    decideContext(state, [TASK]);
    decideContext(state, [TASK]);
    expect(state.fires).toBe(2);
    // Cap reached: no further injection, no strip needed on a clean array.
    expect(decideContext(state, [TASK])).toBeUndefined();
    // But a stale copy from before the cap is still stripped.
    const injected = decideContext(freshState(1), [TASK])!;
    const capped = freshState(1);
    capped.fires = 1;
    const stripped = decideContext(capped, injected.messages)!;
    expect(stripped.messages).toHaveLength(1);
  });

  test("array-block user content counts as substantive", () => {
    const state = freshState(3);
    const msgs = [
      { role: "user", content: [{ type: "text", text: "diagnose why image paste stopped working in pi, clipboard handler no-ops" }] },
    ];
    const out = decideContext(state, msgs);
    expect(out).toBeDefined();
    expect(state.fires).toBe(1);
  });
});
