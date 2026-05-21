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
 *   - Threshold is checked as a CROSSING (prev ≤ T, current > T), not a
 *     level — avoids re-compacting after a successful compaction drops you
 *     back below the line and a subsequent turn pushes you over again
 *     naturally.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRACTION = Math.max(0.1, Math.min(0.95, Number(process.env.PI_COMPACT_FRACTION ?? "0.85")));

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let previousTokens: number | null | undefined;

  const trigger = (ctx: ExtensionContext, customInstructions?: string) => {
    if (ctx.hasUI) ctx.ui.notify("compaction started", "info");
    ctx.compact({
      customInstructions,
      onComplete: () => {
        if (ctx.hasUI) ctx.ui.notify("compaction completed", "info");
      },
      onError: (err) => {
        if (ctx.hasUI) ctx.ui.notify(`compaction failed: ${err.message}`, "error");
      },
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
    if (crossed) trigger(ctx);
  });

  pi.registerCommand("trigger-compact", {
    description: "Compact the conversation now (optional: custom instructions)",
    handler: async (args, ctx) => {
      const instructions = args.trim() || undefined;
      trigger(ctx, instructions);
    },
  });
}
