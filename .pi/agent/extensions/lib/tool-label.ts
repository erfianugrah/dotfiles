/**
 * tool-label - shared helpers for human-readable tool-call labels and elapsed-time
 * formatting. Used by both task.ts (subagent progress streaming) and
 * tool-activity.ts (live working-message updates).
 *
 * These are pure functions with no pi SDK dependency - importable from tests
 * without stubs. They live under lib/ (not a loose top-level .ts) so pi's
 * extension loader skips them; only the two consuming extensions register
 * with pi.
 */

/**
 * One-line human label for a tool call. Known tools surface their key argument;
 * unknown tools fall back to the bare tool name. Labels longer than 63 chars
 * are truncated with a "..." suffix.
 */
export function summarizeToolArgs(toolName: string, args: unknown): string {
	const key = KEY_ARGS[toolName];
	let label: string;
	if (key && args && typeof args === "object" && key in args) {
		label = String((args as Record<string, unknown>)[key] ?? toolName);
	} else {
		label = toolName;
	}
	if (label.length > 63) {
		label = label.slice(0, 60) + "...";
	}
	return label;
}

/**
 * Human-readable elapsed time from milliseconds.
 *
 *   0..59_999        -> "0s"  .. "59s"
 *   60_000..3_599_999 -> "1m00s" .. "59m59s"
 *   >= 3_600_000       -> "1h00m" .. "NhMMm"
 */
export function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) {
		return `${h}h${String(m).padStart(2, "0")}m`;
	}
	if (m > 0) {
		return `${m}m${String(s).padStart(2, "0")}s`;
	}
	return `${s}s`;
}

/** Which argument key to surface per tool name. */
const KEY_ARGS: Record<string, string> = {
	bash: "command",
	read: "path",
	edit: "path",
	write: "path",
	grep: "pattern",
	webfetch: "url",
	websearch: "query",
	task: "description",
	bg_task: "description",
};
