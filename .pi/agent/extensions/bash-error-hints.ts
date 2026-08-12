/**
 * bash-error-hints — decorate bash tool results with one-line hints when
 * stderr matches a known footgun pattern.
 *
 * Background: every time the agent fumbles on a recoverable error (e.g.
 * `git mv` on a gitignored file, "pathspec did not match", Anthropic stream
 * cutoff) we lose 30s-5min to investigation that should have been
 * "check .gitignore first". Prompts go stale. Skill descriptions don't
 * trigger reliably. The cheapest intervention is to inject the hint
 * exactly when relevant — the next turn after the error appears.
 *
 * Cost model:
 *   - zero context tokens for runs that don't hit any pattern
 *   - ~30 tokens of injected hint when a pattern fires
 *   - hint is plain text appended to the existing tool output, never
 *     replaces it — model still sees the original stderr verbatim
 *
 * The pattern table, renderer, matcher, and oncePerSession splitter live in
 * ./lib/bash-error-hints-core.ts (zero harness imports), shared with the
 * Claude Code PostToolUse hook (../../.claude/hooks/bash-error-hints.ts).
 * This file is the thin pi adapter: it owns the session-keyed fired-set state
 * and the tool_result mutation. Symbols the pi test suite imports are
 * re-exported below so ../tests/extensions.test.ts keeps resolving.
 *
 * Idempotency: hints are wrapped in a [bash-error-hints] marker so we
 * never stack duplicates if the handler runs twice.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HINT_MARKER,
  applyOncePerSession,
  decorate,
  extractText,
  matchHintsDetailed,
} from "./lib/bash-error-hints-core.ts";

// Re-exports for the pi test suite (../tests/extensions.test.ts).
export {
  HINTS,
  HINT_MARKER,
  applyOncePerSession,
  matchHints,
  matchHintsDetailed,
  renderHint,
  type Hint,
  type HintMatch,
} from "./lib/bash-error-hints-core.ts";

interface ToolResultContent {
  type: "text";
  text: string;
}

export default function (pi: ExtensionAPI) {
  // Session-keyed set of oncePerSession hints already fired. Keyed by
  // session file (same pattern as tool-guard) because pi keeps the
  // extension module loaded across /new, /resume, /fork.
  const firedOnceHints = new Map<string, Set<string>>();

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const key = ctx.sessionManager.getSessionFile?.() ?? "default";
      firedOnceHints.delete(key);
    } catch { /* ignore */ }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const text = extractText(event.content);
    if (!text) return undefined;

    // Idempotency - never stack hints if we somehow run twice.
    if (text.includes(HINT_MARKER)) return undefined;

    const sessionKey = (() => {
      try { return ctx.sessionManager.getSessionFile?.() ?? "default"; } catch { return "default"; }
    })();
    let fired = firedOnceHints.get(sessionKey);
    if (!fired) {
      fired = new Set();
      firedOnceHints.set(sessionKey, fired);
    }

    const { kept, newlyFired } = applyOncePerSession(matchHintsDetailed(text), fired);
    for (const key of newlyFired) fired.add(key);

    const decorated = decorate(text, kept);
    if (decorated === null) return undefined;

    const newContent: ToolResultContent[] = [{ type: "text", text: decorated }];
    return { content: newContent };
  });
}
