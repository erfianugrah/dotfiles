/**
 * llm-metrics - live inference stats for the local engine.
 *
 * Tracks every assistant request in the session (decode tok/s, prompt
 * context, prefix-cache hit, TTFT) from message lifecycle events, so the
 * numbers work against any provider. When the active model is on the local
 * llama-server provider it additionally parses `docker logs ninfer_server`
 * for MTP acceptance and engine errors - the two signals only the engine
 * sees.
 *
 * Surfaces:
 *   - a one-line widget above the editor while the local engine is active:
 *       llm 63 req | p50 125.7 tok/s | cache 99.7% | ttft 176-409ms | mtp ~54%
 *   - /llm-stats          full table for the current provider filter
 *   - /llm-stats all      table across all providers this session
 *   - /llm-stats reset    clear the session stats
 *
 * Widget can be hidden: /llm-stats widget off (on to re-show).
 * No private APIs; per-turn cost is one event handler + at most one cached
 * docker-logs exec per ENGINE_REFRESH_MS.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ReqStat,
	fmtK,
	fmtNum,
	summarize,
	summarizeEngineLog,
} from "./lib/llm-metrics-core.ts";

const WIDGET_SLOT = "llm-metrics";
const ENGINE_CONTAINER = "ninfer_server";
// alias: llama-server (pre-2026-09-08 name)
const LOCAL_PROVIDER = "llmc";
const ENGINE_REFRESH_MS = 60_000;
/** Cap so a month-long session does not grow the array without bound. */
const MAX_REQS = 2000;

interface EngineStats {
	fetchedAt: number;
	mtpPctMedian: number;
	errors: number;
}

interface PendingReq {
	provider: string;
	modelId: string;
	startMs: number;
	firstUpdateMs: number | undefined;
}

