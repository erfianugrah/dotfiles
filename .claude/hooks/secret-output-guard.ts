#!/usr/bin/env bun
/**
 * secret-output-guard - Claude Code hook. Keeps secret VALUES out of tool
 * results while leaving credential USE untouched (`curl -H "X-API-Key: $KEY"`
 * is the intended pattern; the var NAME in a command is harmless).
 *
 * Mirrors the pi extension (.pi/agent/extensions/secret-output-guard.ts) and
 * shares lib/secret-output-guard-core.ts with it - one detection table, two
 * harnesses. The core is zero-dependency, so this runs identically from the
 * repo checkout or the stowed ~/.claude/hooks/ symlink.
 *
 * Two halves, one file (registered under both events; branches on
 * payload.hook_event_name):
 *
 *   PreToolUse (Bash): DENY wholesale env dumps (`env`, `printenv`, bare
 *     `set`, `export -p`, `declare -x` - bare or piped/redirected). Same
 *     detection as pi's tool_call block.
 *
 *   PostToolUse (Bash|Read|Grep|WebFetch): CC hooks CANNOT mutate tool
 *     results (PostToolUse only appends additionalContext - see the
 *     bash-error-hints header and .pi/agent/docs/pi-to-claude-code-port.md),
 *     so pi's redaction layer has no CC equivalent. Best available: DETECT a
 *     live secret value in the finished tool_response (exact match against
 *     sensitive-named env values + the token-format table) and raise a
 *     rotate-it alarm. The alarm names the var/format but never echoes the
 *     value or even its masked prefix.
 *
 * Kill switch: SECRET_GUARD_OFF=1 or PI_SECRET_GUARD_OFF=1 (both honored -
 * the pi-side reason advertises the PI_ name, so it must work here).
 */

import {
  collectSensitiveEnv,
  envDumpSegment,
  FORMAT_RULES,
} from "../../.pi/agent/extensions/lib/secret-output-guard-core.ts";
import { splitSegments } from "../../.pi/agent/extensions/lib/tool-guard-core.ts";

function deny(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function alarm(context: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    }),
  );
  process.exit(0);
}

const DENY_REASON =
  "wholesale environment dump (`env`/`printenv`/bare `set`/`export -p`) prints EVERY secret in the " +
  "process env into the session transcript. Use credentials by var reference ($NAME) without printing " +
  "them. To check one variable is set: `env | grep ^NAME | sed 's/=.*/=<set>/'`. " +
  "Kill switch: PI_SECRET_GUARD_OFF=1.";

async function main() {
  if (process.env.SECRET_GUARD_OFF === "1" || process.env.PI_SECRET_GUARD_OFF === "1") {
    process.exit(0);
  }

  const raw = await Bun.stdin.text();
  let payload: {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    tool_result?: unknown;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable payload - not our concern; let the call proceed
  }

  const isPost =
    payload.hook_event_name === "PostToolUse" ||
    (payload.hook_event_name === undefined && payload.tool_response !== undefined);

  if (!isPost) {
    // ── PreToolUse: deny wholesale env dumps (Bash only) ──
    if (payload.tool_name !== "Bash") process.exit(0);
    const command = String(payload.tool_input?.command ?? "");
    if (!command) process.exit(0);
    const hit = envDumpSegment(splitSegments(command));
    if (hit) deny(`secret-output-guard: blocked \`${hit}\` - ${DENY_REASON}`);
    process.exit(0);
  }

  // ── PostToolUse: leak alarm (detection only - CC cannot redact) ──
  const resp = payload.tool_response ?? payload.tool_result;
  if (resp === undefined || resp === null) process.exit(0);
  const text = typeof resp === "string" ? resp : JSON.stringify(resp);
  if (!text) process.exit(0);

  const labels: string[] = [];
  for (const { name, value } of collectSensitiveEnv(
    process.env as Record<string, string | undefined>,
  )) {
    if (text.includes(value)) labels.push(`env:${name}`);
  }
  for (const rule of FORMAT_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) labels.push(`format:${rule.id}`);
  }
  if (labels.length === 0) process.exit(0);

  alarm(
    `secret-output-guard ALARM: this tool result contained live secret value(s): ${labels.join(", ")}. ` +
      `Claude Code hooks cannot redact tool output - the value IS now in the session transcript. ` +
      `Treat the credential as compromised: tell the user it should be rotated, and do not print it again ` +
      `(reference it by env-var name or file path only).`,
  );
}

main();
