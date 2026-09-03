/**
 * git-gh-gate — confirm before any mutating git/gh command + protect .git
 * internals from direct writes. Ports the opencode fork's permission gate
 * (commit 560a2b983) to Pi.
 *
 * The pure classifier (git/gh bash patterns, segment splitting, .git-internals
 * path check) lives in ./lib/git-gh-gate-core.ts and is shared with the Claude
 * Code PreToolUse hook (../../../.claude/hooks/git-gh-gate.ts). This adapter
 * keeps the pi-specific pieces: the apply_patch-envelope inspection (CC has no
 * apply_patch tool) and the ctx.ui.select() prompt / ANSI styling.
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
import { matchesBashGate, matchesGitInternal } from "./lib/git-gh-gate-core.ts";

// Re-export the pure helpers so any importer resolves them here.
export {
  isReadOnlyGhApi,
  matchesBashGate,
  matchesGitInternal,
  splitCommandSegments,
  classifyBashCommand,
  classifyWritePath,
  GIT_GH_PATTERNS,
  GIT_INTERNAL_PATTERNS,
} from "./lib/git-gh-gate-core.ts";

// ── tools that write/edit files we want to gate ────────────────────────────
// Pi's built-in mutating tools: write, edit. apply_patch is registered locally
// (see extensions/apply-patch.ts) and writes via fs.writeFile, so we have to
// inspect its envelope separately (see below).
const WRITE_TOOLS = new Set(["write", "edit"]);

// Extract target paths from an apply_patch envelope so we can run the same
// .git-internals check we'd run on a write/edit.
function extractPatchPaths(patchText: string): string[] {
  if (typeof patchText !== "string") return [];
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move(?: to)?) File: (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
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

// Truncate a command for display in the gate dialog. Multi-line commit
// messages (`git commit -m "\nlong\nbody\n"`) or 20+ line HEREDOCs make
// ctx.ui.select() balloon the modal up to maxHeight: 80%. In long sessions
// that triggers a repaint cascade that looks like "crazy scrolling until you
// press enter". Keep the dialog body to one logical line: first line of the
// command plus a hint about hidden content.
const DIALOG_MAX_CHARS = 240;
function truncateForDialog(command: string): string {
  const trimmed = command.replace(/\s+$/g, "");
  const lines = trimmed.split("\n");
  let head = lines[0] ?? "";
  if (head.length > DIALOG_MAX_CHARS) {
    head = `${head.slice(0, DIALOG_MAX_CHARS)}…`;
  }
  const extraLines = lines.length - 1;
  if (extraLines > 0) {
    head += `\n  … (+${extraLines} more line${extraLines === 1 ? "" : "s"} hidden)`;
  }
  return head;
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

      const display = truncateForDialog(command);
      const choice = await ctx.ui.select(
        `⚠️  Mutating git/gh command:\n\n  ${styleBody(display)}\n\nAllow?`,
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

    // apply_patch writes via fs.writeFile, bypassing the write/edit hook.
    // Inspect each target path in the envelope for .git internals.
    if (event.toolName === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText;
      const paths = extractPatchPaths(patchText ?? "");
      const offending = paths.find((p) => matchesGitInternal(p));
      if (!offending) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: `apply_patch → .git internals blocked (no UI): ${offending}` };
      }

      const choice = await ctx.ui.select(
        `⚠️  apply_patch targets .git internals:\n\n  ${styleBody(offending)}\n\nAllow?`,
        ["Yes", "No"],
      );
      if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
      return undefined;
    }

    return undefined;
  });
}
