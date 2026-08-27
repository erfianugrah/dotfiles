/**
 * degenerate-stream-guard - auto-abort a turn whose model output collapses
 * into endless repetition, instead of burning tokens and filling the TUI
 * until the user notices and hits Esc.
 *
 * Motivating incident (2026-08-19): moonshotai/kimi-k3 via OpenRouter
 * collapsed on the thinking channel twice in one morning, streaming pure
 * "!" (112 and 1207 chars, both manually aborted). Pi renders the thinking
 * stream live, so the screen filled with rows of "!". Provider-side failure;
 * this guard is the client-side containment.
 *
 * SECOND incident (2026-08-27) - why this now uses findCollapse: kimi-k3
 * streamed "   <U+FFFD>" + blank line for ~10 MINUTES, twice, and this guard
 * did NOT fire. findPeriodCollapse bails out on any newline in the tail (a
 * deliberate choice to protect wide markdown tables), which made it blind to
 * every newline-separated loop - the user only found out by cancelling a turn
 * that felt too slow. findCollapse() adds a line-cycle detector for that mode.
 *
 * Mechanism: message_update carries the token-by-token stream
 * (event.assistantMessageEvent thinking_delta / text_delta). Deltas are
 * accumulated into a rolling buffer; findCollapse() (lib/degenerate-core.ts)
 * judges whether the tail is one short unit repeated - either as chars on one
 * line, or as a repeating block of lines. On trip: ctx.abort() + a warning
 * notification. No auto-retry - retry loops would burn money against a
 * provider node that may serve the same degenerate stream again.
 *
 * Env:
 *   PI_DEGENERATE_GUARD_OFF=1   disable entirely.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findCollapse } from "./lib/degenerate-core.ts";

// Must hold enough LINES for the line-cycle detector (LINE_WINDOW=140 lines,
// MIN_LINE_REPEATS=30). 500 chars only covered the single-line char detector.
const BUF_CAP = 8000;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_DEGENERATE_GUARD_OFF === "1") return;

	let buf = "";
	let tripped = false;

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			buf = "";
			tripped = false;
		}
	});

	pi.on("message_update", async (event, ctx) => {
		if (tripped) return;
		const e = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
		if (!e || (e.type !== "thinking_delta" && e.type !== "text_delta") || !e.delta) return;

		buf = (buf + e.delta).slice(-BUF_CAP);
		const hit = findCollapse(buf);
		if (!hit) return;

		tripped = true;
		const repeats = Math.floor(hit.inspected / hit.period);
		ctx.ui.notify(
			`degenerate-stream-guard: repetition collapse (${JSON.stringify(hit.unit)} x${repeats}) - aborted the turn. Retry, or switch provider/model.`,
			"warning",
		);
		ctx.abort();
	});
}
