/**
 * ai-tell-guard - block high-precision AI-prose tells from being written into
 * prose files and commit messages. Companion to ascii-punctuation-guard
 * (same wiring shape): the deterministic punctuation guard handles mojibake,
 * this one handles the sentence-shape tells that make prose read as generated.
 *
 * Detection + precision rationale: ./lib/ai-tell-core.ts. Fuzzy tells
 * (decorative bold, participle tails, triplets) are deliberately NOT guarded
 * here - they false-positive - they live in the erfi-voice skill's guidance.
 *
 * Scope:
 *   - write / edit / write_stream / apply_patch: payload content, PROSE
 *     paths only (code files never flagged).
 *   - bash: only write-ish commands (git commit, tee, heredoc, sd, ...) via
 *     ascii-core's WRITE_BASH - the command string is scanned so a commit
 *     message carrying a tell is blocked.
 *
 * Per-rule block cap: after 2 blocks of the same rule id in one session, that
 * rule stops blocking (a weaker model that cannot rephrase must not loop).
 *
 * Env:
 *   PI_AI_TELL_GUARD_OFF=1  disable entirely.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanTells, tellReason, isProsePath, isReadOnlySearchBash, TELL_RULES } from "./lib/ai-tell-core.ts";
import { WRITE_BASH } from "./lib/ascii-core.ts";

export { scanTells, tellReason, isProsePath, TELL_RULES } from "./lib/ai-tell-core.ts";

const MAX_BLOCKS_PER_RULE = 2;

export default function (pi: ExtensionAPI) {
  if (process.env.PI_AI_TELL_GUARD_OFF === "1") return;

  const blocksPerRule = new Map<string, number>();

  const check = (
    text: string,
    where: string,
    surface: "file" | "bash" = "file",
  ): { block: boolean; reason: string } | undefined => {
    const hits = scanTells(text, undefined, surface).filter((h) => {
      const n = blocksPerRule.get(h.rule.id) ?? 0;
      return n < MAX_BLOCKS_PER_RULE;
    });
    if (!hits.length) return undefined;
    for (const h of hits) {
      blocksPerRule.set(h.rule.id, (blocksPerRule.get(h.rule.id) ?? 0) + 1);
    }
    return { block: true, reason: tellReason(hits, where, surface) };
  };

  pi.on("tool_call", async (event) => {
    const tool = event.toolName;

    if (tool === "write" || tool === "edit" || tool === "write_stream") {
      const input = event.input as {
        path?: string;
        file_path?: string;
        content?: string;
        newText?: string;
        edits?: Array<{ newText?: string }>;
      };
      const target = input.path ?? input.file_path;
      if (typeof target !== "string" || !isProsePath(target)) return undefined;
      const editText = Array.isArray(input.edits)
        ? input.edits.map((e) => e?.newText ?? "").join("\n")
        : "";
      return check(`${input.content ?? ""}\n${input.newText ?? ""}\n${editText}`, `${tool} -> ${target}`);
    }

    if (tool === "apply_patch") {
      const patchText = (event.input as { patchText?: string }).patchText ?? "";
      // only added/updated body lines (leading '+'), and only prose targets
      const targets = [...patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => m[1]);
      if (!targets.some((t) => isProsePath(t))) return undefined;
      const added = patchText
        .split(/\r?\n/)
        .filter((l) => l.startsWith("+"))
        .join("\n");
      return check(added, `apply_patch -> ${targets.join(", ")}`);
    }

    if (tool === "bash") {
      const cmd = (event.input as { command?: string }).command;
      if (typeof cmd !== "string" || !WRITE_BASH.test(cmd) || isReadOnlySearchBash(cmd)) return undefined;
      // surface:"bash" - the commit message is INSIDE the quotes, so quoted-span
      // masking would blank the payload (see MASK_RE_BASH in the core).
      return check(cmd, "bash (writes/commits)", "bash");
    }

    return undefined;
  });
}
