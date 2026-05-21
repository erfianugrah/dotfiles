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
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── extension ─────────────────────────────────────────────────────────────

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

      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(width: number): string[] {
            let input = 0;
            let output = 0;
            let cost = 0;
            for (const e of ctx.sessionManager.getBranch()) {
              if (e.type === "message" && e.message.role === "assistant") {
                const m = e.message as AssistantMessage;
                input += m.usage.input;
                output += m.usage.output;
                cost += m.usage.cost.total;
              }
            }

            const branch = footerData.getGitBranch();
            const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

            const left = theme.fg(
              "dim",
              `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`,
            );
            const branchStr = branch ? ` (${branch})` : "";
            const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

            const pad = " ".repeat(
              Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
            );
            return [truncateToWidth(left + pad + right, width)];
          },
        };
      });
      ctx.ui.notify("custom footer enabled", "info");
    },
  });
}
