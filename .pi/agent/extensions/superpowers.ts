/**
 * superpowers — conditional injection of obra/superpowers methodology.
 *
 * **Disabled by default as of 2026-05-25 audit.** The methodology gates
 * (using-superpowers' "1% chance → MUST invoke" enforcer, brainstorming's
 * HARD-GATE on every creative task, the brainstorm → plan → execute closed
 * loop that explicitly forbids handoff to concrete-tech skills) fight
 * the user's stated workflow: concise system prompt + concrete-tech skills
 * (frontend-stack, infrastructure-stack, software-architecture,
 * design-utilitarian, etc.) orchestrated by a thin scaffold-new-project
 * skill. The 8 worst-offender SKILL.md files have been renamed to
 * .disabled; the survivors (writing-plans, subagent-driven-development,
 * systematic-debugging, writing-skills, requesting-code-review,
 * verification-before-completion) had their auto-fire descriptions
 * tightened so they only trigger on explicit user request.
 *
 * Re-enable per-session by exporting SUPERPOWERS_ON=1.
 *
 * Two-tier system (only relevant when SUPERPOWERS_ON=1):
 *
 *   FULL     — inject the using-superpowers bootstrap + tool mapping
 *              (~1.4k tokens with the slim variant). Pi prompt-cache
 *              amortizes the cost across the session.
 *
 *   MINIMAL  — inject only the 4 essential skill names with one-line
 *              triggers (~250 tokens). Use when you want the gate-on-
 *              implementation discipline but not the full skill catalog.
 *              Enable with SUPERPOWERS_MINIMAL=1.
 *
 * The decision tree per first user message:
 *
 *   1. SUPERPOWERS_OFF=1 set?                  → skip (entire extension inert)
 *   2. <superpowers> token in text?            → FORCED inject (full)
 *   3. Hedge phrase ("just", "quick", "one-   → skip (user signalled small change)
 *      line", "tweak", "trivial")?
 *   4. Question-only prompt ("how", "why",     → skip (Q&A, not implementation)
 *      "what", "explain", "show me", "tell
 *      me", "look at") with no implementation
 *      verb?
 *   5. Detailed spec provided (>=500 chars or  → FULL but with SPEC_NOTE
 *      contains numbered list / bullets / a    (tells Claude to skip the
 *      "spec:" / "requirements:" marker)?      brainstorming-questions loop
 *                                              and present design directly)
 *   6. Intent verb (implement/build/refactor   → FULL/MINIMAL based on env
 *      /add-X/fix-the-bug/etc) + object?
 *   7. Otherwise                               → skip
 *
 * Controls (env):
 *   SUPERPOWERS_ON=1              re-enable the extension (default: off)
 *   SUPERPOWERS_OFF=1             legacy explicit-disable (no-op while default is off)
 *   SUPERPOWERS_MINIMAL=1         inject the 250-token essentials only (when ON=1)
 *   SUPERPOWERS_BOOTSTRAP=<path>  override using-superpowers SKILL.md path
 *   SUPERPOWERS_INTENT=<regex>    override the intent regex (advanced)
 *
 * Verified by the unit tests in ~/.pi/agent/tests/extensions.test.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── intent classification (pure, exported for tests) ──────────────────────

// Implementation intent: verb + object pattern. Looser than the old all-on-
// one mega-regex; instead we check verbs and required-object separately so
// "implement what?" alone (no object) doesn't fire.
const INTENT_VERBS =
  /\b(implement|build|create|design|architect|refactor|rewrite|restructure|migrate|port|extract|split|merge|add|remove|delete|rename|swap|replace|tweak|adjust|update|upgrade|bump|fix|debug|trace|investigate|profile|optimize|benchmark|harden|secure)\b/i;

// Specific implementation phrases that need no further object check
// (the phrase itself implies the object).
const IMPLEMENTATION_PHRASES = [
  /\bTDD\b/i,
  /\bred-green-refactor\b/i,
  /\bfix\s+(?:a\s+|the\s+)?(?:bug|issue|error|crash|test|leak|race|panic|regression|failure)\b/i,
  /\b(?:add|create|write)\s+(?:a\s+|the\s+|some\s+)?(?:tests?|specs?|unit\s+tests?|integration\s+tests?|fixture)\b/i,
  /\b(?:add|create|build)\s+(?:a\s+|the\s+|new\s+|another\s+)?(?:feature|function|component|endpoint|method|hook|module|service|migration|table|index|trigger|skill|extension|tool)\b/i,
  /\b(?:refactor|rewrite|restructure|migrate|port|optimize|harden)\s+/i,
];

// Hedges that signal "small change, don't load methodology"
const HEDGE_REGEX =
  /\b(?:just|quick(?:ly)?|one[-\s]?line(?:r)?|trivial|tiny|simple\s+(?:fix|change|tweak)|micro|nit|drive[-\s]?by)\b/i;

// Question-only patterns (no implementation verb) — if the message LEADS
// with these and nothing else triggers, skip injection
const QUESTION_LEAD_REGEX =
  /^[\s>]*(?:how(?:\s+do|\s+can|\s+would)?\s|why\s|what\s|where\s|when\s|which\s|who\s|can\s+(?:i|we|you)\s|could\s+(?:i|we|you)\s|should\s+(?:i|we|you)\s|is\s+(?:it|this|that)\s|are\s+(?:there|these|those)\s|do\s+(?:i|we|you)\s|does\s+(?:it|this|that)\s|explain\s|show\s+me\s|tell\s+me\s|look\s+at\s|review\s|check\s|verify\s|find\s+out\s)/i;

const FORCE_TOKEN_REGEX = /<superpowers>/i;

// Spec-detection heuristics: a message is a detailed spec if it's long AND
// has structural markers (bullets, numbered list, code blocks, or explicit
// "spec:" / "requirements:" labels).
const SPEC_MARKER_REGEX = /(?:^|\n)\s*(?:[-*+]|\d+[.)])\s+|```|\bspec(?:ification)?:|\brequirements?:/i;
const SPEC_MIN_CHARS = 500;

export type InjectionDecision = "skip" | "intent" | "intent-spec" | "forced" | "forced-spec";

export function decideInjection(text: string): InjectionDecision {
  if (FORCE_TOKEN_REGEX.test(text)) {
    return looksLikeSpec(text) ? "forced-spec" : "forced";
  }
  // Hedges win over intent — "just fix this one typo" should NOT trigger
  if (HEDGE_REGEX.test(text)) return "skip";

  const hasIntent = matchesIntent(text);
  if (!hasIntent) {
    // Pure question without intent verb → skip
    if (QUESTION_LEAD_REGEX.test(text)) return "skip";
    return "skip";
  }
  // Intent verb present. If the lead is "what should I implement" (question
  // + intent), it's still a question — skip unless the intent has an object.
  if (QUESTION_LEAD_REGEX.test(text) && !matchesImplementationPhrase(text)) {
    return "skip";
  }
  return looksLikeSpec(text) ? "intent-spec" : "intent";
}

export function matchesIntent(text: string): boolean {
  if (matchesImplementationPhrase(text)) return true;
  // Bare verb match requires it to be followed by some object word within
  // ~12 chars to avoid "implement?" / "implement what" Q&A.
  const m = text.match(INTENT_VERBS);
  if (!m) return false;
  const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
  // Object follows = at least one non-question word in the window
  return /\b[a-z_][a-z0-9_\-/.]{2,}\b/i.test(after) && !/^\s*\?/.test(after);
}

function matchesImplementationPhrase(text: string): boolean {
  return IMPLEMENTATION_PHRASES.some((re) => re.test(text));
}

export function looksLikeSpec(text: string): boolean {
  if (text.length < SPEC_MIN_CHARS) return false;
  return SPEC_MARKER_REGEX.test(text);
}

// ── pi-specific tool mapping (replaces the opencode-flavoured stuff) ──────

const TOOL_MAPPING = `
Pi tool mapping (the superpowers SKILL.md below was written for Claude Code):
- TodoWrite          → pi's todowrite tool (file-backed at ~/.pi/agent/todos/<session>.json)
- Task subagents     → pi's task tool (subagent_type=explore/general) OR bg_task for >5min async
- Long-running bash  → bg_bash (pi's bash has a ~30s timeout)
- Skill tool         → /skill:<name> or read the SKILL.md inline
- Verification gate  → use go_test / hurl_test / bench / osv_scan / secret_scan as appropriate
`.trim();

// ── full vs minimal bootstrap content ─────────────────────────────────────

const MARKER = "<!-- superpowers-methodology-injected -->";

const SPEC_NOTE = `
NOTE: The user's first message already contains a detailed spec (long form +
structural markers). Skip the brainstorming question-by-question loop.
Instead: read the spec, propose a one-paragraph design that names the bounded
context + the major files to touch + the test plan, and WAIT for ack before
writing code. The HARD-GATE still applies — no implementation before ack.
`.trim();

// MINIMAL bootstrap — only the 4 essential skill triggers, ~250 tokens.
// Use when SUPERPOWERS_MINIMAL=1 is set.
function buildMinimalBootstrap(decision: InjectionDecision): string {
  const lines = [
    MARKER,
    "<superpowers-essentials>",
    "Four-skill methodology gate. Load the named SKILL.md from",
    "~/.config/opencode/skills/superpowers/<name>/SKILL.md when its trigger fires:",
    "",
    "1. brainstorming \u2014 BEFORE any implementation. HARD-GATE: do not write",
    "   code until you present a design (one paragraph for small changes) and",
    "   the user acks. Applies even to 'simple' changes.",
    "",
    "2. writing-plans \u2014 multi-step task: write the plan to",
    "   docs/plans/YYYY-MM-DD-<feature>.md before touching code. Per-file",
    "   task list with explicit TDD checkpoints.",
    "",
    "3. verification-before-completion \u2014 NEVER claim 'done' / 'fixed' /",
    "   'passing' without running the verification command and seeing the",
    "   green output yourself. Evidence before assertion.",
    "",
    "4. systematic-debugging \u2014 when a bug hits: reproduce deterministically",
    "   first, ONE hypothesis at a time, no shotgun fixes.",
    "",
  ];
  if (decision === "intent-spec" || decision === "forced-spec") {
    lines.push("", SPEC_NOTE, "");
  }
  lines.push(TOOL_MAPPING, "</superpowers-essentials>");
  return lines.join("\n");
}

// FULL bootstrap — wraps the upstream using-superpowers SKILL.md body
// with our pi-flavoured framing.
function buildFullBootstrap(skillContent: string, decision: InjectionDecision): string {
  // Strip the YAML frontmatter (---\n...\n---\n) — pi doesn't use it
  const body = skillContent.replace(/^---\n[\s\S]*?\n---\n/, "");
  // Strip blank-line clusters >2 to compress
  const compact = body.replace(/\n{3,}/g, "\n\n").trim();
  const lines = [
    MARKER,
    "<superpowers-methodology>",
    "The using-superpowers skill is loaded inline below \u2014 do not re-load it via the skill tool.",
    "",
    compact,
  ];
  if (decision === "intent-spec" || decision === "forced-spec") {
    lines.push("", SPEC_NOTE);
  }
  lines.push("", TOOL_MAPPING, "</superpowers-methodology>");
  return lines.join("\n");
}

// ── content loaders (cached, one disk read per process) ───────────────────

function bootstrapPath(): string {
  const env = process.env.SUPERPOWERS_BOOTSTRAP;
  if (env) return env;
  return join(homedir(), ".config/opencode/skills/superpowers/using-superpowers/SKILL.md");
}

let cachedSkillContent: string | null | undefined = undefined;
function loadSkillContent(): string | null {
  if (cachedSkillContent !== undefined) return cachedSkillContent;
  const path = bootstrapPath();
  if (!existsSync(path)) {
    cachedSkillContent = null;
    return null;
  }
  try {
    cachedSkillContent = readFileSync(path, "utf-8");
  } catch {
    cachedSkillContent = null;
  }
  return cachedSkillContent;
}

// ── message-array helpers ─────────────────────────────────────────────────

type PiMessage = { role: string; content: unknown };

function firstUserText(messages: PiMessage[]): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;
  const c = firstUser.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return undefined;
}

// ── extension entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Disabled by default as of 2026-05-25 audit — see header comment.
  // Opt back in with SUPERPOWERS_ON=1.
  if (process.env.SUPERPOWERS_ON !== "1") return;
  if (process.env.SUPERPOWERS_OFF === "1") return;

  // Optional regex override from env
  let intentOverride: RegExp | null = null;
  const envIntent = process.env.SUPERPOWERS_INTENT;
  if (envIntent) {
    try {
      intentOverride = new RegExp(envIntent, "i");
    } catch {
      // ignore malformed override
    }
  }

  pi.on("context", async (event, _ctx) => {
    const messages = (event as { messages: PiMessage[] }).messages;
    if (!messages?.length) return undefined;

    const text = firstUserText(messages) ?? "";
    if (!text) return undefined;

    let decision: InjectionDecision = decideInjection(text);
    // Apply env-override regex if provided (forces injection when matched)
    if (intentOverride && decision === "skip" && intentOverride.test(text)) {
      decision = looksLikeSpec(text) ? "intent-spec" : "intent";
    }
    if (decision === "skip") return undefined;

    // Idempotency — if any prior system message contains the marker, skip.
    const alreadyInjected = messages.some((m) => {
      if (m.role !== "system") return false;
      const c = m.content;
      return typeof c === "string" && c.includes(MARKER);
    });
    if (alreadyInjected) return undefined;

    // MINIMAL mode bypasses the disk read entirely
    let bootstrap: string;
    if (process.env.SUPERPOWERS_MINIMAL === "1") {
      bootstrap = buildMinimalBootstrap(decision);
    } else {
      const skillContent = loadSkillContent();
      if (!skillContent) return undefined;
      bootstrap = buildFullBootstrap(skillContent, decision);
    }

    const memorySystem = { role: "system" as const, content: bootstrap };
    return { messages: [memorySystem, ...messages] };
  });
}
