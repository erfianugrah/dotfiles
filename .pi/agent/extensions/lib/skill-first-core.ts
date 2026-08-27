/**
 * skill-first-core - pure decision logic for the ACTIVE skill reminder.
 * ZERO harness imports. Source of truth for ../skill-first.ts.
 *
 * Why this exists alongside skill-guard (user directive 2026-08-27: "we
 * should have a tool guard that reminds the model to check skills/tools
 * depending on what's prompted, kinda like the history core tool guard, this
 * was passive becomes active"):
 *
 *   skill-guard's intent path fires ONCE, on before_agent_start, as a
 *   customType message near the START of the turn. A model that ignores it
 *   never hears about the skill again - the nudge is out-competed by the
 *   trained default it was meant to override, which is the exact failure
 *   anthropics/claude-code#30387 documents (~50% miss on trained-overlap
 *   skills). history-first solved the same class of problem for prior-session
 *   lookups by RE-INJECTING at the END of the context every turn until the
 *   model actually performs the action.
 *
 * This module applies that mechanism to skills: the reminder re-appears at
 * max-recency until the model READS the SKILL.md (or the fire cap is hit),
 * then never returns. Matching is delegated to skill-guard-core's rule tables
 * so there is ONE source of truth for "what maps to which skill".
 *
 * Precision is the whole game: a reminder that fires on the wrong thing
 * trains the model (and the user) to ignore the channel. Matching therefore
 * reuses skill-guard's deliberately narrow INTENT_RULES rather than
 * pattern-matching every skill's description.
 */

import { matchIntent, type SkillHint } from "./skill-guard-core.ts";

export { matchIntent, type SkillHint };

export const SKILL_FIRST_MARKER = "[skill-first]";

/** Turns the reminder re-appears while unsatisfied. Env-overridable. */
export const DEFAULT_MAX_FIRES = 3;

/**
 * Minimum user-message length to count as a task (mirrors history-first):
 * "continue" / "y" / "go on" are not task starts.
 */
export function isSubstantive(text: string): boolean {
	return text.trim().length >= 20;
}

/**
 * True when a tool call constitutes "the model actually consulted the skill".
 *
 * Satisfied by reading ANY SKILL.md - not necessarily the matched one. A model
 * that opened a different skill has engaged with the skill system, which is
 * the behaviour being trained; nagging further would be noise.
 */
export function isSkillRead(toolName: string, input: unknown): boolean {
	if (toolName !== "read" && toolName !== "Read") return false;
	const i = input as { path?: unknown; filePath?: unknown; file_path?: unknown };
	const p = i?.path ?? i?.filePath ?? i?.file_path;
	if (typeof p !== "string") return false;
	return /SKILL\.md$/i.test(p);
}

export interface SkillFirstState {
	/** Skills matched for this session's prompts, in first-seen order. */
	pending: SkillHint[];
	/** True once any SKILL.md was read. Disarms for the rest of the session. */
	consulted: boolean;
	/** Injections delivered so far. */
	fires: number;
	/** Config: max injections per session. */
	maxFires: number;
}

export function freshState(maxFires: number): SkillFirstState {
	return { pending: [], consulted: false, fires: 0, maxFires };
}

/** Record newly-matched skills (dedup by skill name, preserving order). */
export function addHints(state: SkillFirstState, hints: SkillHint[]): void {
	for (const h of hints) {
		if (!state.pending.some((p) => p.skill === h.skill)) state.pending.push(h);
	}
}

export function reminderText(hints: SkillHint[], skillsDir = "~/.pi/agent/skills"): string {
	const lines = hints.map((h) => `- \`${h.skill}\` (${skillsDir}/${h.skill}/SKILL.md): ${h.why}`);
	return (
		`${SKILL_FIRST_MARKER} (harness reminder, not the user): this request matches ` +
		`${hints.length === 1 ? "a skill" : "skills"} you have NOT opened yet. Skills are ` +
		`progressive-disclosure: only the one-line description is in context, and the ` +
		`known failure mode is the model proceeding on its trained default instead ` +
		`(~50% miss rate on skills that overlap trained behaviour). Read the SKILL.md ` +
		`before proceeding - it carries this setup's conventions, gotchas and canonical ` +
		`commands, which the trained default does not know:\n${lines.join("\n")}\n` +
		`If you have judged the skill genuinely irrelevant, say so in one line and proceed.`
	);
}

type Message = { role: string; content: unknown };

function textContent(m: Message): string {
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return (m.content as { type?: string; text?: string }[])
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

/**
 * Decide the context mutation for this turn. Returns undefined when nothing
 * should change. Mutates state.fires when it injects.
 *
 * Idempotent under both context-persistence semantics: any previously
 * injected copy is stripped before a new one is appended, so copies never
 * accumulate (same contract as history-first-core.decideContext).
 */
export function decideContext(
	state: SkillFirstState,
	messages: Message[],
): { messages: Message[] } | undefined {
	const isInjected = (m: Message) => {
		const t = textContent(m);
		return m.role === "user" && t.startsWith(SKILL_FIRST_MARKER);
	};
	const hasInjected = messages.some(isInjected);
	const strip = () =>
		hasInjected ? { messages: messages.filter((m) => !isInjected(m)) } : undefined;

	// Everything below reasons about the REAL conversation, never our own
	// injections - otherwise the reminder's own (long) text satisfies the
	// substantive-message test and the reminder perpetuates itself forever on
	// a session whose only real turns are "y" / "continue".
	const real = messages.filter((m) => !isInjected(m));

	if (state.consulted || state.fires >= state.maxFires) return strip();
	if (state.pending.length === 0) return strip();
	if (!real.some((m) => m.role === "user")) return strip();

	const substantive = real.some(
		(m) => m.role === "user" && isSubstantive(textContent(m)),
	);
	if (!substantive) return strip();

	state.fires++;
	return {
		messages: [...real, { role: "user" as const, content: reminderText(state.pending) }],
	};
}
