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
 * Source: ~/.pi/agent/prompts/tool-routing.md (everything ABOVE the
 * `<!-- tool-routing:end -->` marker; falls back to the historical
 * `## Documentation` boundary, then to the whole file). The canonical
 * file lives in pi's tree since 2026-08-15 and ships inside the pi
 * package, so package-only machines (no stow) get the rules too.
 * ~/.config/opencode/AGENTS.md is now a committed symlink to it for the
 * legacy opencode TUI and its output-rules.ts plugin, and doubles as
 * this extension's fallback path (mid-migration / hand-rolled installs).
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
import { join } from "path";
import { homedir } from "os";

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
 * Canonical source first, legacy back-compat path second. On stow
 * machines the legacy path is a symlink to the canonical file, so the
 * fallback only ever fires mid-migration or on hand-rolled installs.
 */
export function rulesPathCandidates(home: string): string[] {
  return [
    join(home, ".pi/agent/prompts/tool-routing.md"),
    join(home, ".config/opencode/AGENTS.md"),
  ];
}

export function resolveRulesPath(home: string = homedir()): string | null {
  for (const p of rulesPathCandidates(home)) {
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
  const path = resolveRulesPath();
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
