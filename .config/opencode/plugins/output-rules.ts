import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"

// Read output rules from AGENTS.md (lines before "## Documentation")
const AGENTS_PATH = resolve(dirname(import.meta.dirname), "AGENTS.md")
function loadOutputRules(): string {
  try {
    const content = readFileSync(AGENTS_PATH, "utf-8")
    const docSection = content.indexOf("\n## Documentation")
    return docSection > 0 ? content.slice(0, docSection).trim() : content.trim()
  } catch {
    return ""
  }
}

const OUTPUT_RULES = loadOutputRules()

export const OutputRulesPlugin: Plugin = async () => {
  if (!OUTPUT_RULES) return {}

  return {
    // Prepend output rules to system prompt — ensures primacy over base prompt
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.unshift(`CRITICAL MANDATORY INSTRUCTION — OVERRIDE ALL OTHER STYLE GUIDANCE:\n\n${OUTPUT_RULES}\n\nThis output style is NON-NEGOTIABLE. Apply to EVERY response. No exceptions unless Auto-Clarity triggers.`)
    },

    // Preserve output rules across compaction so they aren't lost
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(`CRITICAL — maintain this communication style after compaction:\n\n${OUTPUT_RULES}`)
    },
  }
}
