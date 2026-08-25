/**
 * history-first - mechanical "search prior sessions FIRST" reminder.
 *
 * The failure this exists for (observed 2026-08-25, multiple same-day
 * recurrences): a fresh session charges into a fix/debug task without
 * checking history, burns tokens researching to a dead end, and only then
 * discovers memledger already held the answer - the same problem was
 * re-solved in 2-4 separate sessions each (pi thinking-render,
 * secret-output-guard age-key rule, claude binary migration, orphan test
 * cleanup). The existing prose rules fire on USER triggers ("how did we do
 * X last time?") and lookup-before-ask fires when the agent ASKS the user -
 * neither covers the agent that just starts solving.
 *
 * Mechanism: on the `context` event (same pattern as local-model-rules.ts),
 * append a system reminder at the END of the message list (max recency
 * salience) on every turn until ANY history-lookup tool is called, capped
 * at 3 fires per session (env PI_HISTORY_FIRST_MAX). Once a lookup fires,
 * the reminder is stripped and never returns. Applied in headless mode too
 * (pi -p / subagents) - re-solving there is the same waste, and a system
 * message does not corrupt the output payload the way appending to the
 * assistant text would.
 *
 * Decision logic is pure and unit-tested in lib/history-first-core.ts.
 *
 * Kill switch: PI_HISTORY_FIRST_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decideContext,
  freshState,
  HISTORY_FIRST_MARKER,
  isLookupTool,
  type HistoryFirstState,
} from "./lib/history-first-core.ts";

const OFF = process.env.PI_HISTORY_FIRST_OFF === "1";

function loadMaxFires(): number {
  const n = Number(process.env.PI_HISTORY_FIRST_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

type PiMessage = { role: string; content: unknown };

export default function (pi: ExtensionAPI) {
  if (OFF) return;

  const states = new Map<string, HistoryFirstState>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } })
        .sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };

  const stateFor = (ctx: unknown): HistoryFirstState => {
    const key = sessionKey(ctx);
    let s = states.get(key);
    if (!s) {
      s = freshState(loadMaxFires());
      states.set(key, s);
    }
    return s;
  };

  // Any lookup disarms for the rest of the session.
  pi.on("tool_call", async (event, ctx) => {
    const name = (event as { toolName?: string }).toolName;
    if (name && isLookupTool(name)) stateFor(ctx).searched = true;
    return undefined;
  });

  pi.on("context", async (event, ctx) => {
    const messages = (event as { messages?: PiMessage[] }).messages;
    if (!messages?.length) return undefined;

    // Stale-ctx guard (see local-model-rules.ts): ctx getters can outlive a
    // reloaded session and throw assertActive - skip, next turn gets a fresh ctx.
    let state: HistoryFirstState;
    try {
      state = stateFor(ctx);
    } catch {
      return undefined;
    }

    return decideContext(state, messages);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(sessionKey(ctx));
  });
}

// Marker re-export for tests / debugging.
export { HISTORY_FIRST_MARKER };
