#!/usr/bin/env bun
/**
 * dangerous-cmd-guard - Claude Code PreToolUse hook. DENIES destructive shell
 * commands (rm -rf outside scratch paths, rm on /~/cwd, dd/mkfs on block
 * devices, find -delete, xargs rm -r, power-cycle, fork bombs, ...) so the
 * model must re-run intentionally rather than delete real data on a typo'd
 * path. CC has no interactive "ask" in the established hook contract here, so
 * both tiers deny; the reason tells the model how to proceed safely.
 *
 * Shares the pure classifier in
 * .pi/agent/extensions/lib/dangerous-cmd-guard-core.ts with the pi adapter
 * (extensions/dangerous-cmd-guard.ts) - one rule table, two harnesses. The
 * core is zero-dependency, so this runs identically from the repo checkout or
 * the stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * Kill switch: DANGEROUS_CMD_GUARD_OFF=1.
 */

import { homedir } from "node:os";
import {
  classifyBashCommand,
  type GuardEnv,
} from "../../.pi/agent/extensions/lib/dangerous-cmd-guard-core.ts";

function deny(reason: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  if (process.env.DANGEROUS_CMD_GUARD_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    cwd?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  if (payload.tool_name !== "Bash") process.exit(0);
  const input = payload.tool_input ?? {};
  const command = String(input.command ?? "");
  if (!command) process.exit(0);

  const env: GuardEnv = {
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd(),
    home: homedir(),
  };
  const decision = classifyBashCommand(command, env);
  if (!decision.dangerous) process.exit(0);

  deny(`dangerous-cmd-guard[${decision.rule}] (${decision.tier}): ${decision.reason}`);
}

await main();
