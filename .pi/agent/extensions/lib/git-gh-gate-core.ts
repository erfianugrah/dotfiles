/**
 * git-gh-gate-core - pure mutating-command classifier for git/gh. ZERO harness
 * imports (node stdlib + globals only). Source of truth for both the pi adapter
 * (../git-gh-gate.ts, block-only tool_call hook) and the Claude Code hook
 * (../../../.claude/hooks/git-gh-gate.ts, PreToolUse deny).
 *
 * Ports the opencode fork's permission gate (commit 560a2b983). Two behaviours
 * live here:
 *
 *   1. Bash classifier - detect any mutating git/gh subcommand in a (possibly
 *      compound) bash command line, so the harness can prompt/deny before it
 *      runs.
 *   2. .git-internals path check - detect write/edit targets inside a .git
 *      directory, so a model can't bypass the bash gate by editing .git files
 *      directly.
 *
 * The apply_patch-envelope inspection from the pi version is intentionally
 * DROPPED here: Claude Code has no apply_patch tool. The pi adapter keeps its
 * own envelope handling inline (it is harness-specific).
 */

// -- git/gh bash patterns that require confirmation --------------------------
//
// Patterns match individual command segments. Bash compound forms - chained
// with &&, ||, ;, |, or wrapped in $(...) / `...` - are split first (see
// splitCommandSegments) so that `cd /repo && git commit -m "..."` correctly
// triggers the `git commit` pattern. Each pattern is anchored with `^\s*`
// against its segment (NOT the whole input).
export const GIT_GH_PATTERNS: RegExp[] = [
  // git mutations
  /^\s*git\s+commit\b/i,
  /^\s*git\s+push\b/i,
  /^\s*git\s+reset\b/i,
  /^\s*git\s+rebase\b/i,
  /^\s*git\s+merge\b/i,
  /^\s*git\s+revert\b/i,
  /^\s*git\s+cherry-pick\b/i,
  /^\s*git\s+tag\b/i,
  /^\s*git\s+branch\s+.*-[dD]\b/i,
  /^\s*git\s+branch\s+.*--delete\b/i,
  /^\s*git\s+stash\s+(drop|clear|pop)\b/i,
  /^\s*git\s+checkout\b/i,
  /^\s*git\s+restore\b/i,
  /^\s*git\s+switch\b/i,
  /^\s*git\s+clean\b/i,
  /^\s*git\s+am\b/i,
  /^\s*git\s+apply\b/i,
  /^\s*git\s+rm\b/i,
  /^\s*git\s+mv\b/i,
  /^\s*git\s+filter-(branch|repo)\b/i,
  /^\s*git\s+update-ref\b/i,
  /^\s*git\s+config\b/i,
  /^\s*git\s+remote\s+(add|remove|set-url)\b/i,
  /^\s*git\s+submodule\b/i,
  /^\s*git\s+worktree\s+(add|remove)\b/i,

  // gh mutations - PR
  /^\s*gh\s+pr\s+(create|edit|merge|close|review|comment|ready|reopen)\b/i,
  // gh mutations - Issue
  /^\s*gh\s+issue\s+(create|edit|close|comment|reopen)\b/i,
  // gh mutations - Release
  /^\s*gh\s+release\s+(create|edit|delete|upload)\b/i,
  // gh mutations - Repo
  /^\s*gh\s+repo\s+(create|edit|delete|rename|archive|fork|clone)\b/i,
  // gh mutations - Gist
  /^\s*gh\s+gist\s+(create|edit|delete)\b/i,
  // gh - auth / api / secrets / variables / keys
  /^\s*gh\s+(api|auth|secret|variable|ssh-key|gpg-key)\b/i,
  // gh - workflow / run mutations
  /^\s*gh\s+workflow\s+(run|enable|disable)\b/i,
  /^\s*gh\s+run\s+(cancel|rerun|delete)\b/i,
];

