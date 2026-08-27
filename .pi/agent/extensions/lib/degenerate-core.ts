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
 * a false abort is one retry.
 *
 * SECOND incident (2026-08-27): kimi-k3 streamed "   <U+FFFD>\n\n" for ~10
 * MINUTES, twice, and findPeriodCollapse did NOT fire - its
 * `tail.includes("\n")` bail-out (added to protect wide markdown tables)
 * makes it structurally blind to EVERY newline-separated loop. The old test
 * even asserted the blindness as intended behaviour
 * (`findPeriodCollapse("!\n".repeat(150))` -> null). findLineCollapse below
 * covers that mode by comparing whole LINES, so char-periodicity keeps its
 * newline bail-out (tables stay safe) while repeating-line cycles are caught.
 * Callers should use findCollapse(), which tries both.
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

// ---- Line-level detector tunables (findLineCollapse) ---------------------
// ONE conservative rule instead of a heuristic stack: an EXACT cycle of a
// SHORT unit repeated 30+ times. Rationale for 30 (not 12): at 12 repeats,
// legitimate generated output false-positives - 12 identical "  }" lines from
// a code generator, or a 12-row uniform config block, are plausible. At 30
// consecutive byte-identical repeats with zero variation, real content is not
// a credible explanation, while every observed collapse ran for hundreds of
// repeats (the 2026-08-27 incident streamed for ~10 minutes). Cost asymmetry
// drives this: a false abort destroys an in-flight turn, a late catch only
// wastes a few more seconds.
export const LINE_WINDOW = 140;
export const MAX_LINE_PERIOD = 4;
export const MIN_LINE_REPEATS = 30;
export const MAX_LINE_UNIT = 120;

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

/**
 * Inspect the tail LINES of `text` for a repeating line cycle - the collapse
 * mode findPeriodCollapse cannot see, because one newline disables it.
 *
 * `period` is in LINES (not chars) and `unit` is the repeating line block.
 * Requires an EXACT cycle (trailing whitespace normalised) repeated
 * MIN_LINE_REPEATS times, so near-identical-but-varying real content never
 * trips it.
 */
export function findLineCollapse(text: string): Collapse | null {
	const all = text.split("\n");
	// Drop the last element: mid-stream it is a PARTIAL line, and comparing a
	// half-written line against a complete one would break a real cycle.
	if (all.length < 2) return null;
	const lines = all
		.slice(0, -1)
		.slice(-LINE_WINDOW)
		.map((l) => l.replace(/[ \t]+$/, ""));

	for (let k = 1; k <= MAX_LINE_PERIOD; k++) {
		if (lines.length < k * MIN_LINE_REPEATS) continue;

		// Compare over whole cycles only, so a ragged head never breaks the match.
		const usable = Math.floor(lines.length / k) * k;
		const win = lines.slice(lines.length - usable);
		const unitLines = win.slice(0, k);

		// A k-cycle of all-blank lines is just blank padding; the k=1 pass
		// already reports it, so don't also report a bogus multi-line unit.
		if (k > 1 && unitLines.every((l) => l === "")) continue;

		const unit = unitLines.join("\n");
		if (unit.length > MAX_LINE_UNIT) continue;

		let exact = true;
		for (let i = k; i < win.length; i++) {
			if (win[i] !== win[i - k]) {
				exact = false;
				break;
			}
		}
		if (!exact) continue;

		return { period: k, match: 1, unit, inspected: win.length };
	}
	return null;
}

/**
 * Either collapse mode: single-line char periodicity ("!!!!") or a repeating
 * line cycle ("   ?\n\n" forever). Callers should use THIS, not the two
 * detectors directly.
 */
export function findCollapse(text: string): Collapse | null {
	return findPeriodCollapse(text) ?? findLineCollapse(text);
}
