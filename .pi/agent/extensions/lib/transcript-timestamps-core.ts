/**
 * transcript-timestamps-core - pure helpers for the transcript-timestamps
 * extension. No pi/tui imports so the unit suite can load it via preload.
 *
 * Row grammar (all dim, one line):
 *   user:  [19:42:03] you · idle 3m12s          (idle omitted under 60s)
 *   turn:  [19:42:17] assistant · 14s           (turn duration)
 *          [19:43:01] assistant · 9s · 58s since prompt   (multi-turn runs)
 *          [19:44:12] assistant · 31s · partial          (aborted mid-turn)
 * A date prefix `01-19 ` appears on the first row of a new calendar day.
 */

export interface TsRowData {
	kind: "user" | "turn";
	/** epoch ms - when the row's message was finalized/submitted */
	at: number;
	/** prefix `MM-dd ` when the calendar day changed since the previous row */
	showDate?: boolean;
	/** user rows: gap since the previous row, if >= IDLE_THRESHOLD_MS */
	idleMs?: number;
	/** turn rows: this turn's duration (LLM call + tool executions) */
	turnMs?: number;
	/** turn rows: cumulative time since the user prompt that started the run */
	sincePromptMs?: number;
	/** turn rows: true when the run aborted before turn_end fired */
	partial?: boolean;
}

/** Below this gap the idle segment is omitted (ordinary turn cadence). */
export const IDLE_THRESHOLD_MS = 60_000;

/** Below this the "since prompt" segment is omitted (single-turn runs). */
export const SINCE_PROMPT_THRESHOLD_MS = 1_000;

export function sameDay(a: number, b: number): boolean {
	const da = new Date(a);
	const db = new Date(b);
	return (
		da.getFullYear() === db.getFullYear() &&
		da.getMonth() === db.getMonth() &&
		da.getDate() === db.getDate()
	);
}

/** HH:MM:SS, 24h local. */
export function fmtClock(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** MM-dd HH:MM:SS - used on day rollover. */
export function fmtDayClock(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtClock(ms)}`;
}

/** Human duration: 0.8s / 42s / 2m 03s / 1h 04m / 2d 5h. */
export function fmtElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
	const d = Math.floor(h / 24);
	return `${d}d ${h % 24}h`;
}

export function renderRow(row: TsRowData): string {
	const clock = row.showDate ? fmtDayClock(row.at) : fmtClock(row.at);
	if (row.kind === "user") {
		let s = `[${clock}] you`;
		if (row.idleMs != null && row.idleMs >= IDLE_THRESHOLD_MS) {
			s += ` · idle ${fmtElapsed(row.idleMs)}`;
		}
		return s;
	}
	let s = `[${clock}] assistant · ${fmtElapsed(row.turnMs ?? 0)}`;
	if (
		row.sincePromptMs != null &&
		row.sincePromptMs - (row.turnMs ?? 0) >= SINCE_PROMPT_THRESHOLD_MS
	) {
		s += ` · ${fmtElapsed(row.sincePromptMs)} since prompt`;
	}
	if (row.partial) s += " · partial";
	return s;
}
