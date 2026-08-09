/**
 * tool-activity - live "Working..." message in the TUI while any tool is running.
 *
 * Pi's default UX shows no indication that a tool call is in progress - the
 * user sees a blank compose area for the duration of the call. This extension
 * listens to tool_execution_start / tool_execution_end, tracks all active tools,
 * and once per second updates the working message via ctx.ui.setWorkingMessage()
 * with a summary of what's running and for how long.
 *
 * When no tools are active (and on agent_settled / session_shutdown), the
 * working message is restored to pi's default via a no-args setWorkingMessage()
 * call. All UI calls are guarded with ctx.hasUI.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { summarizeToolArgs, formatElapsed } from "./lib/tool-label.js";

// ---------------------------------------------------------------------------
// Tracker (tested by loop-activity.test.ts)
// ---------------------------------------------------------------------------

interface ActiveTool {
	toolName: string;
	args: unknown;
	started: number;
}

/**
 * Tracks currently-running tools and produces a one-line summary.
 *
 * `now` is an injectable clock (ms) defaulting to Date.now for test determinism.
 */
export function createToolActivity(now?: () => number) {
	const clock = now ?? (() => Date.now());
	const tools = new Map<string, ActiveTool>();

	return {
		start(id: string, toolName: string, args: unknown): void {
			tools.set(id, { toolName, args, started: clock() });
		},

		end(id: string): void {
			tools.delete(id);
		},

		/**
		 * One-line summary of active tools, or null when idle.
		 *
		 * Names the longest-running tool with elapsed time, plus "+N more"
		 * when additional tools are running.
		 */
		summaryLine(): string | null {
			if (tools.size === 0) return null;

			const entries = [...tools.entries()];
			const now = clock();

			// Find the longest-running tool.
			let longest: ActiveTool | null = null;
			let longestElapsed = 0;
			for (const [, t] of entries) {
				const elapsed = now - t.started;
				if (!longest || elapsed > longestElapsed) {
					longest = t;
					longestElapsed = elapsed;
				}
			}
			if (!longest) return null;

			const label = summarizeToolArgs(longest.toolName, longest.args);
			const elapsed = formatElapsed(longestElapsed);
			let line = `Working... ${longest.toolName} ${label} · ${elapsed}`;
			if (entries.length > 1) {
				line += ` · +${entries.length - 1} more`;
			}
			return line;
		},
	};
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let ctx: ExtensionContext | undefined;
	const activity = createToolActivity();

	const tick = () => {
		if (!ctx?.hasUI) return;
		const line = activity.summaryLine();
		if (line) {
			ctx.ui.setWorkingMessage(line);
		} else if (timer) {
			// No tools active anymore - restore the default and stop.
			ctx.ui.setWorkingMessage();
			clearInterval(timer);
			timer = undefined;
		}
	};

	const stop = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx?.hasUI) {
			ctx.ui.setWorkingMessage();
		}
	};

	pi.on("tool_execution_start", (event, extCtx) => {
		ctx = extCtx;
		activity.start(event.toolCallId, event.toolName, event.args);
		if (!timer) {
			tick(); // Immediate first update.
			timer = setInterval(tick, 1000);
		}
	});

	pi.on("tool_execution_end", (event, extCtx) => {
		ctx = extCtx;
		activity.end(event.toolCallId);
	});

	pi.on("agent_settled", (_event, extCtx) => {
		ctx = extCtx;
		stop();
	});

	pi.on("session_shutdown", (_event, extCtx) => {
		ctx = extCtx;
		stop();
	});
}
