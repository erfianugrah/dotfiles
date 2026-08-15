/**
 * tool-routing - prepend tool-routing rules to the system prompt.
 *
 * Pi equivalent of opencode's `output-rules.ts` plugin
 * (~/dotfiles/.config/opencode/plugins/output-rules.ts), with one
 * improvement: pi's `before_agent_start` hook re-runs every user prompt,
 * so post-compaction re-injection is automatic - no separate hook needed.
 *
 * Why a plugin instead of just APPEND_SYSTEM.md:
 *
 *   - Position matters. APPEND_SYSTEM.md appends to the end of the system
 *     prompt (lowest attention). This plugin PREPENDS (highest attention).
 *   - Framing matters. APPEND_SYSTEM.md is plain markdown. This plugin
 *     wraps the content in a "CRITICAL MANDATORY INSTRUCTION" envelope
 *     that's visibly different from the base prompt.
 *   - Audit (2026-05-21, ~7.5k tool calls) showed pi reaches for
 *     websearch/bash/grep from habit and bypasses APPEND_SYSTEM rules.
 *     Prepending with hard framing is what opencode does and it works.
 *
 * Source: the tool-routing.md sitting next to THIS extension file
 * (../prompts/tool-routing.md, resolved from import.meta so it works for
 * the stow live path, the repo real path, and pi-package checkouts,
 * which pi loads in place - package machines never get a
 * ~/.pi/agent/prompts/ copy). Fallback: ~/.pi/agent/prompts/
 * tool-routing.md for hand-rolled installs. The legacy
 * ~/.config/opencode/AGENTS.md path was dropped when opencode was
 * retired (2026-08-15).
 *
 * Slicing: everything ABOVE the `<!-- tool-routing:end -->` marker;
 * falls back to the historical `## Documentation` boundary, then to the
 * whole file.
 *
 * Until 2026-08-09 this read ~/.pi/agent/AGENTS.md, a manual symlink to
 * the same file - but pi ALSO loaded that path natively as global
 * project instructions, so ~17.7KB rode every turn twice. The symlink
 * is deleted; this extension is now the only channel for the rules,
 * and the file's Documentation / General-computer-use sections moved to
 * APPEND_SYSTEM.md.
 *
 * Cached at module load - restart pi or `/reload` after editing
 * tool-routing.md.
 *
 * To disable for a single session: rename this file to .ts.disabled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

// Directory this file was loaded from. import.meta.dirname can be
// undefined under some loaders - fall back to fileURLToPath. A failure
// here must not break module load (it would take down ALL extensions),
// so worst case is undefined and the self-relative candidate is skipped.
const SELF_DIR: string | undefined =
  typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : (() => {
        try {
          return dirname(fileURLToPath(import.meta.url));
        } catch {
          return undefined;
        }
      })();

const END_MARKER = "<!-- tool-routing:end";
const LEGACY_DOC_MARKER = "\n## Documentation";
// ASCII hyphen (ascii-punctuation-guard). The idempotency check below
// matches the prefix only, so sessions carrying the pre-2026-08-15
// em-dash header are still detected.
const HEADER =
  "CRITICAL MANDATORY INSTRUCTION - OVERRIDE DEFAULT TOOL INTUITION:";
const HEADER_PREFIX = "CRITICAL MANDATORY INSTRUCTION";
const FOOTER =
  "These tool-routing rules are NON-NEGOTIABLE. Apply on EVERY tool selection decision. They override the agent's default instinct to reach for websearch / bash / grep / edit.";
const SEPARATOR = "\n\n---\n\n";

/**
 * Self-relative path first (works for stow live links, the repo real
 * path, and pi-package checkouts loaded in place), then the stow live
 * home path for hand-rolled installs.
 */
export function rulesPathCandidates(
  home: string,
  selfDir?: string,
): string[] {
  const out: string[] = [];
  if (selfDir) out.push(join(selfDir, "..", "prompts", "tool-routing.md"));
  out.push(join(home, ".pi/agent/prompts/tool-routing.md"));
  return out;
}

export function resolveRulesPath(
  home: string,
  selfDir?: string,
): string | null {
  for (const p of rulesPathCandidates(home, selfDir)) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Slice the rules payload out of the source file. Pure. */
export function sliceRules(content: string): string | null {
  let end = content.indexOf(END_MARKER);
  if (end < 0) end = content.indexOf(LEGACY_DOC_MARKER);
  const slice = (end > 0 ? content.slice(0, end) : content).trim();
  return slice || null;
}

let cachedRules: string | null | undefined = undefined;

function loadRules(): string | null {
  if (cachedRules !== undefined) return cachedRules;
  const path = resolveRulesPath(homedir(), SELF_DIR);
  if (!path) {
    cachedRules = null;
    return null;
  }
  try {
    cachedRules = sliceRules(readFileSync(path, "utf-8"));
  } catch {
    cachedRules = null;
  }
  return cachedRules;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const rules = loadRules();
    if (!rules) return undefined;

    // Idempotency - if a previous handler already injected our header,
    // don't stack it. Prefix match covers both the current ASCII header
    // and the pre-2026-08-15 em-dash variant.
    if (event.systemPrompt.includes(HEADER_PREFIX)) return undefined;

    return {
      systemPrompt:
        `${HEADER}\n\n${rules}\n\n${FOOTER}${SEPARATOR}${event.systemPrompt}`,
    };
  });
}
