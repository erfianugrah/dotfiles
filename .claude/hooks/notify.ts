#!/usr/bin/env bun
/**
 * notify - Claude Code Stop hook. Fires a native desktop notification when the
 * agent finishes a turn ("ready for input"), so you can context-switch during
 * long runs and get pulled back.
 *
 * Shares .pi/agent/extensions/lib/notify-core.ts with the pi adapter
 * (notify.ts, which fires on `agent_end`) - one protocol table, two harnesses.
 * The core is zero-dependency, so this runs identically from the repo checkout
 * or a stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * The Stop hook payload is {session_id, transcript_path, stop_hook_active, ...}
 * - there is no tool_input to inspect; the event itself is the trigger. We read
 * and discard stdin (to drain the pipe) and emit the notification.
 *
 * Non-TTY guard: when stdout is not a terminal (piped / JSON event stream) the
 * core selects transport "skip" so we never corrupt the stream with OSC bytes.
 * A Stop hook produces no hookSpecificOutput; a clean exit 0 is the contract.
 *
 * Kill switch: NOTIFY_OFF=1 (parallels the pi extension being disabled).
 */

import { envFromProcess, planNotify } from "../../.pi/agent/extensions/lib/notify-core.ts";

async function main() {
  if (process.env.NOTIFY_OFF === "1") process.exit(0);

  // Drain stdin so the parent's pipe closes cleanly; payload is not needed.
  try {
    await Bun.stdin.text();
  } catch {
    // no stdin is fine
  }

  const plan = planNotify("Claude Code", "ready for input", envFromProcess());
  if (plan.stdout) {
    process.stdout.write(plan.stdout);
  } else if (plan.spawn) {
    const { execFile } = await import("node:child_process");
    execFile(plan.spawn.file, plan.spawn.args);
  }
  // transport === "skip": non-TTY -> emit nothing.

  process.exit(0);
}

await main();
