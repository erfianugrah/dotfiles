/**
 * tool-routing — prepend tool-routing rules to the system prompt.
 *
 * Pi equivalent of opencode's `output-rules.ts` plugin
 * (~/dotfiles/.config/opencode/plugins/output-rules.ts), with one
 * improvement: pi's `before_agent_start` hook re-runs every user prompt,
 * so post-compaction re-injection is automatic — no separate hook needed.
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
 * Source: ~/.pi/agent/AGENTS.md (everything BEFORE the `## Documentation`
 * heading). Same convention as opencode's `output-rules.ts` plugin
 * (.config/opencode/plugins/output-rules.ts) so both agents read from a
 * single source of truth.
 *
 * Cached at module load — restart pi or `/reload` after editing AGENTS.md.
 *
 * To disable for a single session: rename this file to .ts.disabled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const AGENTS_PATH = join(homedir(), ".pi/agent/AGENTS.md");
const DOC_MARKER = "\n## Documentation";
const HEADER =
  "CRITICAL MANDATORY INSTRUCTION — OVERRIDE DEFAULT TOOL INTUITION:";
const FOOTER =
  "These tool-routing rules are NON-NEGOTIABLE. Apply on EVERY tool selection decision. They override the agent's default instinct to reach for websearch / bash / grep / edit.";
const SEPARATOR = "\n\n---\n\n";

let cachedRules: string | null | undefined = undefined;

function loadRules(): string | null {
  if (cachedRules !== undefined) return cachedRules;
  if (!existsSync(AGENTS_PATH)) {
    cachedRules = null;
    return null;
  }
  try {
    const content = readFileSync(AGENTS_PATH, "utf-8");
    const docIdx = content.indexOf(DOC_MARKER);
    const slice = docIdx > 0 ? content.slice(0, docIdx).trim() : "";
    cachedRules = slice || null;
  } catch {
    cachedRules = null;
  }
  return cachedRules;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const rules = loadRules();
    if (!rules) return undefined;

    // Idempotency — if a previous handler already injected our header,
    // don't stack it. (Shouldn't happen in normal flow, but defensive.)
    if (event.systemPrompt.includes(HEADER)) return undefined;

    return {
      systemPrompt:
        `${HEADER}\n\n${rules}\n\n${FOOTER}${SEPARATOR}${event.systemPrompt}`,
    };
  });
}
