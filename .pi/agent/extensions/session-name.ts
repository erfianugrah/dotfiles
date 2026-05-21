/**
 * session-name — give sessions readable names for `pi -r` and the selector.
 *
 * Without this, sessions are identified by their first user message, which
 * is noisy for migrated opencode sessions (often "continue", "yes", etc.)
 * and for any session whose first turn is a one-liner.
 *
 * Usage:
 *   /session-name                       show current name
 *   /session-name docs.erfi.io review   set name
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("session-name", {
    description: "Set or show session name (usage: /session-name [new name])",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name) {
        pi.setSessionName(name);
        ctx.ui.notify(`session named: ${name}`, "info");
      } else {
        const current = pi.getSessionName();
        ctx.ui.notify(current ? `session: ${current}` : "no session name set", "info");
      }
    },
  });
}
