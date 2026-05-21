/**
 * git-gh-gate — confirm before any mutating git/gh command + protect .git
 * internals from direct writes. Ports the opencode fork's permission gate
 * (commit 560a2b983) to Pi.
 *
 * Two runtime layers of protection (this file) + one config layer (APPEND_SYSTEM.md):
 *
 * 1. Bash patterns — every mutating git subcommand (commit, push, reset,
 *    rebase, merge, revert, tag, checkout, restore, switch, clean, am,
 *    apply, rm, mv, filter-*, update-ref, config, remote add/remove/set-url,
 *    submodule, worktree) and every gh mutation (pr, issue, release, repo,
 *    gist, api, auth, secret, variable, workflow, run) prompts before run.
 *    Read-only commands stay unblocked.
 *
 * 2. .git path protection — write/edit tools on .git internals (COMMIT_EDITMSG,
 *    hooks, refs, config) prompt. Prevents bypassing the bash gate by editing
 *    .git files directly.
 *
 * The third layer — banning Co-Authored-By trailers, "Generated with..."
 * footers, and AI-attribution signatures in commit messages and PR bodies —
 * lives in ~/.pi/agent/APPEND_SYSTEM.md (Pi reads it at startup and appends
 * to the system prompt). See that file for the prompt content.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── git/gh bash patterns that require confirmation ─────────────────────────
//
// Patterns match individual command segments. Bash compound forms — chained
// with &&, ||, ;, |, or wrapped in $(...) / `...` — are split first so that
// `cd /repo && git commit -m "..."` correctly triggers the `git commit`
// pattern. Each pattern is anchored with `^\s*` against its segment (NOT the
// whole input).
const GIT_GH_PATTERNS: RegExp[] = [
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

  // gh mutations — PR
  /^\s*gh\s+pr\s+(create|edit|merge|close|review|comment|ready|reopen)\b/i,
  // gh mutations — Issue
  /^\s*gh\s+issue\s+(create|edit|close|comment|reopen)\b/i,
  // gh mutations — Release
  /^\s*gh\s+release\s+(create|edit|delete|upload)\b/i,
  // gh mutations — Repo
  /^\s*gh\s+repo\s+(create|edit|delete|rename|archive|fork|clone)\b/i,
  // gh mutations — Gist
  /^\s*gh\s+gist\s+(create|edit|delete)\b/i,
  // gh — auth / api / secrets / variables / keys
  /^\s*gh\s+(api|auth|secret|variable|ssh-key|gpg-key)\b/i,
  // gh — workflow / run mutations
  /^\s*gh\s+workflow\s+(run|enable|disable)\b/i,
  /^\s*gh\s+run\s+(cancel|rerun|delete)\b/i,
];

/**
 * Split a bash command into best-effort segments at shell operators that
 * separate commands: && || ; |. Also unwraps trivial $(...) and `...`
 * command substitutions.
 *
 * Not a full shell parser — quoted strings containing `&&` etc. will be
 * mis-split, which is a false positive (we may prompt unnecessarily). Better
 * to over-prompt than under-prompt for mutating commands.
 *
 * Examples:
 *   "git commit -m 'x'"               → ["git commit -m 'x'"]
 *   "cd /r && git commit"             → ["cd /r", "git commit"]
 *   "git status; git commit"          → ["git status", "git commit"]
 *   "echo $(git commit -m x)"         → ["echo ", "git commit -m x"]
 *   "git rev-parse HEAD | tee f"      → ["git rev-parse HEAD", "tee f"]
 */
function splitCommandSegments(command: string): string[] {
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
  // Split the outer command on shell command-chaining operators
  segments.push(...stripped.split(/&&|\|\||;|\|/));
  return segments;
}

// ── .git internal paths that should never be written/edited directly ───────
const GIT_INTERNAL_PATTERNS: RegExp[] = [/(^|\/)\.git(\/|$)/];

// ── tools that write/edit files we want to gate ────────────────────────────
// Pi's built-in mutating tools: write, edit. (No apply_patch in Pi core.)
// Custom tools that mutate files should also be added here as you discover them.
const WRITE_TOOLS = new Set(["write", "edit"]);

function matchesBashGate(command: string): RegExp | undefined {
  const segments = splitCommandSegments(command);
  for (const seg of segments) {
    const hit = GIT_GH_PATTERNS.find((p) => p.test(seg));
    if (hit) return hit;
  }
  return undefined;
}

function matchesGitInternal(path: string): boolean {
  return GIT_INTERNAL_PATTERNS.some((p) => p.test(path));
}

// ANSI helpers: Pi wraps the whole select() title in `accent`, which renders
// multi-line bodies (command text, paths) in saturated teal. We re-style the
// body inline so only the title/`Allow?` reads as accent.
//
// 38;2;R;G;B = truecolor fg. 22 = clear bold (Pi applies bold to the title).
// Reapplying \x1b[1m re-enables bold for the trailing 'Allow?' line.
const BODY_FG = "\x1b[22m\x1b[38;2;240;240;240m"; // textBright unbold
const RESUME = "\x1b[1m\x1b[39m"; // restore bold + inherit fg from outer accent wrapper

function styleBody(body: string): string {
  return `${BODY_FG}${body}${RESUME}`;
}

export default function (pi: ExtensionAPI) {
  // Block/confirm bash + write/edit tool calls
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (typeof command !== "string") return undefined;
      const match = matchesBashGate(command);
      if (!match) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: `Mutating git/gh command blocked (no UI). Matched: ${match.source}` };
      }

      const choice = await ctx.ui.select(
        `⚠️  Mutating git/gh command:\n\n  ${styleBody(command)}\n\nAllow?`,
        ["Yes", "No"],
      );
      if (choice !== "Yes") {
        return { block: true, reason: "Blocked by user" };
      }
      return undefined;
    }

    if (WRITE_TOOLS.has(event.toolName)) {
      // Pi's write/edit tools use `path`; fall back to `file_path` for compat
      // with extensions/skills that emit opencode-style args.
      const input = event.input as { path?: string; file_path?: string };
      const filePath = input.path ?? input.file_path;
      if (typeof filePath !== "string") return undefined;
      if (!matchesGitInternal(filePath)) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: `Write to .git internals blocked (no UI): ${filePath}` };
      }

      const choice = await ctx.ui.select(
        `⚠️  Writing to .git internals:\n\n  ${styleBody(filePath)}\n\nAllow?`,
        ["Yes", "No"],
      );
      if (choice !== "Yes") {
        return { block: true, reason: "Blocked by user" };
      }
      return undefined;
    }

    return undefined;
  });
}
