// .pi/agent/extensions/lib/repeat-tool-core.ts
/**
 * repeat-tool-guard core - pure chain + reminder logic.
 *
 * Port of deepseek-harness packages/guard/repeat-tool-reminder. Chain key is
 * (tool name, canonical arguments); canonicalization is a deep key-sort plus
 * JSON.stringify, so property-order differences count as identical.
 * Excluded tools are TRANSPARENT to the chain (neither increment nor reset)
 * so interleaved bookkeeping cannot launder a loop.
 */

export interface ChainConfig {
	/** Ascending consecutive-call counts that trigger a reminder. */
	thresholds: number[];
	/** Tool names transparent to the chain. */
	exclude: Set<string>;
	/** Cap on the arguments quoted in the detailed reminder. */
	argumentsPreviewChars: number;
}

export interface Chain {
	lastKey: string | null;
	count: number;
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, val]) => [k, sortKeys(val)]),
		);
	}
	return v;
}

export function canonicalize(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

/**
 * Record one call. Returns "transparent" for excluded tools (chain
 * untouched), otherwise the new consecutive count.
 */
export function track(
	chain: Chain,
	toolName: string,
	args: unknown,
	cfg: ChainConfig,
): number | "transparent" {
	if (cfg.exclude.has(toolName)) return "transparent";
	const key = `${toolName} ${canonicalize(args)}`;
	if (key === chain.lastKey) {
		chain.count += 1;
	} else {
		chain.lastKey = key;
		chain.count = 1;
	}
	return chain.count;
}

const SHORT_NUDGE =
	"You are repeating the exact same tool call with identical arguments. " +
	"Carefully analyze the previous result before calling again: if the " +
	"task is not complete, try a different approach or different arguments " +
	"instead of repeating the call.";

/** Reminder text for a threshold hit, or null. Fires only at exact counts. */
export function reminderFor(
	toolName: string,
	args: unknown,
	count: number,
	cfg: ChainConfig,
): string | null {
	if (!cfg.thresholds.includes(count)) return null;
	if (count === cfg.thresholds[0]) return SHORT_NUDGE;

	const canonical = canonicalize(args);
	let preview = canonical;
	if (canonical.length > cfg.argumentsPreviewChars) {
		preview =
			canonical.slice(0, cfg.argumentsPreviewChars) +
			` (+${canonical.length - cfg.argumentsPreviewChars} more chars)`;
	}
	return (
		"Repeated tool call detected:\n" +
		`- tool: ${toolName}\n` +
		`- consecutive_calls: ${count}\n` +
		`- arguments: ${preview}\n` +
		"The repeated calls are not making progress. Do not call this tool " +
		"with these exact arguments again. Inspect the latest result and " +
		"choose a different action, different arguments, or finish the task " +
		"if enough evidence has been gathered."
	);
}

/** Parse "3,5,8" into ascending validated thresholds. Throws on bad input. */
export function parseThresholds(raw: string): number[] {
	const parts = raw.split(",").map((s) => s.trim());
	if (parts.length === 0 || parts.some((p) => p === "")) {
		throw new Error("thresholds: empty list");
	}
	const nums = parts.map((p) => {
		const n = Number(p);
		if (!Number.isInteger(n) || n < 2) {
			throw new Error(`thresholds: bad value ${p}`);
		}
		return n;
	});
	if (new Set(nums).size !== nums.length) {
		throw new Error("thresholds: duplicates");
	}
	return nums.sort((a, b) => a - b);
}
