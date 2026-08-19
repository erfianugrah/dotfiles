/**
 * degenerate-core - pure repetition-collapse detector for streamed LLM output.
 *
 * Motivating incident (2026-08-19): moonshotai/kimi-k3 via OpenRouter fell
 * into a repetition collapse on the thinking channel twice in one morning,
 * streaming nothing but "!" (112 and 1207 chars, both user-aborted). Pi
 * renders the thinking stream live, so the TUI filled with rows of "!"
 * while the turn burned tokens until someone noticed and hit Esc.
 *
 * The detector is a periodicity check over the tail of the stream: if the
 * last WINDOW chars consist of one short unit (1..MAX_PERIOD chars) repeated
 * with >= MATCH_THRESHOLD fidelity, the stream is degenerate. This catches
 * single-char runs ("!!!!", period 1), dotted-bar spam ("| | ", period 2),
 * and short-cycle gibberish, without an entropy table.
 *
 * Known ceiling: a legitimate single markdown table separator row >240 chars
 * (a ~40-column table, "| --- | --- | ...") is periodic and would trip it.
 * Accepted: tables that wide are pathological in themselves, and the cost of
 * a false abort is one retry. Newlines reset the check, so ordinary
 * multi-line content (including normal tables) never trips.
 */

export interface Collapse {
	/** Repeating unit length in chars (1 = single-char run like "!!!!"). */
	period: number;
	/** Fraction of tail positions matching the periodic pattern (0..1). */
	match: number;
	/** The repeating unit (last occurrence). */
	unit: string;
	/** Number of tail chars inspected. */
	inspected: number;
}

export const WINDOW = 240;
export const MAX_PERIOD = 12;
export const MIN_REPEATS = 8;
export const MIN_TAIL = 48;
export const MATCH_THRESHOLD = 0.96;

/**
 * Inspect the tail of `text` for a periodic repetition collapse.
 * Returns the Collapse descriptor, or null for healthy output.
 */
export function findPeriodCollapse(text: string): Collapse | null {
	const tail = text.slice(-WINDOW);
	if (tail.length < MIN_TAIL) return null;
	if (tail.includes("\n")) return null;

	for (let k = 1; k <= MAX_PERIOD; k++) {
		if (tail.length < Math.max(k * MIN_REPEATS, MIN_TAIL)) continue;
		let same = 0;
		const n = tail.length - k;
		for (let i = k; i < tail.length; i++) {
			if (tail[i] === tail[i - k]) same++;
		}
		const match = same / n;
		if (match >= MATCH_THRESHOLD) {
			return { period: k, match, unit: tail.slice(tail.length - k), inspected: tail.length };
		}
	}
	return null;
}
