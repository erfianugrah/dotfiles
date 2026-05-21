/**
 * migrate-sessions — `/migrate-sessions [args]` slash command.
 *
 * Wraps `~/dotfiles/bin/opencode-to-pi-sessions` so the user can re-run the
 * opencode → Pi session migration without dropping out of the TUI. The
 * underlying script is idempotent (skips sessions already present in
 * `~/.pi/agent/sessions/<encoded-cwd>/`), so it's safe to fire any time:
 * call it after a long opencode work session to backfill the new entries.
 *
 * Args are passed through verbatim to the script:
 *   /migrate-sessions                   # --db prod (default)
 *   /migrate-sessions --db opencode-dev # dev DB
 *   /migrate-sessions --dry-run         # show would-migrate count, no writes
 *   /migrate-sessions --since 2026-05-01
 *   /migrate-sessions --limit 50
 *
 * Output is captured and surfaced via ctx.ui.notify — for long runs the user
 * sees "Running migration..." up front, then "✓ migrated: N / skipped: M /
 * elapsed: Ts" when done. Failure messages go to "error" toast level so they
 * survive notification auto-dismiss.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCRIPT_PATH = `${process.env.HOME}/dotfiles/bin/opencode-to-pi-sessions`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("migrate-sessions", {
    description: "Backfill opencode sessions into Pi (idempotent; default --db prod)",
    handler: async (args, ctx) => {
      if (!existsSync(SCRIPT_PATH)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`migrate-sessions: script not found at ${SCRIPT_PATH}`, "error");
        }
        return;
      }

      // Parse args — if none provided, default to --db prod. Pass through
      // anything the user typed (--db <name>, --dry-run, --since, --limit).
      // Tokenise on whitespace; quoted args with embedded spaces are rare
      // for this script and we don't bother with shell-style parsing.
      const trimmed = args.trim();
      const scriptArgs = trimmed ? trimmed.split(/\s+/) : ["--db", "prod"];

      if (ctx.hasUI) {
        ctx.ui.notify(`Migrating opencode sessions (${scriptArgs.join(" ")})...`, "info");
      }

      const proc = spawn("bun", [SCRIPT_PATH, ...scriptArgs], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf-8");
      });
      proc.stderr.on("data", (d: Buffer) => {
        stdout += d.toString("utf-8");
      });

      const exitCode: number | null = await new Promise((resolve) => {
        proc.on("close", (code) => resolve(code));
      });

      // Extract the summary block — the script prints a stable trailing
      // block starting with "✓ migrated:" or "found N sessions". Fall back
      // to last 8 lines if we can't find it.
      const summaryMatch = stdout.match(/(✓ migrated:[\s\S]+?elapsed: \d+\.?\d*s)/);
      const summary =
        summaryMatch?.[1] ??
        stdout.trim().split("\n").slice(-8).join("\n");

      if (ctx.hasUI) {
        if (exitCode === 0) {
          ctx.ui.notify(`Migration complete\n${summary}`, "info");
        } else {
          ctx.ui.notify(`Migration failed (exit ${exitCode})\n${summary}`, "error");
        }
      }
    },
  });
}
