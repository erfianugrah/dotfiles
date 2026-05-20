// helpers.ts — pure logic for the superpowers plugin.
//
// Kept outside plugins/ so opencode's plugin loader doesn't try to load this
// file as a plugin (it requires a single function export).

export const MARKER = "<!-- superpowers-methodology-injected -->"

// Verbs that signal "we're about to build / debug / refactor — methodology is useful".
// Tuned to avoid false positives on "write a summary", "add a comment", etc.
export const INTENT_REGEX =
  /\b(implement|build|create|design|architect|refactor|rewrite|restructure|debug|trace|investigate|TDD|red-green-refactor|fix\s+(?:a\s+|the\s+)?(?:bug|issue|error|crash|test)|add\s+(?:a\s+|the\s+)?(?:feature|function|test|component|endpoint|method|hook|module)|write\s+(?:a\s+|the\s+)?(?:tests?|specs?|unit\s+tests?|integration\s+tests?))\b/i

export const FORCE_TOKEN = /<superpowers>/i

const TOOL_MAPPING = `
Tool mapping for opencode:
- TodoWrite       → todowrite
- Task subagents  → opencode subagent (@mention)
- Skill tool      → opencode native skill tool
- File ops        → opencode native tools (read, write, edit, bash)
`.trim()

/**
 * Decide whether to inject methodology bootstrap based on user message text.
 * Returns "intent" if matched by INTENT_REGEX, "forced" if message contains
 * <superpowers>, or "skip" otherwise.
 */
export function decideInjection(text: string): "intent" | "forced" | "skip" {
  if (FORCE_TOKEN.test(text)) return "forced"
  if (INTENT_REGEX.test(text)) return "intent"
  return "skip"
}

/**
 * Build the bootstrap payload from raw using-superpowers SKILL.md content.
 * Strips YAML frontmatter, wraps in <superpowers-methodology> tags, appends
 * the opencode tool-mapping block.
 */
export function buildBootstrap(skillContent: string): string {
  const body = skillContent.replace(/^---\n[\s\S]*?\n---\n/, "")
  return [
    MARKER,
    "<superpowers-methodology>",
    "The using-superpowers skill is loaded inline below — do not re-load it via the skill tool.",
    "",
    body.trim(),
    "",
    TOOL_MAPPING,
    "</superpowers-methodology>",
  ].join("\n")
}

/**
 * Check whether a part array already contains the injection marker.
 * Idempotency guard — opencode reloads messages from DB each agent step,
 * so the hook fires repeatedly within a session.
 */
export function alreadyInjected(parts: { type: string; text?: string }[]): boolean {
  return parts.some((p) => p.type === "text" && (p.text ?? "").includes(MARKER))
}
