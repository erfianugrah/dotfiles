#!/usr/bin/env bun
/**
 * lookup-before-ask - Claude Code PreToolUse hook on the AskUserQuestion tool.
 * When the agent is about to ask the USER for a fact about the user's own
 * infrastructure (a measurement, spec, identifier, date, or past decision
 * anchored to their own kit), it nudges the model to search memledger/session
 * first - the lookup that never fires because those are pull-only tools.
 *
 * Shares .pi/agent/extensions/lib/lookup-before-ask-core.ts with the pi adapter
 * (lookup-before-ask.ts) - one detector, two harnesses. The core is
 * zero-dependency, so this runs from the repo checkout or the stowed
 * ~/.claude/hooks/ symlink with no node_modules.
 *
 * ADVISORY, not a guard: it emits additionalContext, never a deny. A deny on
 * AskUserQuestion would strand the model with no way to reach the user at all -
 * the wrong failure mode. This mirrors the pi adapter, which appends an
 * advisory line to the assistant's own message rather than blocking. See
 * .pi/agent/docs/pi-to-claude-code-port.md.
 *
 * Kill switch: LOOKUP_NUDGE_OFF=1 (parallels pi's PI_LOOKUP_NUDGE_OFF).
 */

import { decideAskContext } from "../../.pi/agent/extensions/lib/lookup-before-ask-core.ts";

async function main() {
  if (process.env.LOOKUP_NUDGE_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  // Only the ask-the-user tool is in scope.
  if (payload.tool_name !== "AskUserQuestion") process.exit(0);

  const decision = decideAskContext(payload.tool_input ?? {});
  if (decision) {
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: decision.additionalContext,
      },
    };
    process.stdout.write(JSON.stringify(out));
  }

  process.exit(0); // clean: allow the ask either way
}

await main();
