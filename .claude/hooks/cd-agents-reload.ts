#!/usr/bin/env bun
/**
 * cd-agents-reload - Claude Code PreToolUse (Bash) hook. Closes the "cd into
 * another repo mid-session" context gap: CC loads CLAUDE.md / AGENTS.md from
 * cwd + parents at session start but does NOT re-load when the agent `cd`s
 * into a sibling repo, so that repo's project-canonical commands (Makefile
 * targets, `just` recipes) get bypassed for generic `docker compose` / `npm`.
 *
 * Shares .pi/agent/extensions/lib/cd-agents-reload-core.ts with the pi adapter
 * (../../.pi/agent/extensions/cd-agents-reload.ts) - one detection + decision
 * table, two harnesses. The core is zero-dependency, so this runs identically
 * from the repo checkout or the stowed ~/.claude/hooks/ symlink.
 *
 * additionalContext (NOT deny) is used: CC reads CLAUDE.md natively, so
 * blocking every cross-repo `cd` would be heavy-handed. Instead we let the
 * command run and INJECT the target repo's AGENTS.md/CLAUDE.md head as
 * additionalContext, so its rules land in the model's context for the rest of
 * the session. Fires once per (session-process x target-dir) via a state file,
 * mirroring the pi guard's once-per-target semantics.
 *
 * SessionStart note: the suggested SessionStart event cannot see a mid-session
 * `cd` (no command to inspect), so PreToolUse Bash is the semantically correct
 * hook for this guard. See .pi/agent/docs/pi-to-claude-code-port.md.
 *
 * Kill switch: CD_AGENTS_RELOAD_OFF=1 or PI_NO_CD_AGENTS_RELOAD=1 (both honored).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildStartupSet,
  decideForCommand,
} from "../../.pi/agent/extensions/lib/cd-agents-reload-core.ts";

// Per-session warned-set persistence. CC spawns a fresh hook process per tool
// call, so an in-memory Set won't survive; we persist the fired target dirs to
// a temp file keyed by the CC session_id (falls back to the cwd hash).
function stateFile(sessionId: string): string {
  const dir = join(tmpdir(), "cc-cd-agents-reload");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha1").update(sessionId).digest("hex").slice(0, 16);
  return join(dir, `${key}.json`);
}

function loadWarned(file: string): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(file, "utf8")) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveWarned(file: string, warned: Set<string>): void {
  try {
    writeFileSync(file, JSON.stringify([...warned]));
  } catch {
    /* best-effort */
  }
}

function inject(context: string): never {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function main() {
  if (process.env.CD_AGENTS_RELOAD_OFF === "1" || process.env.PI_NO_CD_AGENTS_RELOAD === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    session_id?: string;
    cwd?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not our concern; let the call proceed
  }

  if (payload.tool_name !== "Bash") process.exit(0);
  const cmd = String(payload.tool_input?.command ?? "");
  if (!cmd) process.exit(0);

  const startupCwd = payload.cwd || process.cwd();
  const startupLoaded = buildStartupSet(startupCwd);

  const file = stateFile(payload.session_id || startupCwd);
  const warned = loadWarned(file);
  const before = warned.size;

  const decision = decideForCommand({
    command: cmd,
    startupCwd,
    startupLoaded,
    alreadyWarned: warned,
    fsExists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    // no rerunFullNotice: this hook injects rather than blocks, so nothing was
    // swallowed and the "re-run the FULL command" notice does not apply.
  });

  // Persist the warned set if decideForCommand marked a target (fired or a
  // read-failure no-fire) so we don't re-probe the same dir repeatedly.
  if (warned.size !== before) saveWarned(file, warned);

  if (decision) inject(decision.message);

  process.exit(0); // clean: allow the call, nothing to inject
}

await main();
