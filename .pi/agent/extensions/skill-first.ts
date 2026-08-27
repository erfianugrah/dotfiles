/**
 * skill-first - ACTIVE skill reminder: re-inject until the model actually
 * opens the SKILL.md.
 *
 * User directive (2026-08-27): "we should have a tool guard that reminds the
 * model to check skills/tools depending on what's prompted, kinda like the
 * history core tool guard, this was passive becomes active".
 *
 * skill-guard already matches intent, but its nudge fires ONCE at the start of
 * a turn - a model that ignores it never hears about the skill again. That is
 * the documented ~50% miss rate on skills overlapping trained behaviour
 * (anthropics/claude-code#30387). history-first solved the same class of
 * problem for prior-session lookups by re-injecting at the END of the context
 * every turn until the action actually happened; this is that mechanism
 * applied to skills.
 *
 * Relationship to skill-guard (they are complements, not duplicates):
 *   skill-guard  - one-shot intent message + BLOCKING tool_call nudge when a
 *                  write/bash touches a skill's domain (action-time).
 *   skill-first  - persistent context-tail reminder until a SKILL.md is read
 *                  (intent-time, non-blocking, never blocks a tool).
 *
 * Matching reuses skill-guard-core's narrow INTENT_RULES, so there is one
 * source of truth for the rule tables and no new false-positive surface.
 *
 * Disarms on the first `read` of ANY SKILL.md - a model that opened a
 * different skill has engaged with the system, and further nagging is noise.
 *
 * Env:
 *   PI_SKILL_FIRST_OFF=1     disable entirely
 *   PI_SKILL_FIRST_MAX=<n>   max injections per session (default 3)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	addHints,
	decideContext,
	freshState,
	isSkillRead,
	matchIntent,
	SKILL_FIRST_MARKER,
	type SkillFirstState,
} from "./lib/skill-first-core.ts";

function loadMaxFires(): number {
	const n = Number(process.env.PI_SKILL_FIRST_MAX);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

type PiMessage = { role: string; content: unknown };

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SKILL_FIRST_OFF === "1") return;

	const states = new Map<string, SkillFirstState>();

	const sessionKey = (ctx: unknown): string => {
		try {
			const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } }).sessionManager;
			return sm?.getSessionFile?.() ?? "default";
		} catch {
			return "default";
		}
	};

	const stateFor = (ctx: unknown): SkillFirstState => {
		const key = sessionKey(ctx);
		let s = states.get(key);
		if (!s) {
			s = freshState(loadMaxFires());
			states.set(key, s);
		}
		return s;
	};

	// Intent: accumulate matched skills from each user prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = (event as { prompt?: string }).prompt ?? "";
		const hints = matchIntent(prompt);
		if (hints.length === 0) return undefined;
		try {
			addHints(stateFor(ctx), hints);
		} catch {
			/* stale ctx */
		}
		return undefined;
	});

	// Reading any SKILL.md disarms for the rest of the session.
	pi.on("tool_call", async (event, ctx) => {
		const e = event as { toolName?: string; input?: unknown };
		if (e.toolName && isSkillRead(e.toolName, e.input)) {
			try {
				stateFor(ctx).consulted = true;
			} catch {
				/* stale ctx */
			}
		}
		return undefined;
	});

	pi.on("context", async (event, ctx) => {
		const messages = (event as { messages?: PiMessage[] }).messages;
		if (!messages?.length) return undefined;

		// Stale-ctx guard (see local-model-rules.ts / history-first.ts): ctx
		// getters can outlive a reloaded session and throw assertActive.
		let state: SkillFirstState;
		try {
			state = stateFor(ctx);
		} catch {
			return undefined;
		}

		return decideContext(state, messages);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		states.delete(sessionKey(ctx));
	});
}

export { SKILL_FIRST_MARKER };
