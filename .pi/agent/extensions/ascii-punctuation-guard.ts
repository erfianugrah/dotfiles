/**
 * ascii-punctuation-guard - keep mojibake-prone "smart" punctuation out of
 * files, commits, and heredocs the user copy-pastes elsewhere.
 *
 * Motivating incident (2026-06-30): the agent emitted em dashes into a GitHub
 * issue draft; pasted into a web composer they rendered as garbage (UTF-8
 * em-dash bytes mis-decoded as CP437/Latin-1). The user can't cleanly copy-paste.
 *
 * The harness `tool_call` hook can only block (no input rewrite), so this guard
 * BLOCKS a write/edit/apply_patch/commit whose payload contains a smart-
 * punctuation character and reports exactly which chars to swap for ASCII. The
 * agent then resubmits with the ASCII equivalents - one-shot, deterministic.
 * (The Claude Code port at ../../../.claude/hooks/ascii-guard.ts can instead
 * AUTO-REWRITE via PreToolUse updatedInput; both share ./lib/ascii-core.ts.)
 *
 * Scope:
 *   - write / edit / write_stream / apply_patch: payload content (all files).
 *   - bash: ONLY commands that write/commit (git commit, tee, >>, heredoc, ...),
 *     matching the confidential-write-guard's WRITE_BASH idiom - so ordinary
 *     bash that merely PRINTS unicode (e.g. echoing search results) is ignored.
 *
 * Chat text is NOT guardable (no assistant-output hook) - a companion memory
 * handles the agent's prose register.
 *
 * Env:
 *   PI_ASCII_GUARD_OFF=1       disable entirely.
 *   PI_ASCII_GUARD_SCOPE=prose limit file checks to prose (.md/.txt/docs/...);
 *                              code files then pass (em dash in a string literal
 *                              stays allowed). Default: all files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProsePath, reason, scan, WRITE_BASH } from "./lib/ascii-core.ts";

// Re-export the pure helpers so existing importers (tests) resolve them here.
export { scan, isProsePath, WRITE_BASH } from "./lib/ascii-core.ts";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASCII_GUARD_OFF === "1") return;
  const proseOnly = process.env.PI_ASCII_GUARD_SCOPE === "prose";

  pi.on("tool_call", async (event) => {
    const tool = event.toolName;

    if (tool === "write" || tool === "edit" || tool === "write_stream") {
      const input = event.input as {
        path?: string;
        file_path?: string;
        content?: string;
        newText?: string;
        edits?: Array<{ oldText?: string; newText?: string }>;
      };
      const target = input.path ?? input.file_path;
      if (typeof target !== "string") return undefined;
      if (proseOnly && !isProsePath(target)) return undefined;
      const editText = Array.isArray(input.edits)
        ? input.edits.map((e) => e?.newText ?? "").join("\n")
        : "";
      const found = scan(`${input.content ?? ""}\n${input.newText ?? ""}\n${editText}`);
      if (found.length) return { block: true, reason: reason(found, `${tool} -> ${target}`) };
      return undefined;
    }

    if (tool === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText ?? "";
      // only scan added/updated body lines (leading '+') so existing context isn't penalised
      const added = patchText
        .split(/\r?\n/)
        .filter((l) => l.startsWith("+"))
        .join("\n");
      const found = scan(added);
      if (found.length) return { block: true, reason: reason(found, "apply_patch") };
      return undefined;
    }

    if (tool === "bash") {
      const cmd = (event.input as { command?: string }).command;
      if (typeof cmd !== "string" || !WRITE_BASH.test(cmd)) return undefined;
      const found = scan(cmd);
      if (found.length) return { block: true, reason: reason(found, "bash (writes/commits)") };
      return undefined;
    }

    return undefined;
  });
}
