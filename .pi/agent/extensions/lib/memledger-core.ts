/**
 * memledger-core - pure helpers for the memledger_search extension tool.
 * No pi imports here so bun tests can load this file directly.
 */

export type SearchKind = "messages" | "ledger" | "memories" | "sessions";

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
      return `${base}/sessions?or=(title.ilike.*${sq}*,project.ilike.*${sq}*,cwd.ilike.*${sq}*)&order=started_at.desc.nullslast&limit=${limit}`;
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
      return rows.map((r) =>
        `${r.source} | ${r.project ?? "?"} | ${r.started_at ?? "?"} | ${oneLine(String(r.title ?? r.session_key ?? ""), 120)} | msgs:${r.message_count ?? "?"}`,
      );
  }
}
