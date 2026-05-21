/**
 * custom-footer — git branch + token/cost stats in the footer.
 *
 * Toggle on with `/footer`. The footer shows:
 *
 *   ↑<input-tokens> ↓<output-tokens> $<cost>           <model> (<branch>)
 *
 * Tokens and cost are computed by walking the current branch's assistant
 * messages (via `ctx.sessionManager`). Branch comes from `footerData` — the
 * only place where git branch is exposed without shelling out per render.
 *
 * The footer auto-rerenders when the git branch changes (checkouts, new
 * worktrees) — `footerData.onBranchChange` returns the unsubscribe.
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

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function installFooter(ctx: ExtensionContext) {
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
        try {
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cost += m.usage.cost.total;
            }
          }
        } catch {
          // sessionManager may briefly be unavailable during transitions
          // (session_shutdown → session_start). Skip this frame; the next
          // render after re-install will succeed.
          return [""];
        }

        const branch = footerData.getGitBranch();
        const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

        const left = theme.fg(
          "dim",
          `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`,
        );
        const branchStr = branch ? ` (${branch})` : "";
        let modelId = "no-model";
        try {
          modelId = ctx.model?.id ?? "no-model";
        } catch {
          // same defensive pattern as sessionManager
        }
        const right = theme.fg("dim", `${modelId}${branchStr}`);

        const pad = " ".repeat(
          Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
        );
        return [truncateToWidth(left + pad + right, width)];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = false;

  pi.registerCommand("footer", {
    description: "Toggle custom footer with git branch + token stats",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (!enabled) {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("default footer restored", "info");
        return;
      }

      installFooter(ctx);
      ctx.ui.notify("custom footer enabled", "info");
    },
  });

  // Re-install the footer on every session lifecycle event so the captured
  // ctx is always the live one. session_start fires for reasons: "new" |
  // "resume" | "reload" | "fork" — exactly the cases that invalidate the
  // previous ctx.
  pi.on("session_start", async (_event, ctx) => {
    if (enabled) installFooter(ctx);
  });
}
