#!/usr/bin/env bun
/**
 * git-gh-gate - Claude Code PreToolUse hook. DENIES mutating git/gh commands
 * (git commit/push/reset/rebase/.../gh pr/issue/release/...) and direct writes
 * to .git internals, so the model must re-run intentionally rather than mutate
 * history/remotes on a hair trigger.
 *
 * Shares the pure classifier in
 * .pi/agent/extensions/lib/git-gh-gate-core.ts with the pi adapter
 * (extensions/git-gh-gate.ts) - one pattern table, two harnesses. The core is
 * zero-dependency, so this runs identically from the repo checkout or the
 * stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * Deny is used (not ask) because it is the well-established, guaranteed
 * PreToolUse contract and matches the sibling ascii-guard hook. The model sees
 * the reason and can decide whether to re-run. The apply_patch-envelope layer
 * from the pi version is intentionally dropped: CC has no apply_patch tool.
 * The .git-internals check still applies to Write/Edit/MultiEdit.
 *
 * Kill switch: GIT_GH_GATE_OFF=1.
 */

import {
  classifyBashCommand,
  classifyWritePath,
} from "../../.pi/agent/extensions/lib/git-gh-gate-core.ts";

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
  if (process.env.GIT_GH_GATE_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    const decision = classifyBashCommand(cmd);
    if (decision.gated) deny(decision.reason ?? "Mutating git/gh command blocked.");
  } else if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const filePath = String(input.file_path ?? "");
    const decision = classifyWritePath(filePath);
    if (decision.gated) deny(decision.reason ?? "Write to .git internals blocked.");
  }

  process.exit(0); // clean: allow the call
}

await main();
