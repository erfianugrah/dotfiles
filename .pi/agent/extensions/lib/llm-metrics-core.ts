/**
 * llm-metrics-core - pure helpers for the llm-metrics extension.
 *
 * Per-request stats (decode tok/s, prompt context, prefix-cache hit, TTFT)
 * are computed pi-side from message lifecycle events, so they work against
 * any provider. MTP acceptance and engine-error counts only exist in the
 * ninfer_server container's log lines, parsed here.
 */

export interface ReqStat {
	/** ms epoch at message_end */
	ts: number;
	/** input + cacheRead + cacheWrite */
	prompt: number;
	output: number;
	/** cacheRead / prompt, 0..1 */
	cacheHit: number;
	ttftMs: number;
	decodeTokS: number;
	provider: string;
	modelId: string;
}

/** Nearest-rank percentile of a presorted-or-not array. NaN on empty. */
export function percentile(values: number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(Math.floor(s.length * p), s.length - 1)]!;
}

const ENGINE_DONE_RE =
	/req#\d+ done\b.*?\| decode ([\d.]+) tok\/s \| mtp accepted (\d+)\/(\d+) \(([\d.]+)%\)/;

/** Parse one ninfer_server `req#N done` log line; null when it does not match. */
export function parseEngineLine(
	line: string,
): { decode: number; mtpAccepted: number; mtpTotal: number; mtpPct: number } | null {
	const m = ENGINE_DONE_RE.exec(line);
	if (!m) return null;
	return {
		decode: Number(m[1]),
		mtpAccepted: Number(m[2]),
		mtpTotal: Number(m[3]),
		mtpPct: Number(m[4]),
	};
}

/** Fold a docker-logs dump into MTP + error aggregates. */
export function summarizeEngineLog(log: string): {
	requests: number;
	mtpPctMedian: number;
	errors: number;
} {
	const mtpPcts: number[] = [];
	let errors = 0;
	for (const line of log.split("\n")) {
		const parsed = parseEngineLine(line);
		if (parsed) mtpPcts.push(parsed.mtpPct);
		else if (/error|panic|cuda failure/i.test(line)) errors++;
	}
	return {
		requests: mtpPcts.length,
		mtpPctMedian: mtpPcts.length ? percentile(mtpPcts, 0.5) : Number.NaN,
		errors,
	};
}

export function fmtK(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
}

export function fmtNum(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

/** Aggregate pi-side request stats into the report rows. */
export function summarize(reqs: ReqStat[]): {
	n: number;
	decP5: number;
	decP50: number;
	decP95: number;
	ctxP50: number;
	ctxMax: number;
	cacheP50: number;
	ttftMin: number;
	ttftMax: number;
	below100: number;
} {
	const dec = reqs.map((r) => r.decodeTokS);
	const ctx = reqs.map((r) => r.prompt);
	const cache = reqs.map((r) => r.cacheHit * 100);
	const ttft = reqs.map((r) => r.ttftMs);
	return {
		n: reqs.length,
		decP5: percentile(dec, 0.05),
		decP50: percentile(dec, 0.5),
		decP95: percentile(dec, 0.95),
		ctxP50: percentile(ctx, 0.5),
		ctxMax: ctx.length ? Math.max(...ctx) : 0,
		cacheP50: percentile(cache, 0.5),
		ttftMin: ttft.length ? Math.min(...ttft) : 0,
		ttftMax: ttft.length ? Math.max(...ttft) : 0,
		below100: dec.filter((d) => d < 100).length,
	};
}
