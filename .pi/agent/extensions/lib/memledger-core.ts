/**
 * memledger-core - pure helpers for the memledger_search extension tool.
 * No pi imports here so bun tests can load this file directly.
 */

export type SearchKind = "messages" | "ledger" | "memories" | "sessions" | "semantic";

const DEFAULT_BASE = "https://memledger.erfi.io";

export function baseUrl(): string {
  return (typeof process !== "undefined" && process.env?.MEMLEDGER_URL) || DEFAULT_BASE;
}

/**
 * Postgres websearch_to_tsquery understands quoted phrases, OR, and
 * -negation, but NOT the FTS5-style AND/NOT operators - pass user queries
 * through toOrQuery first so multi-word searches keep auto-OR semantics.
 */
export function toOrQuery(input: string): string {
  const trimmed = input.trim();
  if (/\b(OR|AND|NOT)\b|[*"-]/.test(trimmed)) return trimmed;
  const tokens = trimmed.split(/[\s\-_./\\:]+/).filter(Boolean);
  return Array.from(new Set(tokens)).join(" OR ");
}

/** PostgREST filter values can't contain these without breaking the query syntax. */
export function sanitizeFilter(q: string): string {
  return q.replace(/[,()]+/g, " ").replace(/\s+/g, " ").trim();
}

export function buildUrl(base: string, kind: SearchKind, q: string, source: string | undefined, limit: number): string {
  const eq = encodeURIComponent(q);
  const sq = encodeURIComponent(sanitizeFilter(q));
  switch (kind) {
    case "messages":
      return `${base}/rpc/search_messages?q=${eq}&lim=${limit}` + (source ? `&src=${encodeURIComponent(source)}` : "");
    case "ledger":
      return `${base}/rpc/search_ledger?q=${eq}&lim=${limit}`;
    case "memories":
      return `${base}/memories?content=ilike.*${sq}*&order=created_at.desc&limit=${limit}`;
    case "sessions":
      // search_sessions RPC (memledger 009): unions attributed title/project/cwd
      // matches with message-FTS mentions; match_kind says which leg(s) hit.
      return `${base}/rpc/search_sessions?q=${eq}&lim=${limit}` + (source ? `&src=${encodeURIComponent(source)}` : "");
  }
}

/** ts_headline wraps matches in <b></b> - noise in a terminal. */
export function stripMarks(s: string): string {
  return s.replace(/<\/?b>/g, "");
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 3) + "..." : flat;
}

export interface MessageHit {
  session_key: string;
  ordinal: number;
  source: string;
  role: string;
  ts: string;
  rank: number;
  headline: string;
}

/**
 * Fetch helper shared by extensions that need memledger message search
 * (the memledger_search tool and session_search's deep-history path).
 * Throws on network/HTTP errors so callers can fall back.
 */
export async function searchMessages(
  q: string,
  source: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<MessageHit[]> {
  const url = buildUrl(baseUrl(), "messages", q, source, limit);
  const resp = await fetch(url, { signal: signal ?? AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`memledger HTTP ${resp.status}`);
  const rows = (await resp.json()) as MessageHit[];
  return rows.map((r) => ({ ...r, headline: stripMarks(r.headline ?? "") }));
}

export interface LedgerHit {
  id: string | number;
  created_at: string;
  kind: string;
  project: string;
  rank: number;
  summary: string;
}

/**
 * Ledger-summary search against the central store, for ledger_search's
 * deep-history path. Note the shape differs from the local sqlite ledger:
 * created_at is an ISO string rather than epoch ms, and there is no
 * git_branch column. Throws on network/HTTP errors so callers can fall back.
 */
export async function searchLedger(
  q: string,
  limit: number,
  signal?: AbortSignal,
): Promise<LedgerHit[]> {
  const url = buildUrl(baseUrl(), "ledger", q, undefined, limit);
  const resp = await fetch(url, { signal: signal ?? AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`memledger HTTP ${resp.status}`);
  return (await resp.json()) as LedgerHit[];
}

/**
 * Semantic-search "kind" is a DIFFERENT axis from SearchKind: it selects the
 * pgvector table on the embedder service (/semantic/search), not a PostgREST
 * RPC. Valid values: messages | memories | ledger_entries.
 */
export type SemanticKind = "messages" | "memories" | "ledger_entries";

export function buildSemanticUrl(base: string, q: string, kind: SemanticKind, source: string | undefined, limit: number): string {
  const srcParam = source ? `&source=${encodeURIComponent(source)}` : "";
  return `${base}/semantic/search?q=${encodeURIComponent(q)}&kind=${kind}&limit=${limit}${srcParam}`;
}

export function buildListSessionsUrl(base: string, project: string | undefined, source: string | undefined, limit: number): string {
  let url =
    `${base}/sessions?select=session_key,source,project,title,started_at,message_count` +
    `&order=started_at.desc.nullslast&limit=${limit}`;
  if (project) url += `&project=ilike.*${encodeURIComponent(project)}*`;
  if (source) url += `&source=eq.${encodeURIComponent(source)}`;
  return url;
}

export interface SemanticHit {
  session_key?: string;
  ordinal?: number;
  id?: number;
  text: string;
  similarity: number;
}

export function formatSemanticRows(kind: SemanticKind, results: SemanticHit[]): string[] {
  return results.map((r) => {
    const where = kind === "messages" ? `${r.session_key}#${r.ordinal}` : `#${r.id}`;
    const sim = typeof r.similarity === "number" ? r.similarity.toFixed(3) : "?";
    return `${sim} | ${where} | ${oneLine(String(r.text ?? ""), 200)}`;
  });
}

export function formatRows(kind: SearchKind, rows: Record<string, unknown>[]): string[] {
  switch (kind) {
    case "messages":
      return rows.map((r) =>
        `${r.source} | ${r.session_key}#${r.ordinal} | ${r.ts ?? "?"} | ${oneLine(stripMarks(String(r.headline ?? "")), 160)}`,
      );
    case "ledger":
      return rows.map((r) =>
        `${r.project ?? "?"} | ${r.created_at ?? "?"} | ${oneLine(String(r.summary ?? ""), 180)}`,
      );
    case "memories":
      return rows.map((r) => `${r.id} | ${oneLine(String(r.content ?? ""), 200)}`);
    case "sessions":
      return rows.map((r) => {
        const base = `${r.source} | ${r.project ?? "?"} | ${r.started_at ?? "?"} | ${oneLine(String(r.title ?? r.session_key ?? ""), 120)} | msgs:${r.message_count ?? "?"}`;
        // match_kind/hits only exist on search_sessions RPC rows, not on the
        // plain /sessions rows list_sessions fetches.
        return r.match_kind ? `${base} | ${r.match_kind}${r.hits ? ` hits:${r.hits}` : ""}` : base;
      });
  }
}

// -- harness-agnostic orchestrators ------------------------------------------
// Each returns { text, details, isError }, ready for either the pi tool result
// or the Claude Code MCP { content:[{type:"text",text}], isError } shape.

export interface MemledgerResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function clampLimit(limit: number | undefined, def = 10, max = 50): number {
  return Math.min(Math.max(limit ?? def, 1), max);
}

async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const resp = await fetch(url, { signal: s });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { httpStatus: resp.status });
  return resp.json();
}

/**
 * Full-text message search (PostgREST rpc/search_messages).
 *
 * selfSession is the CALLER'S OWN session_key ("pi:HOST:UUID"). Rows from it
 * are excluded - a session searching history for context repeatedly ranks
 * its own synthesis/echo messages highest (they repeat the query vocabulary),
 * which drowns out the original sources (2026-08-23 incident).
 *
 * When the exact query leaves nothing after self-filtering, we retry:
 *   1. the same query with a deeper limit (good hits may sit just past the
 *      self-hit block), then
 *   2. OR-broadened via toOrQuery - websearch_to_tsquery ANDs every term at
 *      message granularity, so 5+-term queries only match messages that
 *      contain ALL terms; the original sources usually don't.
 * Retries only fire when self-filtering actually dropped rows or the exact
 * query matched nothing, so precision-first behaviour is unchanged otherwise.
 */
export async function runSearchMessages(
  params: { q: string; source?: string; limit?: number; selfSession?: string },
  signal?: AbortSignal,
): Promise<MemledgerResult> {
  const limit = clampLimit(params.limit);
  const url = buildUrl(baseUrl(), "messages", params.q, params.source, limit);
  const self = params.selfSession;
  const dropSelf = (rows: MessageHit[]) => (self ? rows.filter((r) => r.session_key !== self) : rows);
  try {
    const raw = await searchMessages(params.q, params.source, limit, signal);
    let rows = dropSelf(raw);
    let note = "";
    if (rows.length === 0) {
      if (self && raw.length > 0) {
        const deep = dropSelf(await searchMessages(params.q, params.source, 50, signal));
        if (deep.length > 0) {
          rows = deep.slice(0, limit);
          note = "\n(top hits were the current session's own messages - showing deeper matches)";
        }
      }
      if (rows.length === 0) {
        const orQ = toOrQuery(params.q);
        if (orQ !== params.q.trim()) {
          // Fetch DEEP here too (same reason as the deep retry above): the
          // querying session's own messages contain every query term, so at
          // shallow depth the OR-broadened ranking is also dominated by
          // self-hits that dropSelf then removes - the 2026-08-25 tailscale
          // session hit exactly this: the OR retry silently failed and the
          // tool reported "all matches were the current session's own
          // messages" while the prior sessions sat below the self-block.
          const retry = dropSelf(await searchMessages(orQ, params.source, 50, signal));
          if (retry.length > 0) {
            rows = retry.slice(0, limit);
            note = `\n(no exact matches - OR-broadened to "${orQ}")`;
          }
        }
      }
    }
    const lines = rows.map(
      (r) => `${r.source} | ${r.session_key}#${r.ordinal} | ${r.ts ?? "?"} | ${oneLine(r.headline ?? "", 160)}`,
    );
    const text = lines.length
      ? lines.join("\n") + note
      : self && raw.length > 0
        ? `all matches for "${params.q}" were the current session's own messages (excluded) - try fewer or broader terms`
        : `no message matches for "${params.q}"`;
    return {
      text,
      details: { url, count: lines.length, ...(self ? { selfSession: self } : {}), ...(note ? { broadened: true } : {}) },
    };
  } catch (e) {
    return { isError: true, text: `memledger unreachable: ${e instanceof Error ? e.message : String(e)}`, details: { url } };
  }
}

/** Semantic (pgvector) similarity search via the embedder service. */
export async function runSemanticSearch(
  params: { q: string; kind?: string; source?: string; limit?: number; selfSession?: string },
  signal?: AbortSignal,
): Promise<MemledgerResult> {
  const limit = clampLimit(params.limit);
  const kind: SemanticKind = (["messages", "memories", "ledger_entries"] as string[]).includes(params.kind ?? "")
    ? (params.kind as SemanticKind)
    : "messages";
  const url = buildSemanticUrl(baseUrl(), params.q, kind, params.source, limit);
  try {
    const data = (await fetchJson(url, 15_000, signal)) as { results?: SemanticHit[] };
    let results = data.results ?? [];
    // Self-session messages rank high here for the same reason as FTS: the
    // querying session's own synthesis text is semantically closest to its
    // query. Exclude them (kind=messages only; other kinds have no session).
    const self = params.selfSession;
    if (self && kind === "messages") {
      results = results.filter((r) => r.session_key !== self);
    }
    const lines = formatSemanticRows(kind, results);
    return {
      text: lines.length
        ? lines.join("\n")
        : `no semantic matches for "${params.q}" (backfill may still be running - check /semantic/stats)`,
      details: { url, count: lines.length, kind },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const httpStatus = (e as { httpStatus?: number })?.httpStatus;
    return {
      isError: true,
      text: httpStatus ? `memledger semantic HTTP ${httpStatus}` : `memledger semantic unreachable: ${msg}`,
      details: { url },
    };
  }
}

/** Work-ledger summary search (PostgREST rpc/search_ledger). */
export async function runSearchLedger(
  params: { q: string; limit?: number },
  signal?: AbortSignal,
): Promise<MemledgerResult> {
  const limit = clampLimit(params.limit);
  const url = buildUrl(baseUrl(), "ledger", params.q, undefined, limit);
  try {
    const rows = (await fetchJson(url, 10_000, signal)) as Record<string, unknown>[];
    const lines = Array.isArray(rows) ? formatRows("ledger", rows) : [];
    return {
      text: lines.length ? lines.join("\n") : `no ledger matches for "${params.q}"`,
      details: { url, count: lines.length },
    };
  } catch (e) {
    return { isError: true, text: `memledger unreachable: ${e instanceof Error ? e.message : String(e)}`, details: { url } };
  }
}

/** Persistent agent-memory search (PostgREST memories ilike). */
export async function runSearchMemories(
  params: { q: string; limit?: number },
  signal?: AbortSignal,
): Promise<MemledgerResult> {
  const limit = clampLimit(params.limit);
  const url = buildUrl(baseUrl(), "memories", params.q, undefined, limit);
  try {
    const rows = (await fetchJson(url, 10_000, signal)) as Record<string, unknown>[];
    const lines = Array.isArray(rows) ? formatRows("memories", rows) : [];
    return {
      text: lines.length ? lines.join("\n") : `no memory matches for "${params.q}"`,
      details: { url, count: lines.length },
    };
  } catch (e) {
    return { isError: true, text: `memledger unreachable: ${e instanceof Error ? e.message : String(e)}`, details: { url } };
  }
}

/** List recent sessions, optionally filtered by project basename and/or client. */
export async function runListSessions(
  params: { project?: string; source?: string; limit?: number; selfSession?: string },
  signal?: AbortSignal,
): Promise<MemledgerResult> {
  const limit = clampLimit(params.limit);
  const url = buildListSessionsUrl(baseUrl(), params.project, params.source, limit);
  try {
    let rows = (await fetchJson(url, 10_000, signal)) as Record<string, unknown>[];
    if (!Array.isArray(rows)) rows = [];
    // The current session is always the newest pi row - pure noise when
    // listing history.
    if (params.selfSession) rows = rows.filter((r) => r.session_key !== params.selfSession);
    const lines = rows.length ? formatRows("sessions", rows) : [];
    return {
      text: lines.length ? lines.join("\n") : "no sessions found",
      details: { url, count: lines.length },
    };
  } catch (e) {
    return { isError: true, text: `memledger unreachable: ${e instanceof Error ? e.message : String(e)}`, details: { url } };
  }
}

/**
 * Combined one-call variant (the memledger_search tool). kind selects which
 * store to hit; semantic routes to the embedder service. selfSession (the
 * caller's own "pi:HOST:UUID" session key) is excluded from message,
 * session and semantic results - see runSearchMessages for why.
 */
export async function runMemledgerSearch(
  params: { q: string; source?: string; kind?: string; limit?: number; selfSession?: string },
  signal?: AbortSignal,
): Promise<MemledgerResult> {
  const kind: SearchKind = (["messages", "ledger", "memories", "sessions", "semantic"] as string[]).includes(params.kind ?? "")
    ? (params.kind as SearchKind)
    : "messages";
  if (kind === "semantic") {
    // semantic over messages only for the combined variant (matches original)
    return runSemanticSearch(
      { q: params.q, kind: "messages", source: params.source, limit: params.limit, selfSession: params.selfSession },
      signal,
    );
  }
  if (kind === "messages") {
    // shares self-filter + fallback-broadening with the dedicated tool
    const r = await runSearchMessages(
      { q: params.q, source: params.source, limit: params.limit, selfSession: params.selfSession },
      signal,
    );
    return { ...r, details: { ...r.details, kind } };
  }
  const limit = clampLimit(params.limit);
  const url = buildUrl(baseUrl(), kind, params.q, params.source, limit);
  try {
    const raw = (await fetchJson(url, 10_000, signal)) as Record<string, unknown>[];
    let rows = Array.isArray(raw) ? raw : [];
    let note = "";
    if (params.selfSession && kind === "sessions") {
      const before = rows.length;
      rows = rows.filter((r) => r.session_key !== params.selfSession);
      if (rows.length === 0) {
        // Fallbacks whenever the result is empty - EITHER because the
        // AND of all terms matched only this session's own echo of the
        // vocabulary, or because it matched nothing at all (a 5+-term
        // AND at message granularity usually matches nothing - see
        // runSearchMessages). Deep fetch (50): self-hits dominate the
        // shallow ranking too, so a shallow OR retry can fail purely
        // because the non-self answers sit below the self-block
        // (2026-08-25 tailscale session: tool reported "all matches were
        // the current session's own messages" while prior sessions sat
        // in the store, unreachable).
        if (before > 0 && before < 50) {
          const deepUrl = buildUrl(baseUrl(), kind, params.q, params.source, 50);
          const deep = (await fetchJson(deepUrl, 10_000, signal)) as Record<string, unknown>[];
          const deepFiltered = (Array.isArray(deep) ? deep : []).filter((r) => r.session_key !== params.selfSession);
          if (deepFiltered.length > 0) {
            rows = deepFiltered.slice(0, limit);
            note = "\n(top hits were the current session's own rows - showing deeper matches)";
          }
        }
        if (rows.length === 0) {
          const orQ = toOrQuery(params.q);
          if (orQ !== params.q.trim()) {
            const retryUrl = buildUrl(baseUrl(), kind, orQ, params.source, 50);
            const retry = (await fetchJson(retryUrl, 10_000, signal)) as Record<string, unknown>[];
            const filtered = (Array.isArray(retry) ? retry : []).filter(
              (r) => r.session_key !== params.selfSession,
            );
            if (filtered.length > 0) {
              rows = filtered.slice(0, limit);
              note = `\n(no exact matches - OR-broadened to "${orQ}")`;
            }
          }
        }
      }
    } else if (rows.length === 0 && !params.selfSession) {
      // No self-filter context (e.g. Claude Code toolkit): still broaden an
      // over-constrained AND that matched nothing.
      const orQ = toOrQuery(params.q);
      if (orQ !== params.q.trim()) {
        const retryUrl = buildUrl(baseUrl(), kind, orQ, params.source, limit);
        const retry = (await fetchJson(retryUrl, 10_000, signal)) as Record<string, unknown>[];
        if (Array.isArray(retry) && retry.length > 0) {
          rows = retry;
          note = `\n(no exact matches - OR-broadened to "${orQ}")`;
        }
      }
    }
    if (rows.length === 0) {
      return { text: `no ${kind} matches for "${params.q}"`, details: { url, count: 0, kind } };
    }
    return {
      text: formatRows(kind, rows).join("\n") + note,
      details: { url, count: rows.length, kind, ...(note ? { broadened: true } : {}) },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const httpStatus = (e as { httpStatus?: number })?.httpStatus;
    return {
      isError: true,
      text: httpStatus ? `memledger HTTP ${httpStatus} for ${kind} search` : `memledger unreachable: ${msg}`,
      details: { url },
    };
  }
}
