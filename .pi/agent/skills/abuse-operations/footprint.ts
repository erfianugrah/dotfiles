/**
 * Campaign-footprint matching (N-of-M threshold bands + pivot/splash detection).
 *
 * Zero dependencies, pure functions. Framework-agnostic — drop into any
 * runtime (Cloudflare Worker, Node, Deno, browser). This is the operational
 * layer the abuse-operations model describes, distinct from per-item risk
 * scoring:
 *
 *   - A WEIGHTED SCORER answers "how bad is this one submission?" (0-100).
 *   - A FOOTPRINT MATCHER answers "which KNOWN CAMPAIGN does this match, and
 *     is it a pivot (a returning actor who changed one TTP)?"
 *
 * Indicators are deliberately low-value individually; their COLLECTION is the
 * signature. A footprint is named after a campaign/actor, NOT a single human
 * ("footprint" not "fingerprint" — it may be one person, a bot, or several
 * groups sharing the same kit).
 *
 * See SKILL.md (abuse-operations) for the doctrine.
 */

/** A single low-value signal. `value` omitted = presence/key-only (wildcard) match. */
export interface Indicator {
	key: string;
	value?: string | number | boolean;
}

/** A known campaign's TTP, expressed as the set of indicators it exhibits. */
export interface Footprint {
	id: string;
	label: string;
	/** The TTP set. M = indicators.length. */
	indicators: Indicator[];
	/**
	 * Minimum matched indicators (N) to count as a PIVOT (partial match of a
	 * returning actor). Below this → no match. Defaults to ceil(M * 0.6),
	 * floored at 2, so a 5-indicator footprint pivots at 3.
	 */
	pivotFloor?: number;
}

export type MatchBand = 'full' | 'pivot' | 'none';
export type MatchAction = 'auto-action' | 'review' | 'ignore';

export interface MatchResult {
	footprintId: string;
	label: string;
	/** Footprint indicators that WERE observed. */
	matched: Indicator[];
	/** Footprint indicators that were NOT observed (what the actor dropped/changed). */
	missing: Indicator[];
	/** Observed indicators NOT in the footprint — pivot candidates to add. */
	novel: Indicator[];
	matchedCount: number; // N
	total: number; // M
	ratio: number; // N / M, 0..1
	band: MatchBand;
	action: MatchAction;
}

function pivotFloorFor(fp: Footprint): number {
	if (typeof fp.pivotFloor === 'number') return fp.pivotFloor;
	return Math.max(2, Math.ceil(fp.indicators.length * 0.6));
}

/** Does an observed indicator satisfy a footprint indicator? Key must match; value matches if footprint value is undefined (wildcard) or strictly equal. */
function satisfies(footprintInd: Indicator, observed: Indicator): boolean {
	if (footprintInd.key !== observed.key) return false;
	if (footprintInd.value === undefined) return true; // key-only / wildcard
	return footprintInd.value === observed.value;
}

function sameIndicator(a: Indicator, b: Indicator): boolean {
	return a.key === b.key && a.value === b.value;
}

/** Match one observed indicator set against one footprint. */
export function matchFootprint(observed: Indicator[], footprint: Footprint): MatchResult {
	const total = footprint.indicators.length;
	const matched: Indicator[] = [];
	const missing: Indicator[] = [];

	for (const fpInd of footprint.indicators) {
		if (observed.some((o) => satisfies(fpInd, o))) matched.push(fpInd);
		else missing.push(fpInd);
	}

	// Novel = observed indicators that didn't satisfy ANY footprint indicator.
	const novel = observed.filter((o) => !footprint.indicators.some((fpInd) => satisfies(fpInd, o)));

	const matchedCount = matched.length;
	const ratio = total === 0 ? 0 : matchedCount / total;
	const floor = pivotFloorFor(footprint);

	let band: MatchBand;
	let action: MatchAction;
	if (total > 0 && matchedCount === total) {
		band = 'full';
		action = 'auto-action';
	} else if (matchedCount >= floor) {
		band = 'pivot';
		action = 'review';
	} else {
		band = 'none';
		action = 'ignore';
	}

	return { footprintId: footprint.id, label: footprint.label, matched, missing, novel, matchedCount, total, ratio, band, action };
}

/** Match an observed set against every known footprint, strongest first. Drops `none`-band results. */
export function matchAll(observed: Indicator[], footprints: Footprint[]): MatchResult[] {
	return footprints
		.map((fp) => matchFootprint(observed, fp))
		.filter((r) => r.band !== 'none')
		.sort((a, b) => b.ratio - a.ratio || b.matchedCount - a.matchedCount);
}

/**
 * Splash = multiple DIFFERENT footprints partially matching the same observation
 * → multiple actors sharing TTPs (same kit / tutorial). Returns matching results
 * (≥2 distinct footprints in pivot OR full band) or null.
 */
export function detectSplash(results: MatchResult[]): MatchResult[] | null {
	const hits = results.filter((r) => r.band === 'pivot' || r.band === 'full');
	const distinct = new Set(hits.map((r) => r.footprintId));
	return distinct.size >= 2 ? hits : null;
}

/**
 * For a pivot result, the indicators to fold back into the footprint to keep it
 * current: the novel (newly-observed) indicators the returning actor introduced.
 * Returns [] for full or none bands (nothing to learn).
 */
export function suggestFootprintUpdate(result: MatchResult): Indicator[] {
	if (result.band !== 'pivot') return [];
	return result.novel;
}

/** Convenience: merge suggested indicators into a footprint (returns a new Footprint, dedup'd). */
export function applyFootprintUpdate(footprint: Footprint, additions: Indicator[]): Footprint {
	const merged = [...footprint.indicators];
	for (const add of additions) {
		if (!merged.some((ind) => sameIndicator(ind, add))) merged.push(add);
	}
	return { ...footprint, indicators: merged };
}
