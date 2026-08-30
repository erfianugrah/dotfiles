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
  // Fired nudges, keyed by session file so /new starts fresh.
  //
  // Dedup design (revised 2026-08-30). The original keyed on SKILL NAME shared
  // across all three paths, which had two failure modes:
  //   1. The non-blocking INTENT note consumed the budget for the blocking
  //      ACTION guard. A session that merely said "deploy the stack" (intent)
  //      could then run `ssh servarr 'docker compose up -d'` thirty turns later
  //      and never be blocked - the rustnzb shape exactly: acknowledge the
  //      skill in prose, violate it in bash, guard already spent.
  //   2. One nudge per skill per session is too few: a long session legitimately
  //      hits the same skill in several DIFFERENT contexts (compose up, then a
  //      cert rotation, then a pipeline edit) and each deserves its own nudge.
  //
  // Now: namespaces are separate (`intent:<skill>` vs `action:<ruleId>`), and
  // the action path dedups on the EXACT command/path too, so an immediate retry
  // of the same command passes (preserving the block-once-then-allow contract)
  // while a genuinely different command matching the same rule re-fires. A
  // per-rule cap keeps a stubborn loop from becoming a nag.
  const firedBySession = new Map<string, Map<string, number>>();

  const MAX_FIRES_PER_RULE = Number(process.env.PI_SKILL_GUARD_MAX_FIRES) || 3;

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } })
        .sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };
  const firedSet = (key: string): Map<string, number> => {
    let s = firedBySession.get(key);
    if (!s) {
      s = new Map();
      firedBySession.set(key, s);
    }
    return s;
  };

  /** Count of prior fires for a dedup key. */
  const fireCount = (fired: Map<string, number>, k: string): number =>
    fired.get(k) ?? 0;

  /** Record a fire; returns the new count. */
  const bump = (fired: Map<string, number>, k: string): number => {
    const n = fireCount(fired, k) + 1;
    fired.set(k, n);
    return n;
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
    // Namespaced: an intent note must NOT consume the action guard's budget.
    const fresh = hints.filter(
      (h) => fireCount(fired, `intent:${h.skill}`) < MAX_FIRES_PER_RULE,
    );
    if (fresh.length === 0) return undefined;
    for (const h of fresh) bump(fired, `intent:${h.skill}`);

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

    // Dedup on rule + exact target: an immediate retry of the SAME command
    // passes (block-once-then-allow, so the agent is never stuck), but a
    // different command matching the same rule earns its own nudge.
    const target =
      e.input.command ?? e.input.path ?? e.input.file_path ?? e.input.patchText ?? "";
    const exact = `action:${hint.id}:${target.trim().slice(0, 200)}`;
    if (fireCount(fired, exact) > 0) return undefined; // this exact call already nudged

    // Per-rule cap: a stubborn loop gets 3 nudges, then we stop nagging.
    const perRule = `action:${hint.id}`;
    if (fireCount(fired, perRule) >= MAX_FIRES_PER_RULE) return undefined;

    bump(fired, exact);
    bump(fired, perRule);
    return { block: true, reason: actionReason(hint) };
  });
}
