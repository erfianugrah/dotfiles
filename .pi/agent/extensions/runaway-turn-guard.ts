/**
 * runaway-turn-guard - make a long-running turn VISIBLE, and cap the
 * pathological end of the distribution.
 *
 * Motivating incident (2026-08-27): a kimi-k3 turn ran 9m47s streaming a
 * degenerate loop and the user's own words were "I didn't know till I
 * cancelled it cause it was taking too long". Two separate failures:
 *   1. degenerate-stream-guard missed that shape (newline-separated loop) -
 *      fixed in lib/degenerate-core.ts (findLineCollapse).
 *   2. NOTHING told the user a turn had been running for ten minutes.
 *
 * (2) is the general problem and the reason this exists. Repetition detection
 * is a whitelist of known-bad shapes and will always miss the next novel
 * failure; elapsed time and output volume are shape-independent.
 *
 * Default posture is VISIBILITY, not killing - the user explicitly asked for
 * no false positives. A long turn is usually legitimate (big refactor, slow
 * provider, a 230k-token prefill is minutes of silence before token one), so:
 *   - after PI_RUNAWAY_WARN_S (120s) a live footer/widget shows elapsed time,
 *     output volume and tool-call count;
 *   - a hard time abort is OPT-IN (PI_RUNAWAY_ABORT_S, default 0 = off);
 *   - the only enabled-by-default kill is the absurd-volume ceiling
 *     (PI_RUNAWAY_MAX_CHARS, 250k chars in ONE turn), which no useful answer
 *     reaches and which catches collapse modes no detector recognises.
 *
 * Decision logic is pure and unit-tested in lib/runaway-turn-core.ts.
 *
 * Env:
 *   PI_RUNAWAY_GUARD_OFF=1    disable entirely
 *   PI_RUNAWAY_WARN_S=<sec>   indicator threshold (default 120, 0 = never)
 *   PI_RUNAWAY_ABORT_S=<sec>  hard time abort (default 0 = disabled)
 *   PI_RUNAWAY_MAX_CHARS=<n>  volume abort (default 250000, 0 = disabled)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	abortMessage,
	decide,
	freshState,
	indicatorText,
	loadConfig,
	type RunawayState,
} from "./lib/runaway-turn-core.ts";

const STATUS_SLOT = "runaway-turn";
const TICK_MS = 1000;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_RUNAWAY_GUARD_OFF === "1") return;

	const cfg = loadConfig(process.env);
	let state: RunawayState = freshState();
	let timer: ReturnType<typeof setInterval> | undefined;

	const clearUi = (ctx: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_SLOT, "");
		} catch {
			// ctx can outlive a reloaded session (assertActive); nothing to clean.
		}
	};

	const tick = (ctx: ExtensionContext) => {
		const action = decide(state, cfg, Date.now());
		if (action.kind === "none") return;

		if (action.kind === "warn") {
			state.warned = true;
			try {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_SLOT, indicatorText(action));
			} catch {
				/* stale ctx */
			}
			return;
		}

		// abort
		state.aborted = true;
		clearUi(ctx);
		try {
			ctx.ui.notify(abortMessage(action), "warning");
		} catch {
			/* headless: notify is a no-op */
		}
		try {
			ctx.abort();
		} catch {
			/* already settled */
		}
	};

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		state = freshState();
		state.startedAt = Date.now();
		clearUi(ctx);
		// Poll rather than compute on deltas: a STALLED stream emits no deltas
		// at all, and that is exactly the case a delta-driven check cannot see.
		timer = setInterval(() => tick(ctx), TICK_MS);
		if (typeof timer.unref === "function") timer.unref();
	});

	pi.on("message_update", async (event) => {
		const e = event.assistantMessageEvent as
			| { type?: string; delta?: string }
			| undefined;
		if (!e?.delta) return;
		if (e.type !== "thinking_delta" && e.type !== "text_delta") return;
		state.chars += e.delta.length;
	});

	pi.on("tool_call", async () => {
		state.toolCalls++;
		return undefined;
	});

	pi.on("message_end", async (_event, ctx) => {
		state.startedAt = 0;
		clearUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.startedAt = 0;
		clearUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state = freshState();
		clearUi(ctx);
	});
}
