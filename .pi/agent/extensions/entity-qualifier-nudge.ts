/**
 * entity-qualifier-nudge - a bare device identifier used as EVIDENCE must
 * name the host it belongs to.
 *
 * Thin pi adapter. All pure detection (device-id regex, evidential vocabulary,
 * host-qualifier heuristics, sentence-scoped decision) lives in the harness-
 * agnostic core at lib/entity-qualifier-core.ts, shared with the Claude Code
 * PreToolUse hook (../../.claude/hooks/entity-qualifier-nudge.ts). This file is
 * only the pi wiring: a message_end hook that appends one advisory line to the
 * assistant's own message, once per session, never blocking. Silent in
 * unattended runs (pi -p) where the assistant text is a machine-readable
 * payload.
 *
 * Kill switch: PI_ENTITY_NUDGE_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answerText, needsHostQualifier, NUDGE_LINE } from "./lib/entity-qualifier-core.ts";

// Re-exported for the pi test suite (tests/loop-entity-qualifier.test.ts and
// tests/integration/message-nudges.e2e.test.ts import these by name).
export { needsHostQualifier, NUDGE_LINE };

type TextBlock = { type?: string; text?: string };

interface State {
  nudged: boolean;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ENTITY_NUDGE_OFF === "1") return;

  const states = new Map<string, State>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } }).sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };

  const stateFor = (ctx: unknown): State => {
    const key = sessionKey(ctx);
    let s = states.get(key);
    if (!s) {
      s = { nudged: false };
      states.set(key, s);
    }
    return s;
  };

  pi.on("message_end", async (event, ctx) => {
    // pi -p: the assistant text is the return payload of a subagent or loop
    // iteration. Appending advice there corrupts it.
    if ((ctx as { hasUI?: boolean }).hasUI === false) return undefined;

    const msg = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || msg.role !== "assistant") return undefined;

    const s = stateFor(ctx);
    if (s.nudged) return undefined;

    const text = answerText(msg);
    if (!needsHostQualifier(text)) return undefined;

    const content = msg.content as TextBlock[];
    let lastText = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type === "text" && typeof content[i]?.text === "string") {
        lastText = i;
        break;
      }
    }
    if (lastText === -1) return undefined;

    s.nudged = true;
    return {
      message: {
        ...msg,
        content: content.map((b, i) =>
          i === lastText ? { ...b, text: `${b.text}\n\n${NUDGE_LINE}` } : b,
        ),
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(sessionKey(ctx));
  });
}
