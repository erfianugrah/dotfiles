/**
 * notify - desktop ping when the agent finishes a turn.
 *
 * Sends a native terminal notification on `agent_end` so you can context-switch
 * during long runs and get pulled back when input is needed.
 *
 * Protocol selection, byte building, and the non-TTY guard all live in the pure
 * ./lib/notify-core.ts (shared with the Claude Code Stop hook). This adapter is
 * a thin shell: build the plan, then carry it out (write stdout / spawn toast).
 *
 * Caveat: this user runs inside tmux (TERM_PROGRAM=tmux). Tmux strips unknown
 * OSC sequences by default. If notifications don't appear, enable passthrough
 * in ~/.tmux.conf:
 *
 *   set -g allow-passthrough on
 *
 * or upgrade to tmux 3.3+ which permits OSC 777 through wrapped DCS.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envFromProcess, planNotify } from "./lib/notify-core.ts";

// Re-export the pure core so any downstream/test importer resolves from the
// adapter path (parity with the osv-scan adapter re-export idiom).
export {
  envFromProcess,
  osc777Bytes,
  osc99Bytes,
  planNotify,
  selectTransport,
  windowsToastScript,
  type NotifyEnv,
  type NotifyPlan,
  type Transport,
} from "./lib/notify-core.ts";

function runPlan(title: string, body: string): void {
  const plan = planNotify(title, body, envFromProcess());
  if (plan.stdout) {
    process.stdout.write(plan.stdout);
  } else if (plan.spawn) {
    const { execFile } = require("node:child_process");
    execFile(plan.spawn.file, plan.spawn.args);
  }
  // transport === "skip": intentionally do nothing (non-TTY JSON stream).
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    runPlan("pi", "ready for input");
  });
}
