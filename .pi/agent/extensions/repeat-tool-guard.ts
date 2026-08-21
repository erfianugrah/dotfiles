// .pi/agent/extensions/repeat-tool-guard.ts
/**
 * repeat-tool-guard - advisory loop-breaker for consecutive identical
 * tool calls. Port of deepseek-harness packages/guard/repeat-tool-reminder.
 *
 * Never blocks, never rewrites a call: at thresholds (default 3/5/8) it
 * appends an escalating advisory text part to the tool result. The decision
 * - retry differently, gather more evidence, or finish - stays with the
 * model. Complements tool-guard's checkReformulationLoop (which only covers
 * search-tools-without-drill-in) and degenerate-stream-guard (which covers
 * provider-side output collapse, not tool-call loops).
 *
 * Semantics (matching dsh):
 *   - Chain key = (tool name, deep-key-sorted canonical arguments).
 *   - Excluded tools are transparent: they neither increment nor reset the
 *     chain, so interleaved bookkeeping cannot launder a loop.
 *   - Counting happens on tool_call, so calls blocked by other guards
 *     still count (a model hammering a denied call is the loop worth
 *     breaking).
 *   - Delivery happens on tool_result via content-append; pending
 *     reminders flush on the next result even if the exact toolCallId
 *     never produces one (covers the blocked-call case: a blocked
 *     tool_call emits no tool_result in pi).
 *   - A user message resets the chain.
 *
 * Env:
 *   PI_REPEAT_GUARD_OFF=1          disable
 *   PI_REPEAT_THRESHOLDS="3,5,8"   consecutive counts that fire
 *   PI_REPEAT_EXCLUDE="a,b"        override the default transparent set
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseThresholds,
	reminderFor,
	track,
	type Chain,
	type ChainConfig,
} from "./lib/repeat-tool-core.ts";

const OFF = process.env.PI_REPEAT_GUARD_OFF === "1";

const DEFAULT_EXCLUDE = [
	"todowrite",
	"question",
	"wait_job",
	"research_wait_job",
	"bg_wait",
	"bg_status",
	"bg_list",
];

const MARKER = "[repeat-tool-guard] ";

function loadConfig(): ChainConfig {
	return {
		thresholds: parseThresholds(process.env.PI_REPEAT_THRESHOLDS ?? "3,5,8"),
		exclude: new Set(
			process.env.PI_REPEAT_EXCLUDE
				? process.env.PI_REPEAT_EXCLUDE.split(",").map((s) => s.trim())
				: DEFAULT_EXCLUDE,
		),
		argumentsPreviewChars: 500,
	};
}

export default function (pi: ExtensionAPI) {
	if (OFF) return;
	const cfg = loadConfig();
	const chain: Chain = { lastKey: null, count: 0 };
	const pending = new Map<string, string>(); // toolCallId -> reminder

	pi.on("tool_call", async (event) => {
		const count = track(chain, event.toolName, event.input, cfg);
		if (count === "transparent") return;
		const reminder = reminderFor(event.toolName, event.input, count, cfg);
		if (reminder) pending.set(event.toolCallId, reminder);
	});

	pi.on("tool_result", async (event) => {
		if (pending.size === 0) return;
		const notes: string[] = [];
		const exact = pending.get(event.toolCallId);
		if (exact) {
			notes.push(exact);
			pending.delete(event.toolCallId);
		}
		// Flush reminders whose call never produced a matching result
		// (blocked calls emit no tool_result in pi).
		for (const [, r] of pending) notes.push(r);
		pending.clear();
		if (notes.length === 0) return;

		const extra = notes.map((n) => ({ type: "text" as const, text: MARKER + n }));
		const content = event.content;
		if (Array.isArray(content)) {
			return { content: [...content, ...extra] };
		}
		return {
			content: [
				{ type: "text" as const, text: String(content ?? "") },
				...extra,
			],
		};
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			chain.lastKey = null;
			chain.count = 0;
			pending.clear();
		}
	});
}