export default function (pi: ExtensionAPI) {
	const reqs: ReqStat[] = [];
	let pending: PendingReq | undefined;
	let engine: EngineStats | undefined;
	let widgetEnabled = true;

	function currentProvider(ctx: ExtensionContext): { provider: string; modelId: string } {
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		return { provider: model?.provider ?? "unknown", modelId: model?.id ?? "unknown" };
	}

	async function refreshEngine(piRef: ExtensionAPI, cwd: string): Promise<void> {
		if (engine && Date.now() - engine.fetchedAt < ENGINE_REFRESH_MS) return;
		try {
			const res = await piRef.exec(
				"docker",
				["logs", "--since", "6h", ENGINE_CONTAINER],
				{ cwd, timeout: 10_000 },
			);
			if (res.code !== 0) return;
			const s = summarizeEngineLog(`${res.stdout}\n${res.stderr}`);
			engine = { fetchedAt: Date.now(), mtpPctMedian: s.mtpPctMedian, errors: s.errors };
		} catch {
			/* docker unavailable - engine rows stay hidden */
		}
	}

	function paintWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const { provider } = currentProvider(ctx);
		const mine = reqs.filter((r) => r.provider === provider);
		if (!widgetEnabled || mine.length === 0) {
			ctx.ui.setWidget(WIDGET_SLOT, []);
			return;
		}
		const s = summarize(mine);
		const theme = ctx.ui.theme;
		const parts = [
			`${provider} ${s.n} req`,
			`p50 ${s.decP50.toFixed(1)} tok/s`,
			`cache ${s.cacheP50.toFixed(1)}%`,
		];
		// TTFT only shown for the local provider: cloud gateways buffer, so the
		// first message_update arrives near-instantly and the number is noise.
		if (provider === LOCAL_PROVIDER) {
			parts.push(`ttft ${Math.round(s.ttftMin)}-${Math.round(s.ttftMax)}ms`);
		}
		if (provider === LOCAL_PROVIDER && engine && !Number.isNaN(engine.mtpPctMedian)) {
			parts.push(`mtp ~${engine.mtpPctMedian.toFixed(0)}%`);
		}
		if (provider === LOCAL_PROVIDER && engine && engine.errors > 0) {
			parts.push(theme.fg("error", `errors ${engine.errors}`));
		}
		ctx.ui.setWidget(WIDGET_SLOT, [theme.fg("dim", parts.join(" | "))], {
			placement: "belowEditor",
		});
	}

	function formatTable(reqList: ReqStat[], label: string, withEngine: boolean): string {
		if (reqList.length === 0) return `no requests recorded yet (${label})`;
		const s = summarize(reqList);
		const lines = [
			`${label} (${s.n} request${s.n === 1 ? "" : "s"})`,
			`decode p5 / p50 / p95   ${s.decP5.toFixed(1)} / ${s.decP50.toFixed(1)} / ${s.decP95.toFixed(1)} tok/s`,
			`prompt context          p50 ${fmtK(s.ctxP50)}, max ${fmtNum(s.ctxMax)} tokens`,
			`prefix-cache hit        p50 ${s.cacheP50.toFixed(1)}%`,
		];
		if (withEngine) lines.push(`TTFT                    ${Math.round(s.ttftMin)}-${Math.round(s.ttftMax)} ms`);
		lines.push(`below 100 tok/s         ${s.below100} of ${s.n} (${((100 * s.below100) / s.n).toFixed(1)}%)`);
		if (withEngine) {
			if (engine) {
				lines.push(
					`MTP acceptance          ~${Number.isNaN(engine.mtpPctMedian) ? "?" : engine.mtpPctMedian.toFixed(0)}% median`,
					`engine errors           ${engine.errors}`,
				);
			} else {
				lines.push("MTP acceptance          (engine log unavailable)");
			}
		}
		return lines.join("\n");
	}

	pi.on("message_start", async (event, ctx) => {
		const msg = event.message as { role?: string };
		if (msg.role !== "assistant") return;
		const { provider, modelId } = currentProvider(ctx);
		pending = { provider, modelId, startMs: Date.now(), firstUpdateMs: undefined };
	});

	pi.on("message_update", async (event, ctx) => {
		const msg = event.message as { role?: string };
		if (msg.role !== "assistant" || !pending || pending.firstUpdateMs !== undefined) return;
		pending.firstUpdateMs = Date.now();
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message as {
			role?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (msg.role !== "assistant" || !msg.usage || !pending) return;
		const endMs = Date.now();
		const u = msg.usage;
		const input = u.input ?? 0;
		const cacheRead = u.cacheRead ?? 0;
		const cacheWrite = u.cacheWrite ?? 0;
		const prompt = input + cacheRead + cacheWrite;
		const output = u.output ?? 0;
		const firstMs = pending.firstUpdateMs ?? pending.startMs;
		const decodeMs = Math.max(endMs - firstMs, 1);
		reqs.push({
			ts: endMs,
			prompt,
			output,
			cacheHit: prompt > 0 ? cacheRead / prompt : 0,
			ttftMs: Math.max(firstMs - pending.startMs, 0),
			decodeTokS: (output / decodeMs) * 1000,
			provider: pending.provider,
			modelId: pending.modelId,
		});
		if (reqs.length > MAX_REQS) reqs.splice(0, reqs.length - MAX_REQS);
		pending = undefined;
		if (currentProvider(ctx).provider === LOCAL_PROVIDER) {
			void refreshEngine(pi, ctx.cwd).then(() => paintWidget(ctx));
		}
		paintWidget(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		paintWidget(ctx);
	});

	pi.registerCommand("llm-stats", {
		description: "Live inference stats (decode tok/s, cache hit, TTFT, MTP) + widget on|off|reset",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = args.trim().toLowerCase();
			if (arg === "reset") {
				reqs.length = 0;
				engine = undefined;
				paintWidget(ctx);
				ctx.ui.notify("llm-metrics: session stats cleared", "info");
				return;
			}
			if (arg === "widget on" || arg === "widget off") {
				widgetEnabled = arg === "widget on";
				paintWidget(ctx);
				ctx.ui.notify(`llm-metrics: widget ${widgetEnabled ? "on" : "off"}`, "info");
				return;
			}
			const { provider, modelId } = currentProvider(ctx);
			const isLocal = provider === LOCAL_PROVIDER;
			if (isLocal) await refreshEngine(pi, ctx.cwd);
			if (arg === "all") {
				ctx.ui.notify(formatTable(reqs, "session (all providers)", isLocal), "info");
				return;
			}
			const mine = reqs.filter((r) => r.provider === provider);
			ctx.ui.notify(formatTable(mine, `${provider}/${modelId}`, isLocal), "info");
		},
	});
}
