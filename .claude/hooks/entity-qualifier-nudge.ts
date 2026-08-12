#!/usr/bin/env bun
/**
 * entity-qualifier-nudge - Claude Code PreToolUse hook (matcher:
 * Write|Edit|MultiEdit). Scans the PROSE being written into a file; if a bare
 * device identifier (eth0, br0, nvme0n1, ...) is cited as EVIDENCE without
 * naming which host it belongs to, it injects one advisory line as
 * additionalContext so the model can add the qualifier - "servarr's eth0"
 * instead of bare "eth0".
 *
 * Shares .pi/agent/extensions/lib/entity-qualifier-core.ts with the pi adapter
 * (entity-qualifier-nudge.ts) - one detection heuristic, two harnesses. The
 * core is zero-dependency, so this runs identically from the repo checkout or
 * the stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * additionalContext is used (NOT permissionDecision:deny) because the source
 * guard is advisory-only: it never blocks, it appends a single visible line so
 * a cross-host mix-up becomes catchable by a human reader. Denying the write
 * would over-enforce a heuristic that deliberately cannot verify the claim.
 * PreToolUse additionalContext is the documented, guaranteed channel for
 * injecting model-visible text before a tool runs. See
 * .pi/agent/docs/pi-to-claude-code-port.md (capability matrix line for
 * PreToolUse).
 *
 * oncePerToolCall: this fires per Write/Edit/MultiEdit; one line per matching
 * call. Cross-call dedupe is intentionally omitted - each file write is a
 * distinct opportunity for the mix-up.
 *
 * Kill switch: ENTITY_NUDGE_OFF=1 (parallels pi's PI_ENTITY_NUDGE_OFF).
 */

import { needsHostQualifier, NUDGE_LINE } from "../../.pi/agent/extensions/lib/entity-qualifier-core.ts";

function emit(context: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

/** Pull the prose payload from the tool input (Write/Edit/MultiEdit shapes). */
function proseFor(tool: string | undefined, input: Record<string, unknown>): string {
  if (tool === "Write") return String(input.content ?? "");
  if (tool === "Edit") return String(input.new_string ?? "");
  if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<{ new_string?: string }>) : [];
    return edits.map((e) => e?.new_string ?? "").join("\n");
  }
  return "";
}

async function main() {
  if (process.env.ENTITY_NUDGE_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};

  const text = proseFor(tool, input);
  if (!text) process.exit(0);

  if (needsHostQualifier(text)) emit(NUDGE_LINE);

  process.exit(0); // clean: nothing to nudge
}

await main();
