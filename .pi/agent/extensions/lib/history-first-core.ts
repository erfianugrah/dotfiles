/**
 * history-first-core - pure decision logic for the history-first reminder.
 * ZERO harness imports (node stdlib only). Source of truth for the pi
 * adapter (../history-first.ts). Shared LOOKUP_TOOLS comes from
 * lookup-before-ask-core.ts, which is also harness-agnostic.
 *
 * Contract: on each `context` event the adapter calls `decideContext` with
 * the per-session state and the live message array. The function is
 * idempotent under BOTH context-persistence semantics:
 *   - if pi persists injected messages into the transcript, the marker
 *     filter strips our previous copy before (maybe) appending a new one,
 *     so copies never accumulate;
 *   - if pi does not persist them, the filter is a no-op and the append
 *     re-fires while conditions hold.
 *
 * Injection re-fires on every turn until ANY lookup tool is called
 * (state.searched) or the fire cap is hit, so a model that ignores the
 * first reminder gets it again at max recency (end of context) next turn.
 */

import { LOOKUP_TOOLS } from "./lookup-before-ask-core.ts";

export { LOOKUP_TOOLS };

export const HISTORY_FIRST_MARKER = "<!-- history-first -->";

/** Fires (turns) the reminder re-appears while undisarmed. Env-overridable. */
export const DEFAULT_MAX_FIRES = 3;

/**
 * A substantive user message (task-bearing), vs a one-line control reply
 * ("continue", "y", "go on", slash-command echo). Shared with the CC hook.
 */
export function isSubstantive(text: string): boolean {
  return text.trim().length >= 20;
}

export const HISTORY_FIRST_REMINDER = `${HISTORY_FIRST_MARKER}
history-first: this session has not queried prior-session history yet. BEFORE
researching, fixing, or building anything, run one search for prior work:
memledger_search (cross-session, all clients, only full copy past 30d) or
session_search (pi-only, recent) - 2-3 terms: component name, error text, or
the task's own words. The known failure (observed 2026-08-25): fresh sessions
skip this, burn tokens researching to a dead end, and only THEN find memledger
already held the answer - the same problem was re-solved in 2-4 sessions each
(pi thinking-render, secret-output-guard age-key rule, claude binary
migration). A 5s search beats re-deriving. If the lookup comes back genuinely
empty, say so and proceed.`;

export interface HistoryFirstState {
  /** True once any LOOKUP_TOOLS call happened this session. Disarms. */
  searched: boolean;
  /** Number of injections delivered so far. */
  fires: number;
  /** Config: max injections per session (adapter injects the env value). */
  maxFires: number;
}

export function freshState(maxFires: number): HistoryFirstState {
  return { searched: false, fires: 0, maxFires };
}

/** True when toolName is a history-lookup tool (disarms the reminder). */
export function isLookupTool(toolName: string): boolean {
  return LOOKUP_TOOLS.has(toolName);
}

type PiMessage = { role: string; content: unknown };

function isInjected(m: PiMessage): boolean {
  return (
    m.role === "system" &&
    typeof m.content === "string" &&
    m.content.includes(HISTORY_FIRST_MARKER)
  );
}

function textContent(m: PiMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as { type?: string; text?: string }[])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/**
 * Decide the context mutation for this turn. Returns undefined when nothing
 * should change (disarmed / capped / no user message yet / nothing to strip).
 * Mutates state.fires when it injects. Pure w.r.t. the message array.
 */
export function decideContext(
  state: HistoryFirstState,
  messages: PiMessage[],
): { messages: PiMessage[] } | undefined {
  const hasInjected = messages.some(isInjected);

  // Disarmed or capped: only act if a stale injected copy needs stripping.
  if (state.searched || state.fires >= state.maxFires) {
    if (!hasInjected) return undefined;
    return { messages: messages.filter((m) => !isInjected(m)) };
  }

  // No user turn yet (session_start before first message): nothing to anchor.
  if (!messages.some((m) => m.role === "user")) {
    if (!hasInjected) return undefined;
    return { messages: messages.filter((m) => !isInjected(m)) };
  }

  // Trivial-turn guard: one-line control messages ("continue", "y", "go on",
  // slash-command echoes) are not task starts - the reminder anchored there
  // is noise. Only fire once a substantive user message exists.
  const substantive = messages.some(
    (m) => m.role === "user" && isSubstantive(textContent(m)),
  );
  if (!substantive) {
    if (!hasInjected) return undefined;
    return { messages: messages.filter((m) => !isInjected(m)) };
  }

  state.fires++;
  return {
    messages: [
      ...messages.filter((m) => !isInjected(m)),
      { role: "system" as const, content: HISTORY_FIRST_REMINDER },
    ],
  };
}
