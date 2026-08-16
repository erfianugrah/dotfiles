/**
 * dangerous-cmd-guard - block or confirm destructive shell commands BEFORE
 * they run. Born from the 2026-08 incident where an agent typo'd a path and
 * "cleaned up" with `rm -rf ~/infra/ai` in the same compound command as its
 * verification steps, deleting three real repo working trees.
 *
 * This is the pi adapter: it owns the pi.on() wiring and the ctx.ui.select()
 * prompt. The pure classifier (tokenizer, rm/find/xargs parsing, path
 * normalization, tier rules) lives in ./lib/dangerous-cmd-guard-core.ts and
 * is shared with the Claude Code PreToolUse hook
 * (../../../.claude/hooks/dangerous-cmd-guard.ts).
 *
 * Two tiers (see the core for the full rule table):
 *
 *   critical - BLOCKED unconditionally, even interactively. rm -rf on / ~ or
 *     the cwd itself, --no-preserve-root, cwd-wipe globs, dd/mkfs/wipefs on
 *     block devices, fork bombs, chmod/chown -R on / or ~. There is no
 *     legitimate agent use; the human can type it in their own shell.
 *
 *   confirm  - PROMPTS via ctx.ui.select (blocks headless). Recursive rm on
 *     any path outside the scratch allowlist (/tmp, build artifacts),
 *     unfiltered find -delete, xargs rm -r, power-cycle, partition tools.
 *
 * Covers the `bash` tool AND `bg_bash` (the bg-tasks extension runs arbitrary
 * bash in tmux - the same typo in a background task is the same data loss).
 *
 * Kill switch: DANGEROUS_CMD_GUARD_OFF=1.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { classifyBashCommand, type GuardEnv } from "./lib/dangerous-cmd-guard-core.ts";

// Re-export the pure helpers so tests and sibling tooling resolve them here.
export {
  classifyBashCommand,
  isScratchPath,
  normalizePath,
  tokenize,
  unwrapPrefixes,
} from "./lib/dangerous-cmd-guard-core.ts";

// Tools whose input carries a raw shell command. bg_bash is registered by
// bg-tasks.ts and runs the command in a detached tmux session - identical
// blast radius to bash.
const COMMAND_TOOLS: ReadonlyArray<{ tool: string; field: string }> = [
  { tool: "bash", field: "command" },
  { tool: "bg_bash", field: "command" },
];

// ANSI helpers: same reasoning as git-gh-gate - re-style the select() body so
// only the title reads as accent.
const BODY_FG = "\x1b[22m\x1b[38;2;240;240;240m"; // textBright unbold
const RESUME = "\x1b[1m\x1b[39m"; // restore bold + inherit fg

function styleBody(body: string): string {
  return `${BODY_FG}${body}${RESUME}`;
}

const DIALOG_MAX_CHARS = 240;
function truncateForDialog(command: string): string {
  const trimmed = command.replace(/\s+$/g, "");
  const lines = trimmed.split("\n");
  let head = lines[0] ?? "";
  if (head.length > DIALOG_MAX_CHARS) {
    head = `${head.slice(0, DIALOG_MAX_CHARS)}...`;
  }
  const extraLines = lines.length - 1;
  if (extraLines > 0) {
    head += `\n  ... (+${extraLines} more line${extraLines === 1 ? "" : "s"} hidden)`;
  }
  return head;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.DANGEROUS_CMD_GUARD_OFF === "1") return undefined;

    const spec = COMMAND_TOOLS.find((s) => s.tool === event.toolName);
    if (!spec) return undefined;
    const command = (event.input as Record<string, unknown>)[spec.field];
    if (typeof command !== "string") return undefined;

    const env: GuardEnv = { cwd: ctx.cwd ?? process.cwd(), home: homedir() };
    const decision = classifyBashCommand(command, env);
    if (!decision.dangerous) return undefined;

    if (decision.tier === "critical") {
      return {
        block: true,
        reason: `dangerous-cmd-guard[${decision.rule}]: ${decision.reason}`,
      };
    }

    // confirm tier
    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `dangerous-cmd-guard[${decision.rule}]: ${decision.reason} ` +
          `(Blocked headless - re-run interactively to confirm, or set DANGEROUS_CMD_GUARD_OFF=1.)`,
      };
    }

    const display = truncateForDialog(command);
    const choice = await ctx.ui.select(
      `⚠️  Destructive command [${decision.rule}]:\n\n  ${styleBody(display)}\n\n${styleBody(decision.reason ?? "")}\n\nAllow?`,
      ["Yes", "No"],
    );
    if (choice !== "Yes") {
      return { block: true, reason: `dangerous-cmd-guard[${decision.rule}]: blocked by user` };
    }
    return undefined;
  });
}
