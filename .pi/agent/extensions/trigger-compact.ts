/**
 * trigger-compact — auto-compact at context threshold + manual command.
 *
 * Watches `turn_end` and triggers compaction the first time tokens cross the
 * threshold. Threshold is a fraction of the active model's contextWindow —
 * scales with whatever you're using (200k Sonnet, 1M Opus 4.7, 32k local).
 * Configurable via `PI_COMPACT_FRACTION` env (default 0.85).
 *
 * Manual: `/trigger-compact [custom instructions]` to compact on demand.
 * Custom instructions are passed through to the summariser.
 *
 * Edge cases handled:
 *   - Threshold is checked as a CROSSING (prev <= T, current > T), not a
 *     level - avoids re-compacting after a successful compaction drops you
 *     back below the line and a subsequent turn pushes you over again
 *     naturally.
 *   - Small context windows are SKIPPED. pi's own compaction refuses to run
 *     when everything on the branch fits inside `compaction.keepRecentTokens`
 *     (default 20000): prepareCompaction() returns undefined and compact()
 *     throws "Nothing to compact (session too small)". Firing at 0.85 of a
 *     window smaller than ~keepRecent/0.85 is therefore guaranteed to fail -
 *     e.g. the llm-compose `erfi` preset runs context_size 8192, so the
 *     threshold lands at 6963 tokens while keepRecent wants 20000, and every
 *     trigger produced a failed-compaction error (observed 2026-08-26:
 *     "compaction started" immediately followed by three stacked
 *     "Nothing to compact (session too small)" errors). We now require the
 *     threshold to leave a real summarisable margin above keepRecentTokens.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRACTION = Math.max(0.1, Math.min(0.95, Number(process.env.PI_COMPACT_FRACTION ?? "0.85")));

/**
 * pi's compaction default for `compaction.keepRecentTokens` (settings.json can
 * override). Anything inside this tail is never summarised.
 */
const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/**
 * Minimum tokens that must sit ABOVE keepRecentTokens at the trigger point for
 * compaction to have anything to chew on. Small but non-zero: a few hundred
 * tokens of summarisable history is legitimate, zero is not.
 */
const MIN_SUMMARISABLE_TOKENS = 1000;

function keepRecentTokens(): number {
  const raw = Number(process.env.PI_COMPACT_KEEP_RECENT ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KEEP_RECENT_TOKENS;
}

/**
 * True when a compaction triggered at `threshold` could actually summarise
 * something. Exported for the unit suite.
 */
export function canCompact(threshold: number, keepRecent = keepRecentTokens()): boolean {
  return threshold - keepRecent >= MIN_SUMMARISABLE_TOKENS;
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let previousTokens: number | null | undefined;
  // Notify at most once per session - the condition repeats every turn.
  let warnedSmallWindow = false;

  const trigger = (ctx: ExtensionContext, customInstructions?: string) => {
    // The compact() callbacks fire AFTER the session has been replaced, so
    // the ctx captured here is stale by then - touching it (even ctx.hasUI)
    // throws. Uncaught, that kills headless `pi -p` agents (observed: every
    // self-correcting-loop iteration died at the 85% threshold, 2026-08-12).
    // Guard every post-compaction ctx touch.
    const notify = (msg: string, level: "info" | "error") => {
      try {
        if (ctx.hasUI) ctx.ui.notify(msg, level);
      } catch {
        // session replaced - nowhere to notify
      }
    };
    notify("compaction started", "info");
    ctx.compact({
      customInstructions,
      onComplete: () => notify("compaction completed", "info"),
      onError: (err) => notify(`compaction failed: ${err.message}`, "error"),
    });
  };

  pi.on("turn_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const current = usage?.tokens ?? null;
    const contextWindow = usage?.contextWindow ?? 0;
    if (current === null || contextWindow <= 0) return;

    const threshold = Math.floor(contextWindow * FRACTION);
    const crossed =
      previousTokens !== undefined &&
      previousTokens !== null &&
      previousTokens <= threshold &&
      current > threshold;

    previousTokens = current;
    if (!crossed) return;

    // Don't trigger a compaction pi will refuse: on a small context window the
    // whole branch fits inside keepRecentTokens, so there is nothing to
    // summarise and compact() throws instead of helping.
    if (!canCompact(threshold)) {
      if (!warnedSmallWindow) {
        warnedSmallWindow = true;
        try {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `auto-compact skipped: context window ${contextWindow} is too small ` +
                `(threshold ${threshold} <= keepRecentTokens ${keepRecentTokens()}). ` +
                `Lower compaction.keepRecentTokens or use a larger-context model.`,
              "warning",
            );
          }
        } catch {
          // no UI (headless) - the skip itself is the fix
        }
      }
      return;
    }

    // Mark right before triggering so resume-after-compact can tell this
    // automatic compaction apart from a user /compact - ctx.compact() hardcodes
    // reason "manual" on the session_compact event, which would otherwise
    // make the auto-resume skip every auto-compaction (incident 2026-08-31).
    // The marker is a session entry, not shared module state: pi's loader
    // gives every extension its own copy of lib/ modules, so a singleton
    // would never be seen by the other extension (probed 2026-08-31).
    // Custom entries do not participate in LLM context.
    try {
      pi.appendEntry("trigger-compact:auto", { at: Date.now(), tokens: current, threshold });
    } catch {
      // appendEntry must never block the compaction itself
    }
    trigger(ctx);
  });

  pi.registerCommand("trigger-compact", {
    description: "Compact the conversation now (optional: custom instructions)",
    handler: async (args, ctx) => {
      // Same gate as the automatic path, with an explicit answer: a manual
      // invocation deserves to be told WHY rather than throwing pi's opaque
      // "Nothing to compact (session too small)".
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? 0;
      if (contextWindow > 0) {
        const threshold = Math.floor(contextWindow * FRACTION);
        if (!canCompact(threshold)) {
          try {
            if (ctx.hasUI) {
              ctx.ui.notify(
                `nothing to compact: context window ${contextWindow} is smaller than ` +
                  `compaction.keepRecentTokens (${keepRecentTokens()}), so the whole ` +
                  `session is inside the kept tail. Lower keepRecentTokens in ` +
                  `settings.json or switch to a larger-context model.`,
                "warning",
              );
            }
          } catch {
            // no UI - nothing to report to
          }
          return;
        }
      }
      const instructions = args.trim() || undefined;
      trigger(ctx, instructions);
    },
  });
}
