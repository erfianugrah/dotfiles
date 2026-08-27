/**
 * runaway-turn-core - pure decision logic for the runaway-turn guard.
 * ZERO harness imports. Source of truth for ../runaway-turn-guard.ts.
 *
 * The failure this exists for (observed 2026-08-27): a turn ran for 9m47s
 * emitting a degenerate stream and the user had NO IDEA until they cancelled
 * it out of impatience - "I didn't know till I cancelled it cause it was
 * taking too long". degenerate-stream-guard missed that specific pattern (a
 * newline-separated loop; fixed separately in degenerate-core), but the
 * general problem is bigger than repetition:
 *
 *   - a stream that stops producing tokens but never errors (provider stall)
 *   - a turn that keeps emitting NOVEL text for minutes with no tool call and
 *     no end (rambling / lost model)
 *   - any collapse mode nobody has characterised yet
 *
 * Repetition detection is a WHITELIST of known-bad shapes; it will always
 * miss the next novel failure. This guard is the shape-independent backstop:
 * it watches only elapsed time and output volume, so it catches waste it does
 * not need to recognise.
 *
 * Deliberately NOT an auto-abort by default. The cost asymmetry is the
 * opposite of the repetition case: a long turn is usually LEGITIMATE (a big
 * refactor, a slow provider, a 230k-token prefill measured earlier today at
 * 1302 tok/s => ~3 minutes of prefill before the first token). Killing those
 * would be the false positive the user explicitly asked to avoid. So the
 * default action is VISIBILITY: surface elapsed time + token count in the UI
 * so an unattended runaway is obvious at a glance, and only hard-abort past a
 * much higher ceiling that no legitimate turn has been observed to reach.
 *
 * Two independent thresholds:
 *   WARN  - start showing a live "turn running Ns / N tok" indicator.
 *   ABORT - kill the turn (opt-in; 0 = never, and 0 is the DEFAULT).
 */

/** Seconds before the live elapsed/volume indicator appears. */
export const DEFAULT_WARN_S = 120;
/**
 * Seconds before a hard abort. 0 = disabled (default): the user asked for no
 * false positives, and no legitimate-turn ceiling is known well enough to kill
 * on. Set PI_RUNAWAY_ABORT_S to opt in.
 */
export const DEFAULT_ABORT_S = 0;
/**
 * A stream that has emitted this many chars in ONE turn is suspicious
 * regardless of elapsed time (normal answers are far smaller; the 2026-08-27
 * loop produced tens of thousands of chars of nothing).
 */
export const DEFAULT_MAX_CHARS = 250_000;

export interface RunawayConfig {
	warnS: number;
	abortS: number;
	maxChars: number;
}

export interface RunawayState {
	/** Wall-clock ms when the current assistant turn started (0 = idle). */
	startedAt: number;
	/** Chars of thinking+text delta accumulated this turn. */
	chars: number;
	/** Tool calls issued this turn (progress signal: a working turn calls tools). */
	toolCalls: number;
	/** True once we have surfaced the warning indicator for this turn. */
	warned: boolean;
	/** True once we have aborted this turn (latch: never abort twice). */
	aborted: boolean;
}

export function freshState(): RunawayState {
	return { startedAt: 0, chars: 0, toolCalls: 0, warned: false, aborted: false };
}

export function loadConfig(env: Record<string, string | undefined>): RunawayConfig {
	const num = (raw: string | undefined, dflt: number): number => {
		if (raw === undefined || raw === "") return dflt;
		const n = Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : dflt;
	};
	return {
		warnS: num(env.PI_RUNAWAY_WARN_S, DEFAULT_WARN_S),
		abortS: num(env.PI_RUNAWAY_ABORT_S, DEFAULT_ABORT_S),
		maxChars: num(env.PI_RUNAWAY_MAX_CHARS, DEFAULT_MAX_CHARS),
	};
}

export type Action =
	| { kind: "none" }
	| { kind: "warn"; elapsedS: number; chars: number; toolCalls: number }
	| { kind: "abort"; elapsedS: number; chars: number; reason: string };

/**
 * Decide what to do at this tick. Pure: caller supplies `now`.
 *
 * Ordering matters - abort conditions are checked before warn so a turn that
 * blows straight past both does not merely warn.
 */
export function decide(
	state: RunawayState,
	cfg: RunawayConfig,
	now: number,
): Action {
	if (state.startedAt === 0 || state.aborted) return { kind: "none" };

	const elapsedS = Math.floor((now - state.startedAt) / 1000);

	// Volume ceiling: shape-independent, so it catches collapse modes no
	// repetition detector recognises. Applies even when abortS is disabled -
	// a quarter-million chars in one turn is never a useful answer.
	if (cfg.maxChars > 0 && state.chars >= cfg.maxChars) {
		return {
			kind: "abort",
			elapsedS,
			chars: state.chars,
			reason: `output volume ceiling (${state.chars} chars in one turn)`,
		};
	}

	if (cfg.abortS > 0 && elapsedS >= cfg.abortS) {
		return {
			kind: "abort",
			elapsedS,
			chars: state.chars,
			reason: `time ceiling (${elapsedS}s elapsed)`,
		};
	}

	if (cfg.warnS > 0 && elapsedS >= cfg.warnS) {
		return { kind: "warn", elapsedS, chars: state.chars, toolCalls: state.toolCalls };
	}

	return { kind: "none" };
}

/** Human-readable live indicator text. */
export function indicatorText(a: Extract<Action, { kind: "warn" }>): string {
	const mins = Math.floor(a.elapsedS / 60);
	const secs = a.elapsedS % 60;
	const t = mins > 0 ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
	const vol =
		a.chars >= 1000 ? `${Math.round(a.chars / 1000)}k chars` : `${a.chars} chars`;
	const tools = a.toolCalls === 1 ? "1 tool call" : `${a.toolCalls} tool calls`;
	return `turn running ${t} - ${vol}, ${tools}`;
}

export function abortMessage(a: Extract<Action, { kind: "abort" }>): string {
	return (
		`runaway-turn-guard: aborted - ${a.reason}. ` +
		`This is the shape-independent backstop (not a repetition match), so inspect the ` +
		`output before retrying: a stalled provider, a rambling turn, and a novel collapse ` +
		`mode all land here. Tune with PI_RUNAWAY_ABORT_S / PI_RUNAWAY_MAX_CHARS, ` +
		`disable with PI_RUNAWAY_GUARD_OFF=1.`
	);
}
