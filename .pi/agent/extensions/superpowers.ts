/**
 * superpowers — conditional injection of obra/superpowers methodology.
 *
 * Ports the opencode fork's built-in Superpowers service
 * (packages/opencode/src/session/superpowers.ts) to Pi. When the first user
 * message of a conversation matches build/debug intent verbs — or contains
 * the `<superpowers>` force token — prepends the using-superpowers/SKILL.md
 * content as a system message via Pi's `context` event.
 *
 * Token economy: skill descriptions (all 14 superpowers skills) are already
 * in the system prompt at startup. The full bootstrap (~1.5k tokens) is
 * pulled in only when intent matches. Q&A and read-only sessions stay clean.
 *
 * Compared to the opencode version this is *simpler* — no session-ID dedup
 * because Pi's `context` event passes the full message array deep-copy each
 * turn. We grep the first user message every call; with prompt caching the
 * injected block stays warm and re-injection across turns is free.
 *
 * Controls (env):
 *   SUPERPOWERS_OFF=1             plugin inactive (kill switch)
 *   SUPERPOWERS_BOOTSTRAP=<path>  override using-superpowers SKILL.md path
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── regex tuning (mirrors opencode fork) ──────────────────────────────────

const INTENT_REGEX =
  /\b(implement|build|create|design|architect|refactor|rewrite|restructure|debug|trace|investigate|TDD|red-green-refactor|fix\s+(?:a\s+|the\s+)?(?:bug|issue|error|crash|test)|add\s+(?:a\s+|the\s+)?(?:feature|function|test|component|endpoint|method|hook|module)|write\s+(?:a\s+|the\s+)?(?:tests?|specs?|unit\s+tests?|integration\s+tests?))\b/i;

const FORCE_TOKEN_REGEX = /<superpowers>/i;

const MARKER = "<!-- superpowers-methodology-injected -->";

const TOOL_MAPPING = `
Tool mapping for Pi:
- The using-superpowers skill below references opencode-specific tools (TodoWrite, Task subagents).
  In Pi these are not built-in — use the equivalent patterns:
- TodoWrite       → no built-in; use a TODO.md file (matches Pi's recommendation against built-in todos).
- Task subagents  → no built-in; spawn pi instances via tmux, or use the subagent extension if installed.
- Skill tool      → Pi's /skill:name command, or just let the agent read the SKILL.md file directly.
- File ops        → Pi's read/write/edit/bash built-ins.
`.trim();

// ── helpers ───────────────────────────────────────────────────────────────

function bootstrapPath(): string {
  const env = process.env.SUPERPOWERS_BOOTSTRAP;
  if (env) return env;
  return join(homedir(), ".config/opencode/skills/superpowers/using-superpowers/SKILL.md");
}

function decideInjection(text: string): "intent" | "forced" | "skip" {
  if (FORCE_TOKEN_REGEX.test(text)) return "forced";
  if (INTENT_REGEX.test(text)) return "intent";
  return "skip";
}

function buildBootstrap(skillContent: string): string {
  const body = skillContent.replace(/^---\n[\s\S]*?\n---\n/, "");
  return [
    MARKER,
    "<superpowers-methodology>",
    "The using-superpowers skill is loaded inline below — do not re-load it via the skill tool.",
    "",
    body.trim(),
    "",
    TOOL_MAPPING,
    "</superpowers-methodology>",
  ].join("\n");
}

// ── cached bootstrap content (one disk read per process) ──────────────────

let cachedBootstrap: string | null | undefined = undefined;

function loadBootstrap(): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap;
  const path = bootstrapPath();
  if (!existsSync(path)) {
    cachedBootstrap = null;
    return null;
  }
  try {
    cachedBootstrap = buildBootstrap(readFileSync(path, "utf-8"));
  } catch {
    cachedBootstrap = null;
  }
  return cachedBootstrap;
}

// ── extract first user message text from Pi's message array ───────────────

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

// ── plugin ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env.SUPERPOWERS_OFF === "1") return;

  pi.on("context", async (event, _ctx) => {
    const messages = (event as { messages: PiMessage[] }).messages;
    if (!messages?.length) return undefined;

    const text = firstUserText(messages) ?? "";
    if (!text) return undefined;

    const decision = decideInjection(text);
    if (decision === "skip") return undefined;

    const bootstrap = loadBootstrap();
    if (!bootstrap) return undefined;

    // Idempotency — if some earlier message already contains the marker, skip.
    const alreadyInjected = messages.some((m) => {
      if (m.role !== "system") return false;
      const c = m.content;
      if (typeof c === "string") return c.includes(MARKER);
      return false;
    });
    if (alreadyInjected) return undefined;

    const memorySystem = { role: "system" as const, content: bootstrap };
    return { messages: [memorySystem, ...messages] };
  });
}
