/**
 * tool-output-prune — opencode-style surgical tool-output pruning.
 *
 * Port of opencode's `prune` mechanism (~/opencode/packages/opencode/src/session/
 * compaction.ts:299-340). Walks BACKWARDS through the message stream and replaces
 * old tool-result content with a short marker once cumulative tool-result bytes
 * exceed PROTECT_BYTES. Conversation flow + decisions stay intact; only stale
 * tool data goes.
 *
 * Why this matters: tool results (read/bash/grep outputs) are typically 80%+
 * of context bloat in long sessions, and they age out faster than decisions
 * do. Pi's only existing knob is full compaction (summarize older turns),
 * which destroys nuance. This extension reclaims tokens surgically — the LLM
 * still sees that "I called bash with X args at turn N" but no longer sees
 * the 30k-character output.
 *
 * Algorithm:
 *   1. Hook `context` event (fired before every LLM call with deep-copy
 *      messages — safe to mutate, returns to all subsequent handlers).
 *   2. Walk messages from newest → oldest.
 *   3. For each `toolResult` message, byte-count its text content.
 *      - If cumulative ≤ PROTECT_BYTES: keep verbatim, accumulate.
 *      - If cumulative >  PROTECT_BYTES: replace content with a short marker.
 *   4. Skip already-pruned messages (idempotent — important because `context`
 *      fires every turn on the same prefix).
 *   5. Skip protected tool names (PROTECTED_TOOLS) — for skill outputs etc.
 *
 * Sizing rationale (matches opencode defaults):
 *   PROTECT_TOKENS = 40_000  (tokens of recent tool output preserved)
 *   ≈ PROTECT_BYTES = 160_000 (4 chars per token, conservative)
 *   PRUNE_MIN_BYTES = 80_000  (don't prune unless we'd reclaim ≥20k tokens —
 *                              avoids churn when there's barely anything to gain)
 *
 * Configurable via env:
 *   PI_PRUNE_PROTECT_BYTES   default 160000
 *   PI_PRUNE_MIN_BYTES       default 80000
 *   PI_PRUNE_OFF             "1" disables (no-op)
 *   PI_PRUNE_VERBOSE         "1" notifies on each prune
 *
 * Test it: in a long session with lots of `read`/`bash` tool calls, watch
 * the `ctx` pill in the footer drop after the first turn this extension is
 * loaded. The savings compound over time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── tunables ──────────────────────────────────────────────────────────────

const PROTECT_BYTES = Math.max(
  100,
  Number(process.env.PI_PRUNE_PROTECT_BYTES ?? "160000"),
);

const PRUNE_MIN_BYTES = Math.max(
  1,
  Number(process.env.PI_PRUNE_MIN_BYTES ?? "80000"),
);

const DISABLED = process.env.PI_PRUNE_OFF === "1";
const VERBOSE = process.env.PI_PRUNE_VERBOSE === "1";

// Tools whose results should NEVER be pruned. Skill-style tools that load
// methodology/conventions need their full content available across the whole
// session. Match opencode's PRUNE_PROTECTED_TOOLS list.
const PROTECTED_TOOLS = new Set<string>([
  "skill",
  "memory",
  "todowrite",
  "question",
  "session-search",
  "bookmark",
]);

// Marker prefix used to identify already-pruned content. Idempotent: if we
// see this prefix on a tool result we skip pruning it (its bytes don't even
// count toward the protect budget — pruned messages are effectively free).
const PRUNED_MARKER = "[tool-output-prune] ";

// ── helpers ───────────────────────────────────────────────────────────────

type AnyMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

type TextPart = { type: "text"; text: string };

function isTextPart(p: unknown): p is TextPart {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { type?: unknown }).type === "text" &&
    typeof (p as { text?: unknown }).text === "string"
  );
}

function bytesOfContent(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf-8");
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (isTextPart(part)) total += Buffer.byteLength(part.text, "utf-8");
    // Image parts: count just the base64 string size, but we don't currently
    // prune images (rare and small for tool results).
    else if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "image"
    ) {
      const data = (part as { data?: unknown }).data;
      if (typeof data === "string") total += data.length;
    }
  }
  return total;
}

function alreadyPruned(msg: AnyMessage): boolean {
  const c = msg.content;
  if (!Array.isArray(c) || c.length === 0) return false;
  const first = c[0];
  return isTextPart(first) && first.text.startsWith(PRUNED_MARKER);
}

function buildMarker(msg: AnyMessage, originalBytes: number): TextPart {
  const tool = msg.toolName ?? "<unknown>";
  const callId = msg.toolCallId ?? "<no-id>";
  const errFlag = msg.isError ? " (errored)" : "";
  const human =
    originalBytes >= 1024
      ? `${Math.round(originalBytes / 1024)}KB`
      : `${originalBytes}B`;
  return {
    type: "text",
    text:
      `${PRUNED_MARKER}${tool}${errFlag} — ${human} of output pruned to save context. ` +
      `If you need this output, re-run the equivalent tool call. (toolCallId=${callId})`,
  };
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.on("context", async (event, ctx) => {
    const messages = (event as { messages?: AnyMessage[] }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    let cumulative = 0;
    let prunedCount = 0;
    let reclaimedBytes = 0;

    // Walk newest → oldest. The first PROTECT_BYTES of tool-result content
    // we encounter are kept verbatim; everything older gets the marker.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "toolResult") continue;
      if (m.toolName && PROTECTED_TOOLS.has(m.toolName)) continue;
      if (alreadyPruned(m)) continue;

      const size = bytesOfContent(m.content);
      if (size === 0) continue;

      if (cumulative + size <= PROTECT_BYTES) {
        cumulative += size;
        continue;
      }

      // Beyond the protect window — replace.
      reclaimedBytes += size;
      prunedCount += 1;
      m.content = [buildMarker(m, size)];
    }

    // Don't bother emitting an update if reclaim is below the floor.
    // Note: even though we already mutated `messages` in place, returning
    // undefined still propagates our changes (pi's docs say messages are a
    // "deep copy, safe to modify"). To be safe and explicit, we always
    // return when we did anything.
    if (reclaimedBytes < PRUNE_MIN_BYTES) {
      // Roll back our mutations? No — they're already applied to the deep
      // copy and don't affect the on-disk session. The pruning is harmless
      // at small scales; just don't notify.
      return;
    }

    if (VERBOSE && ctx.hasUI) {
      const human =
        reclaimedBytes >= 1024 * 1024
          ? `${(reclaimedBytes / 1024 / 1024).toFixed(1)}MB`
          : `${Math.round(reclaimedBytes / 1024)}KB`;
      ctx.ui.notify(
        `pruned ${prunedCount} old tool outputs (~${human} reclaimed)`,
        "info",
      );
    }

    return { messages };
  });
}
