#!/usr/bin/env bun
/**
 * confidential-write-guard - Claude Code PreToolUse hook. DENIES any
 * Write/Edit/MultiEdit/Bash payload that contains a term the user previously
 * confirmed confidential (recorded in the local terms store). There is no
 * heuristic denylist: this enforces ONLY user-confirmed terms, so it can't
 * false-positive on a novel name - it deterministically stops re-leaking a name
 * the user already flagged (e.g. after an ask-loop in a prior turn).
 *
 * Shares .pi/agent/extensions/lib/confidential-write-guard-core.ts with the pi
 * adapter (confidential-write-guard.ts) - one term-scanner + store + payload
 * assembler, two harnesses. The core is zero-dependency, so this runs
 * identically from the repo checkout or the stowed ~/.claude/hooks/ symlink.
 *
 * Store locations (LOCAL, never committed) - same files the pi guard uses:
 *   - global:   <agentDir>/confidential-terms.local.json
 *   - per-repo: <repo>/.git/info/confidential-terms.json
 * agentDir resolves from CONFIDENTIAL_GUARD_AGENT_DIR, else PI_AGENT_DIR, else
 * the repo-local .pi/agent dir under cwd (matching the pi layout). The per-repo
 * store is derived from the write target / resolved bash cwd regardless.
 *
 * DENY (not the auto-rewrite path ascii-guard uses) is correct here: a
 * confidential leak has no safe automatic transform - the model must replace
 * the term with a placeholder itself. The reason masks the term as [REDACTED]
 * and never echoes it (echoing would re-propagate it into the session log - the
 * exact mistake the guard exists to prevent).
 *
 * We only DENY on a confirmed-term match; the once-per-repo vet *nudge* the pi
 * guard emits is a soft reminder that maps poorly to CC's deny/allow contract,
 * so it is intentionally omitted here (see notes in the port doc). The
 * deterministic block - the security-critical half - is fully ported.
 *
 * Kill switch: CONFIDENTIAL_GUARD_OFF=1 (parallels pi's PI_CONFIDENTIAL_GUARD_OFF).
 */

import * as path from "node:path";
import {
  blockedTermsFor,
  collectCommitPayload,
  evaluateCommitBash,
  evaluateWrite,
  isCommitPersist,
  resolveBashCwd,
  type GuardDecision,
} from "../../.pi/agent/extensions/lib/confidential-write-guard-core.ts";

const KILL_SWITCH = "CONFIDENTIAL_GUARD_OFF";

function agentDir(): string {
  return (
    process.env.CONFIDENTIAL_GUARD_AGENT_DIR ||
    process.env.PI_AGENT_DIR ||
    path.join(process.cwd(), ".pi", "agent")
  );
}

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
  if (process.env[KILL_SWITCH] === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  const dir = agentDir();

  if (tool === "Write") {
    const target = String(input.file_path ?? "");
    if (!target) process.exit(0);
    const d = evaluateWrite({
      target,
      blocked: blockedTermsFor(target, dir),
      blobs: [String(input.content ?? "")],
      where: `Write -> ${target}`,
      killSwitchEnv: KILL_SWITCH,
    });
    if (d.block) deny(d.reason);
  } else if (tool === "Edit") {
    const target = String(input.file_path ?? "");
    if (!target) process.exit(0);
    const d = evaluateWrite({
      target,
      blocked: blockedTermsFor(target, dir),
      blobs: [String(input.new_string ?? "")],
      where: `Edit -> ${target}`,
      killSwitchEnv: KILL_SWITCH,
    });
    if (d.block) deny(d.reason);
  } else if (tool === "MultiEdit") {
    const target = String(input.file_path ?? "");
    if (!target) process.exit(0);
    const edits = Array.isArray(input.edits) ? (input.edits as Array<{ new_string?: string }>) : [];
    const d = evaluateWrite({
      target,
      blocked: blockedTermsFor(target, dir),
      blobs: edits.map((e) => String(e?.new_string ?? "")),
      where: `MultiEdit -> ${target}`,
      killSwitchEnv: KILL_SWITCH,
    });
    if (d.block) deny(d.reason);
  } else if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (!isCommitPersist(cmd)) process.exit(0); // never scan read/search bash
    const cwd = resolveBashCwd(cmd);
    const d: GuardDecision = evaluateCommitBash({
      cmd,
      cwd,
      blocked: blockedTermsFor(cwd, dir),
      killSwitchEnv: KILL_SWITCH,
      collectPayload: (c, w) => collectCommitPayload(c, w),
    });
    if (d.block) deny(d.reason);
  }

  process.exit(0); // clean: allow the call
}

await main();
