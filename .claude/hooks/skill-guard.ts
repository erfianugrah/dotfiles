#!/usr/bin/env bun
/**
 * skill-guard - Claude Code PreToolUse hook. When a tool call targets a domain
 * that has a matching skill the model tends to skip (Dockerfile -> docker,
 * *.tf -> terraform, `flyctl deploy` -> fly, ...), inject a NON-BLOCKING pointer
 * nudging the model to read that skill's SKILL.md first.
 *
 * Shares .pi/agent/extensions/lib/skill-guard-core.ts with the pi adapter
 * (skill-guard.ts) - one rule table, two harnesses. The core is
 * zero-dependency, so this runs identically from the repo checkout or the
 * stowed ~/.claude/hooks/ symlink (no node_modules needed).
 *
 * Event / decision choice (deliberate, see .pi/agent/docs/pi-to-claude-code-
 * port.md):
 *   - The pi extension has TWO hooks: an intent nudge on before_agent_start
 *     (prompt-time) and an action nudge on tool_call. CC's UserPromptSubmit
 *     context-injection is UNVERIFIED in the installed build (older CC injected
 *     exit-0 stdout; current docs describe a decision:block contract), so we do
 *     NOT port the intent path here - it would be the unverified surface.
 *   - Instead we port the ACTION path to the VERIFIED PreToolUse
 *     `additionalContext` channel: a documented, non-blocking way to feed the
 *     model an advisory. We use additionalContext rather than
 *     permissionDecision:"deny" because the guard's intent is a POINTER ("read
 *     the SKILL.md, then proceed"), not a hard block - denying would fight the
 *     tool call the model already decided to make.
 *
 * Session-level one-shot dedup (the pi "fire once per skill per session")
 * cannot be done from a stateless per-invocation hook without shared state;
 * additionalContext is already low-friction (advisory, not a block), so we emit
 * on every matching call and leave dedup to a future stateful upgrade.
 *
 * Kill switch: SKILL_GUARD_OFF=1 (parallels the pi extension's DISABLED set).
 */

import {
  matchToolCall,
  actionReason,
  type SkillHint,
} from "../../.pi/agent/extensions/lib/skill-guard-core.ts";

// CC skills live under ~/.claude/skills; override the core's default pi path so
// the pointer the model reads is harness-native.
const CC_SKILLS_DIR = "~/.claude/skills";

function inject(hint: SkillHint): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: actionReason(hint, CC_SKILLS_DIR),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  if (process.env.SKILL_GUARD_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};

  const hint = matchToolCall(tool, input);
  if (hint) inject(hint);

  process.exit(0); // clean: no matching skill, allow the call untouched
}

await main();
