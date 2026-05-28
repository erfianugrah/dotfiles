/**
 * session-undo — opencode-style /undo slash command.
 *
 * Pi has no built-in session-revert (only /fork and /clone, which create
 * new sessions and don't restore the prompt to the editor). Opencode's
 * /undo aborts the in-flight stream, server-side reverts the session to
 * before the most recent user message, and re-populates the input editor
 * with that user's text.
 *
 * Pi exposes the exact primitive: `ctx.fork(entryId, { position: "before" })`
 * "forks before the selected user message, restoring that prompt into the
 * editor". The only behavioural difference vs opencode is that pi creates
 * a new session file (the original is preserved on disk) rather than
 * mutating in place — arguably safer since the original chain is always
 * recoverable from `~/.pi/agent/sessions/`.
 *
 * Workflow:
 *   1. If a stream is active, ctx.abort() it.
 *   2. Walk the active branch backward to find the most recent user
 *      message entry.
 *   3. ctx.fork(entryId, { position: "before" }) — pi switches into the
 *      new session and restores the user's prompt to the input editor.
 *
 * Edge cases:
 *   - No user message on this branch yet → notify, no-op. (Common after
 *     /fork or /clone with position: "before" when nothing's been typed.)
 *   - Another extension cancelled the fork via session_before_fork →
 *     notify with the cancellation reason.
 *   - Pending queued messages: pi processes them in the *new* forked
 *     session after the switch. We don't drain them — the user can /undo
 *     again if they want to revert those too. Documented but not gated.
 *
 * The earlier /undo prompt template (forensic git-state rollback) was
 * renamed to /rollback in the same commit that introduced this extension.
 *
 * Disable via PI_NO_SESSION_UNDO=1.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.PI_NO_SESSION_UNDO === "1";

/**
 * Minimal entry shape needed by `findLastUserEntryId`. Mirrors the subset
 * of `SessionEntry` we read so this helper can be unit-tested without
 * pulling in the full SDK type surface.
 */
export interface UndoEntry {
  type: string;
  id: string;
  message?: { role?: string };
}

/**
 * Find the id of the most recent user message in the active branch.
 * Walks the entries from leaf to root (newest to oldest) and returns the
 * id of the first one with `message.role === "user"`. Returns null if no
 * user message exists on the branch.
 *
 * - Skips non-message entries (model_change, thinking_level_change,
 *   compaction, custom, etc.) — they have no `message.role`.
 * - Skips assistant and toolResult messages — only typed user input
 *   counts as an "undoable" boundary.
 *
 * Pure function; exported for unit testing.
 */
export function findLastUserEntryId(branch: readonly UndoEntry[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message?.role === "user") {
      return entry.id;
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.registerCommand("undo", {
    description:
      "Revert the session to before your most recent message. " +
      "Aborts any in-flight stream, then forks a new session at that point " +
      "with your prompt restored to the editor (opencode-style).",
    handler: async (_args, ctx) => {
      // 1. If pi believes a stream is active, abort it first so the fork
      //    swap doesn't race with in-flight provider events. Failing to
      //    abort is non-fatal — pi may have already cleaned up between
      //    isIdle() and abort(), or there may be nothing to abort.
      const idle = (await ctx.isIdle?.()) ?? true;
      if (!idle) {
        try {
          await ctx.abort?.();
        } catch {
          // race with pi's own cleanup — ignore
        }
      }

      // 2. Find the most recent user message on the ACTIVE branch.
      //    getBranch() returns leaf-rooted entries in chronological order
      //    (root → leaf); we walk backward to find the most recent.
      const branch = ctx.sessionManager.getBranch() as unknown as UndoEntry[];
      const targetId = findLastUserEntryId(branch);

      if (!targetId) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Nothing to undo — no user message on this branch yet.",
            "warning",
          );
        }
        return;
      }

      // 3. Fork BEFORE the user message. Pi's `position: "before"` does two
      //    things: (a) creates a new session whose tail is the parent of
      //    the targeted entry, and (b) restores that user's prompt text
      //    into the input editor. The user can edit + resubmit, or scrub
      //    the editor and submit something else.
      const result = await ctx.fork(targetId, { position: "before" });
      if (result.cancelled && ctx.hasUI) {
        ctx.ui.notify(
          "Undo was cancelled by another extension.",
          "warning",
        );
      }
    },
  });
}
