/**
 * guard-commit-shared - shared state + message text for the two guards that
 * can block the SAME compound `... && git commit ...` bash command:
 * cd-agents-reload (surfaces an unloaded AGENTS.md) and
 * confidential-write-guard (once-per-repo commit vet nudge).
 *
 * Motivating incident (2026-07-07): a compound command of the form
 *
 *   cat > /tmp/msg <<'EOF' ... EOF
 *   cd ~/repo && git add ... && git commit -F /tmp/msg && git push
 *
 * was blocked by cd-agents-reload. Pi short-circuits remaining tool_call
 * handlers on the first block, so confidential-write-guard's nudge tracker
 * never saw the command. Worse, the block reason said only "re-run your
 * bash" - it did NOT say the whole command had been swallowed. The agent
 * retried just the `git commit` suffix (message file never written ->
 * "No such file or directory"), then re-staged-but-not-really, burning
 * four turns; and when it finally re-ran the full compound, the
 * confidential guard blocked it AGAIN (its once-per-repo nudge still
 * pending), swallowing the heredoc + `git add` a second time.
 *
 * Two fixes live here so both guards share them:
 *
 *   1. RERUN_FULL_NOTICE - appended to every block reason from both guards.
 *      States plainly that the ENTIRE command was blocked (no segment
 *      executed) and that the agent must re-run the FULL original command
 *      verbatim, not a suffix.
 *
 *   2. A shared commit-nudge registry (isCommitNudged / markCommitNudged).
 *      cd-agents-reload runs earlier in extension load order and
 *      short-circuits, so when IT blocks a command that is also a
 *      commit-persist into a repo whose vet nudge hasn't fired, it marks
 *      the nudge delivered and appends the COMMIT_NUDGE text to its own
 *      block reason - one block, both messages, a single re-run, instead
 *      of two cascaded blocks each swallowing the compound's side effects.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── commit-persist detection (shared trigger) ───────────────────────────────

// bash commands that PERSIST PROSE TO A (possibly shared/public) REMOTE - commit
// messages, tags, PR/issue/release bodies. Deliberately narrow: read/search
// commands must never trip it. See confidential-write-guard.ts for the full
// rationale (this regex used to also match redirects / tee / sd / sed -i and
// blocked READ commands whose search pattern contained a blocked term).
const COMMIT_PERSIST =
  /\bgit\s+commit\b|\bgit\s+(?:tag|notes)\b|\bgh\s+(?:pr|issue|release)\s+(?:create|edit|comment)\b/;

/** True when a bash command persists a commit message / PR / issue body. */
export function isCommitPersist(cmd: string): boolean {
  return COMMIT_PERSIST.test(cmd);
}

// ── repo helpers (shared by both guards) ────────────────────────────────────

/** Walk up from a path for a .git entry; return repo root or null. */
export function findRepoRoot(start: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  let dir = start;
  try {
    if (fs.statSync(start).isFile()) dir = path.dirname(start);
  } catch {
    dir = path.dirname(start);
  }
  for (let i = 0; i < 64; i++) {
    if (exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function repoHasRemote(repoRoot: string): boolean {
  try {
    return /\n\[remote "/.test("\n" + fs.readFileSync(path.join(repoRoot, ".git", "config"), "utf8"));
  } catch {
    return true; // can't tell → assume yes (fail safe toward nudging)
  }
}

// ── the "nothing executed" notice ───────────────────────────────────────────

// Appended to every block reason from the two bash-blocking guards. Without
// this the agent sees "retry" and reasonably retries only the FAILING-looking
// suffix (`git commit ...`) - but a block stops the whole call, so the
// heredoc that writes the -F message file and the `git add` never ran.
export const RERUN_FULL_NOTICE =
  `IMPORTANT - the ENTIRE bash command was blocked before anything ran: no segment of it ` +
  `executed. Any preparation steps in it (heredoc/redirect file writes, \`git add\`, tmp files) ` +
  `did NOT happen. After acknowledging, re-run the FULL original command verbatim - do NOT ` +
  `retry only a suffix (e.g. the bare \`git commit\`), or it will fail on the missing ` +
  `preparation (message file absent, changes unstaged).`;

// ── commit vet-nudge text + shared once-per-repo registry ───────────────────

export const COMMIT_NUDGE = (repoRoot: string, remote: boolean): string =>
  `tool-guard[confidential-write]: first commit / PR / issue write into ${repoRoot}` +
  `${remote ? " (has a remote - may be public/shared)" : ""}.\n` +
  `A commit message + staged diff are about to be persisted. Before this lands, vet BOTH the ` +
  `message and the staged changes for confidential third-party identifiers - not just named ` +
  `customers/partners/individuals and internal codenames, but internal-vs-public framing itself ` +
  `("internal <X>", "the public counterpart to our internal ...", internal label/naming schemes, ` +
  `unreleased roadmap). You are the classifier - there is no denylist. For ANY term or phrasing you ` +
  `are not certain is safe to publish, rephrase or use a placeholder, and record confirmed-confidential ` +
  `terms with the \`confidential_terms\` tool so they're enforced. If you have already vetted this ` +
  `content, re-run the command - this fires once per repo. Kill switch: PI_CONFIDENTIAL_GUARD_OFF=1.\n\n` +
  RERUN_FULL_NOTICE;

const commitNudgedRepos = new Set<string>();

export function isCommitNudged(root: string): boolean {
  return commitNudgedRepos.has(root);
}

export function markCommitNudged(root: string): void {
  commitNudgedRepos.add(root);
}

/** Test hook: clear the once-per-repo registry. */
export function _resetCommitNudges(): void {
  commitNudgedRepos.clear();
}

/**
 * Coordination helper for cd-agents-reload: when it is about to block a
 * command, call this with the command + the cd target dir. If the command is
 * a commit-persist into a repo, returns { root, text } with the vet-nudge
 * text to append to the block reason (and the caller marks the repo nudged),
 * so the confidential guard doesn't re-block the verbatim re-run.
 * Returns null for non-commit commands or non-repo targets.
 */
export function commitNudgeForBlockedCmd(
  cmd: string,
  targetDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): { root: string; text: string } | null {
  if (!isCommitPersist(cmd)) return null;
  const root = findRepoRoot(targetDir, exists);
  if (!root) return null;
  return { root, text: COMMIT_NUDGE(root, repoHasRemote(root)) };
}
