#!/usr/bin/env bun
/**
 * semantic-inject - Claude Code UserPromptSubmit hook.
 *
 * Same contract as the pi adapter path (.pi/agent/extensions/session-ledger
 * + lib/semantic-inject-core.ts): on the FIRST substantive user prompt of a
 * session, query memledger's pgvector endpoint and push semantically similar
 * past-session snippets as additionalContext. Closes the same gap (ruflo
 * eval 2026-08-31): CC had only the history-first nag (pull); this is the
 * push path keyed on the actual task.
 *
 * Hooks are stateless processes, so the one-shot + fire-cap state is derived
 * from the transcript:
 *   - done once a prior additionalContext block carrying the marker exists in
 *     the transcript, OR the transcript already has a substantive user turn
 *     (the hook fires BEFORE the current prompt lands in the transcript, so
 *     any substantive turn already on disk means this is not the first);
 *   - skip on non-substantive prompts (shared isSubstantive).
 *
 * Degrades silently: any fetch error / timeout / below-threshold hits =
 * exit 0 with no output. history-first still nags as the pull fallback.
 *
 * Kill switches: SEMANTIC_INJECT_OFF=1 or PI_SEMANTIC_INJECT_OFF=1.
 */

import {
  buildSemanticBlock,
  decideInject,
  freshSemanticState,
  SEMANTIC_INJECT_MARKER,
} from "../../.pi/agent/extensions/lib/semantic-inject-core.ts";
import { isSubstantive } from "../../.pi/agent/extensions/lib/history-first-core.ts";

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join(" ");
}

/** True when a prior turn already carries our injection or a real user task. */
function transcriptHasFiredOrTasked(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // mid-write partial line
    }
    const msg = entry.message;
    if (!msg) continue;
    const t = blockText(msg.content);
    if (t.includes(SEMANTIC_INJECT_MARKER)) return true;
    // An earlier substantive user turn means the one-shot window is past.
    if (msg.role === "user" && isSubstantive(t)) return true;
  }
  return false;
}

async function main() {
  if (
    process.env.SEMANTIC_INJECT_OFF === "1" ||
    process.env.PI_SEMANTIC_INJECT_OFF === "1"
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

  if (payload.transcript_path) {
    try {
      const transcript = await Bun.file(payload.transcript_path).text();
      if (transcriptHasFiredOrTasked(transcript)) process.exit(0);
    } catch {
      // no transcript yet - first prompt of the session, proceed
    }
  }

  const state = freshSemanticState();
  const block = await decideInject(state, [prompt], { timeoutMs: 2500 });
  if (!block) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
    }),
  );
}

await main();
