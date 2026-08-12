#!/usr/bin/env bun
/**
 * tool-guard - Claude Code PreToolUse hook. Intercepts common anti-patterns
 * BEFORE they fire and DENIES with a reason that names the right tool, so the
 * model corrects on the next turn. Mirrors the pi tool_call guard's intent.
 *
 * Shares .pi/agent/extensions/lib/tool-guard-core.ts with the pi adapter
 * (.pi/agent/extensions/tool-guard.ts) - one detection table, two harnesses.
 * The core is zero-dependency, so this runs identically from the repo checkout
 * or the stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * Guarded surfaces (matcher Bash|Read|WebFetch):
 *   - Bash:     BASH_RULES anti-patterns (ls/find/cat /docs, grep -r, find
 *               -name, npm/pnpm/npx, chmod 777, unsigned commit, force-push to
 *               protected branch, unicode escapes, etc.) -> deny with redirect.
 *   - WebFetch: a docs.erfi.io URL -> deny, point at the docs_* tools.
 *   - Read:     no anti-pattern to block (the "prefer a tool over bash ls of a
 *               dir" nudge is the Bash side); Read calls pass through.
 *
 * pi-only cases are intentionally dropped here: apply_patch (CC has no such
 * tool), write_too_large (CC's Write path differs), and the advisory-only
 * reformulation-loop / docs-first / research-route surfaces (they need
 * per-session state + tool_result annotation that a stateless PreToolUse
 * deny cannot express). Those stay in the pi adapter.
 *
 * Kill switch: TOOL_GUARD_OFF=1 (parallels pi's DISABLED set).
 */

import {
  evaluateBashCommand,
  checkWebfetchDocs,
} from "../../.pi/agent/extensions/lib/tool-guard-core.ts";

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
  if (process.env.TOOL_GUARD_OFF === "1") process.exit(0);

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
    const command = String(input.command ?? "");
    const hit = evaluateBashCommand(command);
    if (hit) deny(`tool-guard[${hit.id}]: ${hit.reason}`);
  } else if (tool === "WebFetch") {
    const url = String(input.url ?? "");
    const msg = checkWebfetchDocs(url);
    if (msg) deny(`tool-guard[webfetch_docs]: ${msg}`);
  }
  // Read (and anything else) passes through untouched.

  process.exit(0); // clean: allow the call
}

await main();
