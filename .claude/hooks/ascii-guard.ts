#!/usr/bin/env bun
/**
 * ascii-guard - Claude Code PreToolUse hook. Blocks Write/Edit/MultiEdit/Bash
 * payloads containing mojibake-prone "smart" punctuation and hands back the
 * exact ASCII-folded form so the model can resubmit in one shot.
 *
 * Shares .pi/agent/extensions/lib/ascii-core.ts with the pi adapter
 * (ascii-punctuation-guard.ts) - one detection table, two harnesses. The core
 * is zero-dependency, so this runs identically from the repo checkout or the
 * stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * Deny is used (not updatedInput auto-rewrite) because it is the well-
 * established, guaranteed contract; auto-rewrite via PreToolUse updatedInput is
 * a documented future enhancement pending live-CC confirmation. See
 * .pi/agent/docs/pi-to-claude-code-port.md.
 *
 * Kill switch: ASCII_GUARD_OFF=1 (parallels pi's PI_ASCII_GUARD_OFF).
 */

import { foldToAscii, reason, scan, WRITE_BASH, type Found } from "../../.pi/agent/extensions/lib/ascii-core.ts";

function deny(found: Found[], where: string, fixed: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${reason(found, where)}\nASCII-folded form to resubmit:\n${fixed}`,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  if (process.env.ASCII_GUARD_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};

  if (tool === "Write") {
    const text = String(input.content ?? "");
    const found = scan(text);
    if (found.length) deny(found, `Write -> ${String(input.file_path ?? "")}`, foldToAscii(text));
  } else if (tool === "Edit") {
    const text = String(input.new_string ?? "");
    const found = scan(text);
    if (found.length) deny(found, `Edit -> ${String(input.file_path ?? "")}`, foldToAscii(text));
  } else if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<{ new_string?: string }>) : [];
    const text = edits.map((e) => e?.new_string ?? "").join("\n");
    const found = scan(text);
    if (found.length) deny(found, `MultiEdit -> ${String(input.file_path ?? "")}`, foldToAscii(text));
  } else if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (WRITE_BASH.test(cmd)) {
      const found = scan(cmd);
      if (found.length) deny(found, "Bash (writes/commits)", foldToAscii(cmd));
    }
  }

  process.exit(0); // clean: allow the call
}

await main();
