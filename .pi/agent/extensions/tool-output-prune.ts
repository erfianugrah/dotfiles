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
 *      - The NEWEST non-pruned result is ALWAYS kept verbatim, even if
 *        its size alone exceeds PROTECT_BYTES. Bytes don't count toward
 *        cumulative — see rationale on `prune()` below.
 *      - For older results: if cumulative + size ≤ PROTECT_BYTES, keep
 *        verbatim and accumulate. Otherwise replace with marker.
 *   4. Skip already-pruned messages (idempotent — important because `context`
 *      fires every turn on the same prefix).
 *   5. Skip protected tool names (PROTECTED_TOOLS) — for skill outputs etc.
 *   6. Skip image-bearing tool results entirely. A single image read is
 *      ~290KB base64 — easily blows the 160KB protect window the FIRST
 *      time a non-newest tool call follows it. Pruning the bytes forces
 *      the agent to re-read (which gets pruned again) — the original
 *      `magick`-resize dance the user complained about. Rule 6 exempts
 *      image content the same way PROTECTED_TOOLS exempts skill/memory.
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

export type AnyMessage = {
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
    // Image parts: count just the base64 string size. Used for stats only
    // — image-bearing toolResults are skipped before this is called
    // (`hasImageContent`).
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

/**
 * Does this toolResult content contain any image part?
 *
 * Image-bearing tool results are exempt from pruning. The model genuinely
 * needs to revisit pasted screenshots / `read foo.png` results across
 * multiple turns; collapsing them to a marker forces a re-read which
 * itself gets pruned the next turn, producing the manual `magick -resize`
 * loop the user originally complained about.
 */
export function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const p of content) {
    if (
      typeof p === "object" &&
      p !== null &&
      (p as { type?: unknown }).type === "image"
    ) return true;
  }
  return false;
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

// ── core prune algorithm (pure, testable) ─────────────────────────────────

export interface PruneStats {
  prunedCount: number;
  reclaimedBytes: number;
  /** True if at least one tool result existed and was protected as newest. */
  keptNewest: boolean;
}

export interface PruneOptions {
  protectBytes?: number;
  protectedTools?: Set<string>;
}

/**
 * Mutate `messages` in place: replace older tool-result content with a
 * short marker once the cumulative byte budget is exceeded. Returns stats.
 *
 * Rules (iterating newest → oldest):
 *   1. Skip non-toolResult, protected-tool, already-pruned, empty messages.
 *   2. The FIRST non-skipped tool result is ALWAYS kept verbatim, even if
 *      bigger than the protect window. The model just requested it.
 *      Its bytes are NOT charged to `cumulative` — the window protects
 *      OLDER results from the newest's bulk, not from itself.
 *   3. Subsequent results that fit (cumulative + size ≤ protect): kept.
 *   4. Otherwise: content replaced with a marker text part.
 *
 * Why rule 2 existed (historic): a single image `read` returns ~200KB+
 * (a 148KB PNG gets wrapped as a base64 envelope). Without protection the
 * read got pruned on the SAME turn it was issued, because cumulative(0) +
 * size(200KB) already exceeded the 160KB protect window. The agent then
 * couldn't see what it just asked for, fell back to compressing +
 * re-reading, and the new read got pruned the same way — the manual
 * `magick` dance the user originally complained about. But rule 2 only
 * protects the SINGLE newest toolResult; the next tool call (any text
 * read / bash) demotes the image off "newest" and it gets pruned on the
 * very next `context` tick.
 *
 * The real fix (2026-05-29) is rule 6 below: image-bearing toolResults
 * are exempt from the algorithm entirely, like PROTECTED_TOOLS. Rule 2
 * stays for the symmetric text case (an enormous one-shot `bash find /`
 * output the agent just requested) but is no longer the load-bearing
 * defense against image pruning.
 */
export function prune(
  messages: AnyMessage[],
  opts: PruneOptions = {},
): PruneStats {
  const protectBytes = opts.protectBytes ?? PROTECT_BYTES;
  const protectedTools = opts.protectedTools ?? PROTECTED_TOOLS;

  let cumulative = 0;
  let prunedCount = 0;
  let reclaimedBytes = 0;
  let keptNewest = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "toolResult") continue;
    if (m.toolName && protectedTools.has(m.toolName)) continue;
    // Rule 6: image-bearing toolResults are exempt. See doc on hasImageContent.
    if (hasImageContent(m.content)) continue;
    if (alreadyPruned(m)) continue;

    const size = bytesOfContent(m.content);
    if (size === 0) continue;

    // Rule 2: newest non-pruned result is always protected. Bytes not counted.
    if (!keptNewest) {
      keptNewest = true;
      continue;
    }

    if (cumulative + size <= protectBytes) {
      cumulative += size;
      continue;
    }

    reclaimedBytes += size;
    prunedCount += 1;
    m.content = [buildMarker(m, size)];
  }

  return { prunedCount, reclaimedBytes, keptNewest };
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.on("context", async (event, ctx) => {
    const messages = (event as { messages?: AnyMessage[] }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const { prunedCount, reclaimedBytes } = prune(messages);

    // Reclaim floor: stay silent on small reclaims to avoid notification
    // churn. Mutations are already applied to the deep-copy messages
    // array; nothing to roll back.
    if (reclaimedBytes < PRUNE_MIN_BYTES) return;

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
