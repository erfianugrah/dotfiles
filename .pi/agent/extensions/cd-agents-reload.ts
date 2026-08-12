/**
 * cd-agents-reload — close the "cd into another repo" context gap.
 *
 * Pi loads AGENTS.md / CLAUDE.md from cwd + parents AT SESSION START. It
 * does not re-load when the agent `cd`s into another repo mid-session, so
 * project-specific instructions in `<other-repo>/AGENTS.md` are invisible
 * to the LLM and project-canonical commands (Makefile targets, `just`
 * recipes, repo-specific deploy scripts) get bypassed in favour of generic
 * `docker compose build` / `npm run build` calls.
 *
 * This extension fires once per (session × target-dir):
 *
 *   1. Detect `cd <dir>` segments in bash commands.
 *   2. Resolve <dir> against pi's startup cwd; skip if it's an ancestor
 *      already covered by the startup context load.
 *   3. If <target>/AGENTS.md (or CLAUDE.md) exists and we haven't shown
 *      it this session, block the bash call with the file head as the
 *      reason. The agent re-runs the bash after acknowledging the rules.
 *
 * Two refinements (2026-07-07, see guard-commit-shared.ts for the incident):
 *   - The block reason includes RERUN_FULL_NOTICE: the ENTIRE command was
 *     blocked (no segment executed - heredocs, `git add`, tmp files), so the
 *     agent must re-run the FULL original command verbatim, not a suffix.
 *   - If the blocked command is ALSO a commit/PR/issue persist, this guard
 *     absorbs the confidential-write guard's once-per-repo vet nudge
 *     (appends its text, marks the repo nudged) - pi short-circuits
 *     tool_call handlers on the first block, so without this the verbatim
 *     re-run gets blocked a SECOND time by that guard, swallowing the
 *     compound command's side effects twice.
 *
 * Disable: `PI_NO_CD_AGENTS_RELOAD=1` in env, or comment-out the registration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  commitNudgeForBlockedCmd,
  isCommitNudged,
  markCommitNudged,
  RERUN_FULL_NOTICE,
} from "./lib/guard-commit-shared";
import {
  buildStartupSet,
  decideForCommand,
  decideTarget,
  expandTilde,
  extractCdTargets,
} from "./lib/cd-agents-reload-core.ts";

// Re-export the pure helpers so existing importers (tests/extensions.test.ts)
// keep resolving them here.
export { decideTarget, expandTilde, extractCdTargets };

export default function (pi: ExtensionAPI) {
  if (process.env.PI_NO_CD_AGENTS_RELOAD === "1") return;

  const startupCwd = process.cwd();
  const startupLoaded = buildStartupSet(startupCwd);
  const warned = new Set<string>();

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const cmd = (event.input as { command?: string }).command;
    if (typeof cmd !== "string" || cmd.length === 0) return undefined;

    const decision = decideForCommand({
      command: cmd,
      startupCwd,
      startupLoaded,
      alreadyWarned: warned,
      rerunFullNotice: RERUN_FULL_NOTICE,
    });
    if (!decision) return undefined;

    let reason = decision.message;

    // Commit-nudge absorption: if the command we're blocking is ALSO a
    // commit/PR/issue persist into this repo, the confidential-write
    // guard's once-per-repo vet nudge would otherwise block the verbatim
    // re-run a SECOND time (pi short-circuits tool_call handlers on the
    // first block, so that guard never saw this call). Deliver its message
    // here and mark the repo nudged - one block, both messages, one re-run.
    const nudge = commitNudgeForBlockedCmd(cmd, decision.target);
    if (nudge && !isCommitNudged(nudge.root)) {
      markCommitNudged(nudge.root);
      reason += `\n\n${nudge.text}`;
    }

    return { block: true, reason };
  });
}
