/**
 * style-toggle — `/style` command + terse/socratic output-style indicator.
 *
 * Ports the opencode fork's output-style toggle (commits 4069bab24, e41b4d465,
 * b8dda751a, 79b80e7df) to Pi. Two styles:
 *
 * - **terse** (default): brevity-optimised. Drops articles, filler, hedging,
 *   pleasantries. Code/commands/paths verbatim. Fragments OK.
 * - **socratic**: teaching mode. Asks probing questions before giving full
 *   answers. Graduated hints. Explains WHY not just WHAT.
 *
 * Commands:
 *   /style              cycle between terse → socratic → terse
 *   /style terse        set to terse
 *   /style socratic     set to socratic
 *
 * State: `~/.pi/agent/style.json` ({ "style": "terse" | "socratic" }).
 * Survives restarts. Per-machine, not version-controlled (style is a personal
 * preference that may differ across machines / sessions).
 *
 * The active style prompt is prepended as a system message on every LLM call
 * via the `context` event. The TUI status bar shows the current style.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_FILE = join(homedir(), ".pi/agent/style.json");
const MARKER_TERSE = "<!-- pi-style-terse -->";
const MARKER_SOCRATIC = "<!-- pi-style-socratic -->";

type Style = "terse" | "socratic";

const TERSE_PROMPT = `${MARKER_TERSE}
# Output Style: Terse
Terse mode active. Technical accuracy preserved. Only prose fluff removed.
Drop: articles (the/a/an), filler (just/really/basically/actually/however), pleasantries, hedging, unnecessary caveats.
Fragments OK. Shortest clear phrasing. Code/commands/paths unchanged.
Pattern: [what] [action] [why]. No preamble. No postamble.
Code blocks, technical terms, file paths: verbatim. Never compress code.
Toggle styles with the /style command.`;

const SOCRATIC_PROMPT = `${MARKER_SOCRATIC}
# Output Style: Socratic
You are a teacher. NEVER give the full answer upfront unless the user explicitly asks for it.
- Ask probing questions that lead the user toward the answer themselves
- Break problems into smaller pieces and ask "what do you think happens here?"
- Give graduated hints: question first, then hint, then partial answer, then full answer only if stuck
- When user says "I don't know" or "just tell me" — THEN give the direct answer
- Explain WHY not just WHAT — teach underlying concepts and mental models
- After the user arrives at an answer, ask "what would happen if..." to deepen understanding
- Use real-world analogies before showing code
Code changes: still implement when asked, but explain reasoning and tradeoffs.
Toggle styles with the /style command.`;

// ── state ─────────────────────────────────────────────────────────────────

function loadStyle(): Style {
  if (!existsSync(STATE_FILE)) return "terse";
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { style?: Style };
    return parsed.style === "socratic" ? "socratic" : "terse";
  } catch {
    return "terse";
  }
}

function saveStyle(style: Style) {
  writeFileSync(STATE_FILE, JSON.stringify({ style }) + "\n");
}

function promptFor(style: Style): string {
  return style === "socratic" ? SOCRATIC_PROMPT : TERSE_PROMPT;
}

type PiMessage = { role: string; content: unknown };

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Re-bind the status on every session lifecycle event with a fresh ctx.
  // agent_start fires once per pi boot, but /reload + /new + fork all fire
  // session_start instead — without this, the indicator vanishes on reload.
  const setStatus = (ctx: { ui: { setStatus: (k: string, v: string) => void } }) => {
    ctx.ui.setStatus("style", `style: ${loadStyle()}`);
  };
  pi.on("agent_start", async (_event, ctx) => setStatus(ctx));
  pi.on("session_start", async (_event, ctx) => setStatus(ctx));

  // /style command — set or toggle.
  pi.registerCommand("style", {
    description: "Toggle or set output style (terse|socratic)",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["terse", "socratic"];
      const filtered = opts.filter((o) => o.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      let next: Style;
      if (arg === "terse" || arg === "socratic") {
        next = arg;
      } else if (arg === "") {
        next = loadStyle() === "terse" ? "socratic" : "terse";
      } else {
        ctx.ui.notify(`Unknown style "${arg}". Use 'terse' or 'socratic'.`, "warning");
        return;
      }
      saveStyle(next);
      ctx.ui.setStatus("style", `style: ${next}`);
      ctx.ui.notify(`Style → ${next}`, "info");
    },
  });

  // Inject the active style prompt as a system message at the top of every
  // LLM call. Anthropic prompt caching means the cost is paid once and
  // amortised across the session.
  pi.on("context", async (event, _ctx) => {
    const messages = (event as { messages: PiMessage[] }).messages;
    if (!messages?.length) return undefined;

    const style = loadStyle();
    const prompt = promptFor(style);

    // Idempotency — skip if already injected for current style.
    const alreadyInjected = messages.some((m) => {
      if (m.role !== "system") return false;
      const c = m.content;
      return typeof c === "string" && (c.includes(MARKER_TERSE) || c.includes(MARKER_SOCRATIC));
    });
    if (alreadyInjected) return undefined;

    return { messages: [{ role: "system" as const, content: prompt }, ...messages] };
  });

  // Clear status when session ends.
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("style", undefined);
  });
}
