/**
 * skill-guard - actively nudge the model toward a matching skill BEFORE it
 * proceeds with trained-default behavior.
 *
 * Why this exists:
 *   Pi skills are passive progressive-disclosure. Only the one-line
 *   descriptions sit in context; loading the SKILL.md is a voluntary `read`
 *   the model often skips. Pi's own docs/skills.md says so verbatim: "models
 *   don't always do this; use prompting or /skill:name to force it".
 *
 *   The miss rate is worst for skills that overlap the model's TRAINED
 *   behavior (git, docker, terraform, fly): the built-in default
 *   out-competes the registered skill. Cross-harness evidence:
 *   anthropics/claude-code#30387 ("Custom skills are not reliably
 *   auto-triggered by the model", closed not-planned) reports ~50% miss on
 *   trained-overlap skills while novel-tool skills fire reliably. The
 *   community fix there is a UserPromptSubmit / PreToolUse hook that
 *   pattern-matches and injects a hard "invoke the X skill" nudge - exactly
 *   how tool-guard converts prompt rules into runtime blocks.
 *
 * Two hooks:
 *   before_agent_start (intent) - match the user's prompt; inject a
 *     NON-BLOCKING message pointing at the skill.
 *   tool_call (action) - when about to write/edit a file (or run a command)
 *     whose type maps to a skill, block ONCE with a nudge, then let the retry
 *     through. `block` is the only lever tool_call exposes, so we reuse the
 *     docs_first "block once, mark session, pass on retry" pattern.
 *
 * Design constraints (from operators running the equivalent Claude Code hooks
 * in prod, and from tool-guard's own conventions):
 *   - Pointer, not payload: inject "read <name>", never the skill body
 *     (avoids context bloat across ~39 skills).
 *   - One-shot per skill per session: a nudge you see every turn is a nudge
 *     you learn to ignore (same lesson as over-hedging).
 *   - Cheap matching: static regex maps, no disk walk on the hot path.
 *   - High precision over coverage: a false nudge trains the model to ignore
 *     the channel. Seed rules are deliberately narrow.
 *
 * Disable a rule by ID via DISABLED below, or the whole extension by renaming
 * the file to skill-guard.ts.disabled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  matchIntent,
  matchPath,
  matchBash,
  extractPatchPaths,
  intentMessage,
  actionReason,
  type SkillHint,
} from "./lib/skill-guard-core.ts";

// Re-export the pure matchers + builders so existing importers (the pi test
// suite in ../tests/extensions.test.ts) resolve them here unchanged.
export {
  matchIntent,
  matchPath,
  matchBash,
  extractPatchPaths,
  intentMessage,
  actionReason,
  type SkillHint,
} from "./lib/skill-guard-core.ts";

// ---- Extension registration ----------------------------------------------

export default function (pi: ExtensionAPI) {
  // Fired skills, keyed by session file so /new starts fresh. Skill name is
  // the dedup unit: once we've nudged for `fly` this session (via intent OR
  // action OR bash), we don't nudge for it again.
  const firedBySession = new Map<string, Set<string>>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } })
        .sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };
  const firedSet = (key: string): Set<string> => {
    let s = firedBySession.get(key);
    if (!s) {
      s = new Set();
      firedBySession.set(key, s);
    }
    return s;
  };

  pi.on("session_shutdown", async (_event, ctx) => {
    firedBySession.delete(sessionKey(ctx));
  });

  // Intent path: non-blocking message injection.
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = (event as { prompt?: string }).prompt ?? "";
    const hints = matchIntent(prompt);
    if (hints.length === 0) return undefined;

    const fired = firedSet(sessionKey(ctx));
    const fresh = hints.filter((h) => !fired.has(h.skill));
    if (fresh.length === 0) return undefined;
    for (const h of fresh) fired.add(h.skill);

    return {
      message: {
        customType: "skill-guard",
        content: intentMessage(fresh),
        display: true,
      },
    };
  });

  // Action path: block once with a nudge, then pass on retry.
  pi.on("tool_call", async (event, ctx) => {
    const e = event as {
      toolName: string;
      input: {
        path?: string;
        file_path?: string;
        command?: string;
        patchText?: string;
      };
    };
    const fired = firedSet(sessionKey(ctx));

    let hint: SkillHint | null = null;

    if (e.toolName === "write" || e.toolName === "edit") {
      const p = e.input.path ?? e.input.file_path;
      if (typeof p === "string") hint = matchPath(p);
    } else if (e.toolName === "apply_patch") {
      for (const p of extractPatchPaths(e.input.patchText ?? "")) {
        hint = matchPath(p);
        if (hint) break;
      }
    } else if (e.toolName === "bash") {
      if (typeof e.input.command === "string") hint = matchBash(e.input.command);
    }

    if (!hint) return undefined;
    if (fired.has(hint.skill)) return undefined; // already nudged this session

    fired.add(hint.skill);
    return { block: true, reason: actionReason(hint) };
  });
}
