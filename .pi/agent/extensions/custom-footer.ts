/**
 * custom-footer — token/cost stats + session/model/branch context.
 *
 * On by default. Toggle off with `/footer` to restore pi's default footer.
 *
 * Layout (width-aware, drops fields gracefully on narrow terminals):
 *
 *   ↑<in> ↓<out> $<session> (+$<turn>) <ctx%>     <session-name> · <thinking> · <cwd>/<branch> · <model>
 *
 * Fields:
 *   ↑in        cumulative input tokens this session
 *   ↓out       cumulative output tokens this session
 *   $session   cumulative \$ cost (sum of message.usage.cost.total)
 *   +$turn     last-turn delta (omitted if <\$0.0005)
 *   ctx%       % of model context window in use, dim<60%, yellow 60-79, red >=80
 *   session    pi.getSessionName() — set automatically by session-auto-title
 *   thinking   pi.getThinkingLevel() — omitted when 'off'
 *   cwd        path.basename(ctx.cwd)
 *   branch     footerData.getGitBranch()
 *   model      ctx.model.id
 *
 * Plus extension statuses (from ctx.ui.setStatus()) are appended as a
 * dim middle segment when set — lets other extensions surface progress
 * (e.g. session-fts-index's '+15f 1.2k m' indexing notice).
 *
 * ── stale-ctx bug fix ──
 * Pi's official example for this pattern (and the previous version of this
 * file) captures `ctx` inside the setFooter render closure. After `/reload`,
 * `ctx.newSession()`, or `ctx.fork()`, the captured ctx is invalidated and
 * any subsequent render frame throws "extension ctx is stale" inside Pi's
 * runtime — which gets surfaced as garbled subagent stderr in /task and
 * crashes any feature that polls the footer.
 *
 * The fix below installs the footer through a helper that takes a fresh
 * ctx as input. We install on the `/footer` toggle (initial activation)
 * AND re-install on every `session_start` event while enabled — so the
 * closure always captures the live ctx for the current session.
 */

import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Pi exposes this on the module API — declare here so we can reference it
// without an import cycle. The actual function comes from `pi` passed to
// the extension factory; we close over it via installFooter's arg.
type PiAPI = ExtensionAPI & {
  getSessionName?: () => string | undefined;
  getThinkingLevel?: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

function installFooter(pi: PiAPI, ctx: ExtensionContext) {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        // ctx here is the freshly-passed reference — never the stale parent
        let input = 0;
        let output = 0;
        let cost = 0;
        let lastTurnCost = 0;
        try {
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cost += m.usage.cost.total;
              lastTurnCost = m.usage.cost.total; // overwritten until last
            }
          }
        } catch {
          // sessionManager may briefly be unavailable during transitions
          // (session_shutdown → session_start). Skip this frame; the next
          // render after re-install will succeed.
          return [""];
        }

        const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
        const turnSuffix = lastTurnCost > 0.0005 ? ` (+$${lastTurnCost.toFixed(3)})` : "";

        // ── left: cost block + context % ──────────────────────────────────────
        let ctxPct = "";
        try {
          const usage = ctx.getContextUsage();
          if (usage && usage.maxTokens) {
            const pct = Math.round((usage.tokens / usage.maxTokens) * 100);
            const color = pct >= 80 ? "red" : pct >= 60 ? "yellow" : "dim";
            ctxPct = " " + theme.fg(color, `${pct}%`);
          }
        } catch { /* mid-transition is fine */ }

        const leftPlain = `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}${turnSuffix}`;
        const left = theme.fg("dim", leftPlain) + ctxPct;

        // ── right: session · thinking · cwd/branch · model ──────────────────────
        const bits: string[] = [];

        // Session name (from session-auto-title or /session-name)
        try {
          const sn = pi.getSessionName?.();
          if (sn) bits.push(sn);
        } catch { /* ignore */ }

        // Thinking level when not off
        try {
          const tl = pi.getThinkingLevel?.();
          if (tl && tl !== "off") bits.push(`⚛${tl}`);
        } catch { /* ignore */ }

        // cwd basename / git branch  (cwd: only on width >= 100 to leave room)
        const branch = footerData.getGitBranch();
        let cwdBranch = "";
        try {
          const cwdName = path.basename(ctx.cwd);
          if (cwdName && branch) cwdBranch = width >= 100 ? `${cwdName}/${branch}` : branch;
          else if (branch) cwdBranch = branch;
          else if (cwdName) cwdBranch = cwdName;
        } catch { /* ignore */ }
        if (cwdBranch) bits.push(cwdBranch);

        // Model id (the user-recognisable suffix only)
        let modelId = "no-model";
        try { modelId = ctx.model?.id ?? "no-model"; } catch { /* ignore */ }
        bits.push(modelId);

        const right = theme.fg("dim", bits.join(" · "));

        // ── middle: extension status texts (e.g. session-fts indexing) ───────────
        let middle = "";
        try {
          const statuses = footerData.getExtensionStatuses();
          const texts: string[] = [];
          for (const [_id, t] of statuses) if (t) texts.push(t);
          if (texts.length) middle = "  " + theme.fg("yellow", texts.join(" · ")) + "  ";
        } catch { /* ignore */ }

        const padTotal = Math.max(
          1,
          width - visibleWidth(left) - visibleWidth(middle) - visibleWidth(right),
        );
        const pad = " ".repeat(padTotal);
        return [truncateToWidth(left + middle + pad + right, width)];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  // Default ON. Toggle off with `/footer`.
  let enabled = true;

  pi.registerCommand("footer", {
    description: "Toggle custom footer with git branch + token + cost stats",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (!enabled) {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("default footer restored", "info");
        return;
      }

      installFooter(pi, ctx);
      ctx.ui.notify("custom footer enabled", "info");
    },
  });

  // Re-install the footer on every session lifecycle event so the captured
  // ctx is always the live one. session_start fires for reasons: "new" |
  // "resume" | "reload" | "fork" — exactly the cases that invalidate the
  // previous ctx. Since `enabled` defaults to true, this installs the
  // footer automatically on every session.
  pi.on("session_start", async (_event, ctx) => {
    if (enabled) installFooter(pi, ctx);
  });
}
