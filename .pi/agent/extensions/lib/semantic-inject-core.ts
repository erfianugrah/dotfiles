/**
 * semantic-inject-core - pure decision + fetch logic for semantic retrieval
 * injection at first substantive user message.
 *
 * The gap this closes (ruflo eval 2026-08-31): session-ledger injects a
 * project-scoped FTS brief at session_start, but nothing retrieves content
 * semantically relevant to the TASK the user just described. Ruflo's hooks
 * embed the user prompt and pull similar past trajectories; ours only nags
 * the model to search (history-first) after the fact. This module is the
 * push path: given the first substantive user message, query memledger's
 * pgvector endpoint, and render a compact block for injection.
 *
 * Design:
 *   - Pure decision logic (decideInject) + injectable fetch (fetchSemanticHits)
 *     so pi adapter and CC hook run identical code and tests need no network.
 *   - Fires exactly ONCE per session (pi: per-session state; CC: transcript
 *     scan for the marker). A one-shot injection can't loop.
 *   - Gated on isSubstantive (shared with history-first) so "hi" / "continue"
 *     / resumes don't produce garbage embeddings.
 *   - Degrades silently: any fetch error / timeout / empty result = no
 *     injection. The existing FTS brief + history-first nag still cover it.
 *
 * Kill switches: PI_SEMANTIC_INJECT_OFF=1 (pi), SEMANTIC_INJECT_OFF=1 (CC).
 */

import { isSubstantive } from "./history-first-core.ts";

/** Marker on the injected block; CC hook scans the transcript for it. */
export const SEMANTIC_INJECT_MARKER = "[semantic-inject]";

export const SEMANTIC_INJECT_HEADER = `${SEMANTIC_INJECT_MARKER} Semantically related prior sessions (harness-injected, not the user):`;

export const SEMANTIC_INJECT_FOOTER =
	"Treat as possibly-stale leads: verify against live state before acting. Drill in with memledger_search / session_search.";

/** Hard floor on cosine similarity - below this, hits are noise. */
export const MIN_SIMILARITY = 0.55;

/** Max hits in the injected block. */
export const MAX_HITS = 3;

/** Per-hit text cap (chars) - enough to judge relevance, not to quote. */
export const HIT_TEXT_MAX = 220;

export interface SemanticHitInput {
	session_key?: string;
	ordinal?: number;
	text: string;
	similarity: number;
}

export interface SemanticInjectState {
	/** True once the injection has fired (or been permanently skipped). */
	done: boolean;
}

export function freshSemanticState(): SemanticInjectState {
	return { done: false };
}

/** Render the injection block from filtered hits. "" when nothing worth showing. */
export function buildSemanticBlock(hits: SemanticHitInput[]): string {
	const kept = hits
		.filter((h) => h.similarity >= MIN_SIMILARITY)
		// Model-internal blobs and tool-call echoes retrieve well but read as
		// noise in a briefing; prefer message prose.
		.filter((h) => !/^\[(thinking|tool_call|tool_result)\b/.test(h.text.trim()))
		.slice(0, MAX_HITS);
	if (kept.length === 0) return "";
	const lines = kept.map((h) => {
		const where = h.session_key ? `${h.session_key}${h.ordinal != null ? `#${h.ordinal}` : ""}` : "";
		const text = h.text.replace(/\s+/g, " ").trim().slice(0, HIT_TEXT_MAX);
		return `- ${h.similarity.toFixed(2)} ${where} | ${text}`;
	});
	return `${SEMANTIC_INJECT_HEADER}\n${lines.join("\n")}\n${SEMANTIC_INJECT_FOOTER}`;
}

/**
 * Query the memledger semantic endpoint. Injectable fetch for tests.
 * Returns parsed hits; throws on network/HTTP failure (caller degrades).
 */
export async function fetchSemanticHits(
	query: string,
	opts: {
		baseUrl?: string;
		limit?: number;
		timeoutMs?: number;
		selfSession?: string;
		fetchFn?: typeof fetch;
	} = {},
): Promise<SemanticHitInput[]> {
	const base = opts.baseUrl ?? "https://memledger.erfi.io";
	const limit = opts.limit ?? 5;
	const timeout = opts.timeoutMs ?? 2500;
	const doFetch = opts.fetchFn ?? fetch;
	const url = `${base}/semantic/search?q=${encodeURIComponent(query)}&kind=messages&limit=${limit}`;
	const resp = await doFetch(url, { signal: AbortSignal.timeout(timeout) } as RequestInit);
	if (!resp.ok) throw new Error(`semantic HTTP ${resp.status}`);
	const data = (await resp.json()) as { results?: SemanticHitInput[] };
	let results = data.results ?? [];
	// The querying session's own synthesis text is semantically closest to
	// its query - exclude it (same self-exclusion as the pull tool).
	if (opts.selfSession) results = results.filter((r) => r.session_key !== opts.selfSession);
	return results;
}

/**
 * Decide whether to inject on this turn.
 * Returns the block string to inject, or undefined (skip / already done).
 * Mutates state.done when it fires or permanently skips.
 *
 * `userTexts` = text content of user-role messages in the context, oldest first.
 */
export async function decideInject(
	state: SemanticInjectState,
	userTexts: string[],
	opts: {
		baseUrl?: string;
		timeoutMs?: number;
		selfSession?: string;
		fetchFn?: typeof fetch;
	} = {},
): Promise<string | undefined> {
	if (state.done) return undefined;

	// Anchor on the FIRST substantive user message - that's the task brief.
	// Later turns are the model's own follow-ups, not new task context.
	const anchor = userTexts.find((t) => isSubstantive(t));
	if (!anchor) return undefined; // no task yet; keep waiting (not done)

	state.done = true; // one-shot: fire or fail, never retry in this session

	try {
		const hits = await fetchSemanticHits(anchor.slice(0, 500), opts);
		return buildSemanticBlock(hits) || undefined;
	} catch {
		return undefined; // degrade silently
	}
}
