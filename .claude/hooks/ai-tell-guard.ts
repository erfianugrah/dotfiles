#!/usr/bin/env bun
/**
 * ai-tell-guard - Claude Code PreToolUse hook. Blocks Write/Edit/MultiEdit
 * and write-ish Bash payloads containing high-precision AI-prose tells
 * (negative parallelism, "No X, no Y. Just Z.", mystery-tease framing, slop
 * vocabulary) in PROSE files only.
 *
 * Shares .pi/agent/extensions/lib/ai-tell-core.ts with the pi adapter
 * (ai-tell-guard.ts) - one detection table, two harnesses. Zero-dependency,
 * runs from the repo checkout or the stowed ~/.claude/hooks/ symlink.
 *
 * Unlike ascii-guard there is no auto-rewrite: the fix is a rephrase, which
 * only the model can do. Deny + reason only.
 *
 * Kill switch: AI_TELL_GUARD_OFF=1 or PI_AI_TELL_GUARD_OFF=1.
 */

import { isProsePath, scanTells, tellReason } from "../../.pi/agent/extensions/lib/ai-tell-core.ts";
import { WRITE_BASH } from "../../.pi/agent/extensions/lib/ascii-core.ts";

function deny(hits: ReturnType<typeof scanTells>, where: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: tellReason(hits, where),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  if (process.env.AI_TELL_GUARD_OFF === "1" || process.env.PI_AI_TELL_GUARD_OFF === "1") process.exit(0);

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
    const target = String(input.file_path ?? "");
    if (!isProsePath(target)) process.exit(0);
    const found = scanTells(String(input.content ?? ""));
    if (found.length) deny(found, `Write -> ${target}`);
  } else if (tool === "Edit") {
    const target = String(input.file_path ?? "");
    if (!isProsePath(target)) process.exit(0);
    const found = scanTells(String(input.new_string ?? ""));
    if (found.length) deny(found, `Edit -> ${target}`);
  } else if (tool === "MultiEdit") {
    const target = String(input.file_path ?? "");
    if (!isProsePath(target)) process.exit(0);
    const edits = Array.isArray(input.edits) ? (input.edits as Array<{ new_string?: string }>) : [];
    const found = scanTells(edits.map((e) => e?.new_string ?? "").join("\n"));
    if (found.length) deny(found, `MultiEdit -> ${target}`);
  } else if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (WRITE_BASH.test(cmd)) {
      const found = scanTells(cmd);
      if (found.length) deny(found, "Bash (writes/commits)");
    }
  }

  process.exit(0); // clean: allow the call
}

await main();
