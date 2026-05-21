/**
 * compaction-progress — visible feedback during /compact and auto-compaction.
 *
 * Pi already runs an LLM call in the background when compacting, but the TUI
 * shows nothing until the compaction entry lands. For a 850k-token session that
 * is ~30-60s of silence. This extension surfaces:
 *
 *   - A spinning footer status: "compacting 850k → …"
 *   - A widget above the editor with elapsed seconds + source token count.
 *   - A toast on completion: "compacted 850k → 12k in 38s".
 *
 * Implementation uses pi's documented compaction events
 * (session_before_compact / session_compact). No private APIs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_SLOT = "compaction-progress";
const WIDGET_SLOT = "compaction-progress";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function humanTokens(n: number | undefined): string {
	if (!n || !Number.isFinite(n)) return "?";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

export default function (pi: ExtensionAPI) {
	let timer: NodeJS.Timeout | undefined;
	let frame = 0;
	let startedAt = 0;
	let tokensBefore: number | undefined;

	const clear = (ctx: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_SLOT, "");
			ctx.ui.setWidget(WIDGET_SLOT, []);
		}
	};

	const tick = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const spinner = theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!);
		frame++;
		const elapsed = Math.floor((Date.now() - startedAt) / 1000);
		const from = humanTokens(tokensBefore);
		ctx.ui.setStatus(STATUS_SLOT, `${spinner} ${theme.fg("dim", `compacting ${from} • ${elapsed}s`)}`);
		ctx.ui.setWidget(WIDGET_SLOT, [
			`${spinner} Compacting session`,
			theme.fg("dim", `  from ${from} tokens • elapsed ${elapsed}s`),
			theme.fg("dim", "  summarizing older turns, recent turns kept verbatim"),
		]);
	};

	pi.on("session_before_compact", async (event, ctx) => {
		startedAt = Date.now();
		tokensBefore = event.preparation?.tokensBefore;
		frame = 0;
		if (ctx.hasUI) tick(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => tick(ctx), 120);
		// Do not return anything — let pi's default compaction run.
	});

	pi.on("session_compact", async (event, ctx) => {
		const elapsed = Math.floor((Date.now() - startedAt) / 1000);
		const before = humanTokens(event.compactionEntry?.tokensBefore ?? tokensBefore);
		const summaryLen = event.compactionEntry?.summary?.length ?? 0;
		const after = summaryLen > 0 ? `~${humanTokens(Math.round(summaryLen / 4))}` : "?";
		clear(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Compacted ${before} → ${after} in ${elapsed}s`, "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clear(ctx);
	});
}
