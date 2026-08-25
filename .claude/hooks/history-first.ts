#!/usr/bin/env bun
/**
 * history-first - Claude Code UserPromptSubmit hook.
 *
 * Same contract as the pi adapter (.pi/agent/extensions/history-first.ts):
 * before the agent starts a non-trivial task, it should query prior-session
 * history (memledger) - the observed failure (2026-08-25) is sessions that
 * skip the lookup, burn tokens researching to a dead end, and only then
 * find memledger held the answer.
 *
 * Mechanism: on each user prompt, if the prompt is substantive and the
 * transcript shows NO history-lookup tool call yet, emit additionalContext
 * with the reminder. Disarm and fire-cap are derived from the transcript
 * (hooks are stateless processes):
 *   - disarmed once a lookup tool_use appears anywhere in the transcript
 *     (mcp__erfi-toolkit__search_messages etc., or any mcp server exposing
 *     the same tool names);
 *   - capped at 3 reminders per session, counted by the number of user
 *     prompts already in the transcript (turns), matching pi's max-fires.
 *
 * Shares isSubstantive with the pi core; the reminder text is CC-shaped
 * (CC tool names differ from pi's native memledger_search).
 *
 * Kill switch: HISTORY_FIRST_OFF=1 or PI_HISTORY_FIRST_OFF=1 (both honored).
 */

import { isSubstantive } from "../../.pi/agent/extensions/lib/history-first-core.ts";

/** Lookup tool detection: bare names or mcp__<server>__<name> (any server). */
const LOOKUP_RE =
  /^(?:mcp__[A-Za-z0-9_-]+__)?(?:memledger_search|search_messages|semantic_search|search_ledger|search_memories|list_sessions)$/;

const MAX_FIRES = (() => {
  const n = Number(process.env.PI_HISTORY_FIRST_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
})();

const REMINDER = `history-first: this session has not queried prior-session history yet. BEFORE
researching, fixing, or building anything, run one search for prior work via the
erfi-toolkit MCP: search_messages (FTS, all clients) / semantic_search /
search_ledger - 2-3 terms: component name, error text, or the task's own words.
The known failure (observed 2026-08-25): fresh sessions skip this, burn tokens
researching to a dead end, and only THEN find memledger already held the answer -
the same problem was re-solved in 2-4 sessions each. A 5s search beats
re-deriving. If the lookup comes back genuinely empty, say so and proceed.`;

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** Extract tool names + user-prompt count from the transcript jsonl. */
function scanTranscript(
  text: string,
): { lookupCalled: boolean; userTurns: number } {
  let lookupCalled = false;
  let userTurns = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // mid-write partial line
    }
    const msg = entry.message;
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      userTurns++;
      continue;
    }
    if (!Array.isArray(content)) continue;
    let isRealUserTurn = false;
    for (const block of content as { type?: string; name?: string; text?: string }[]) {
      if (block?.type === "tool_use") {
        if (block.name && LOOKUP_RE.test(block.name)) lookupCalled = true;
      } else if (block?.type === "tool_result") {
        // tool_result blocks arrive in user-role messages but are not turns
      } else if (block?.type === "text" && typeof block.text === "string") {
        isRealUserTurn = true;
      }
    }
    if (isRealUserTurn) userTurns++;
  }
  return { lookupCalled, userTurns };
}

async function main() {
  if (
    process.env.HISTORY_FIRST_OFF === "1" ||
    process.env.PI_HISTORY_FIRST_OFF === "1"
  ) {
    process.exit(0);
  }

  const raw = await Bun.stdin.text();
  let payload: { prompt?: string; transcript_path?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!isSubstantive(prompt)) process.exit(0);

  let transcript = "";
  if (payload.transcript_path) {
    try {
      transcript = await Bun.file(payload.transcript_path).text();
    } catch {
      transcript = ""; // first prompt of a session: no file yet - that's fine
    }
  }

  const { lookupCalled, userTurns } = scanTranscript(transcript);
  // Cap semantics mirror pi's max-fires: this prompt is turn userTurns+1;
  // fire only on the first MAX_FIRES task turns.
  if (lookupCalled) process.exit(0);
  if (userTurns + 1 > MAX_FIRES) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: REMINDER,
      },
    }),
  );
  process.exit(0);
}

await main();
