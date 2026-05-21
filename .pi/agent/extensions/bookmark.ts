/**
 * bookmark — label entries for /tree navigation in long sessions.
 *
 * Bookmarks attach a label to the last assistant message so you can jump to
 * decision points, plan checkpoints, or "before I started the rewrite"
 * moments later via the tree view. Complements `session-search` (which finds
 * by text) — bookmarks find by intent.
 *
 * Usage:
 *   /bookmark                       auto-label as bookmark-<timestamp>
 *   /bookmark phase-1-plan          set explicit label
 *   /unbookmark                     remove the most-recent bookmark on the branch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("bookmark", {
    description: "Bookmark last assistant message (usage: /bookmark [label])",
    handler: async (args, ctx) => {
      const label = args.trim() || `bookmark-${Date.now()}`;
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          pi.setLabel(entry.id, label);
          ctx.ui.notify(`bookmarked as: ${label}`, "info");
          return;
        }
      }
      ctx.ui.notify("no assistant message to bookmark", "warning");
    },
  });

  pi.registerCommand("unbookmark", {
    description: "Remove the most-recent bookmark on the current branch",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const label = ctx.sessionManager.getLabel(entry.id);
        if (label) {
          pi.setLabel(entry.id, undefined);
          ctx.ui.notify(`removed bookmark: ${label}`, "info");
          return;
        }
      }
      ctx.ui.notify("no bookmarked entry found", "warning");
    },
  });
}