/**
 * Split a bash command into best-effort segments at shell operators that
 * separate commands: && || ; |. Also unwraps trivial $(...) and `...`
 * command substitutions.
 *
 * Not a full shell parser - quoted strings containing `&&` etc. will be
 * mis-split, which is a false positive (we may prompt unnecessarily). Better
 * to over-prompt than under-prompt for mutating commands.
 *
 * Examples:
 *   "git commit -m 'x'"               -> ["git commit -m 'x'"]
 *   "cd /r && git commit"             -> ["cd /r", "git commit"]
 *   "git status; git commit"          -> ["git status", "git commit"]
 *   "echo $(git commit -m x)"         -> ["echo ", "git commit -m x"]
 *   "git rev-parse HEAD | tee f"      -> ["git rev-parse HEAD", "tee f"]
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  // Extract nested commands from $(...) and `...`, add each as its own segment
  let stripped = command;
  const subshellPatterns = [/\$\(([^)]*)\)/g, /`([^`]*)`/g];
  for (const pat of subshellPatterns) {
    for (const m of stripped.matchAll(pat)) {
      segments.push(m[1]);
    }
    stripped = stripped.replace(pat, " ");
  }
  // Split the outer command on shell command-chaining operators, INCLUDING
  // newline and single `&` (background) - otherwise a mutating git/gh command
  // on a line after the first, or backgrounded with `&`, escapes the ^-anchored
  // patterns entirely. Over-splitting (e.g. `2>&1`) is safe for a deny gate: it
  // only yields more segments to check, never fewer.
  segments.push(...stripped.split(/&&|\|\||;|\||&|\r?\n/));
  return segments;
}

// -- .git internal paths that should never be written/edited directly --------
export const GIT_INTERNAL_PATTERNS: RegExp[] = [/(^|\/)\.git(\/|$)/];

/**
 * Return the first GIT_GH_PATTERN that matches any segment of the command, or
 * undefined if the command is not a mutating git/gh command.
 */
export function matchesBashGate(command: string): RegExp | undefined {
  const segments = splitCommandSegments(command);
  for (const seg of segments) {
    const hit = GIT_GH_PATTERNS.find((p) => p.test(seg));
    if (hit) return hit;
  }
  return undefined;
}

/** True if `path` points inside a .git directory (or is one). */
export function matchesGitInternal(path: string): boolean {
  return GIT_INTERNAL_PATTERNS.some((p) => p.test(path));
}

// -- harness-agnostic orchestrator -------------------------------------------

export interface GateDecision {
  /** true when the command/path should be gated (prompt / deny). */
  gated: boolean;
  /** human-readable reason, present iff gated. */
  reason?: string;
  /** the matched pattern source (bash) or the offending path, for logging. */
  matched?: string;
}

/**
 * Classify a bash command. Pure - no I/O, no harness. The caller decides
 * whether "gated" means prompt (pi UI) or deny (CC PreToolUse).
 */
export function classifyBashCommand(command: string): GateDecision {
  if (typeof command !== "string" || command.length === 0) return { gated: false };
  const match = matchesBashGate(command);
  if (!match) return { gated: false };
  return {
    gated: true,
    matched: match.source,
    reason:
      `Mutating git/gh command requires confirmation. Matched pattern: ${match.source}. ` +
      `Re-run intentionally, or split read-only steps out. ` +
      `This gate protects against accidental history/remote mutation.`,
  };
}

/**
 * Classify a file-write target for .git-internals protection. Pure.
 */
export function classifyWritePath(filePath: string): GateDecision {
  if (typeof filePath !== "string" || filePath.length === 0) return { gated: false };
  if (!matchesGitInternal(filePath)) return { gated: false };
  return {
    gated: true,
    matched: filePath,
    reason:
      `Write to .git internals (${filePath}) requires confirmation. ` +
      `Editing .git files directly bypasses the git command gate. Use a git command instead.`,
  };
}
