/**
 * context7-core - pure URL-building, JSON/text response projection, rendering,
 * and fetch orchestrators for the context7.com REST API. ZERO harness imports
 * (node stdlib + global fetch only). Source of truth for the pi adapter
 * (../context7.ts) and the Claude Code MCP toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * Two operations:
 *   resolveLibraryId - GET /search?query=&topic= -> matching /org/project IDs.
 *   queryDocs        - GET /<org/project>?topic=&tokens= -> raw docs text.
 *
 * REST API: anonymous tier works without auth (IP rate-limited). Optional
 * CONTEXT7_API_KEY -> Authorization: Bearer. Secrets stay in authHeaders here.
 *
 * Extracted from context7.ts (2026-08-12); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

export const BASE_URL = "https://context7.com/api/v1";

// -- auth --------------------------------------------------------------------

export function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.CONTEXT7_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

// -- resolve: URL building + projection + rendering --------------------------

// Pure: build the /search URL. Exported for unit testing.
export function buildSearchUrl(libraryName: string, query?: string): string {
  const url = new URL(`${BASE_URL}/search`);
  url.searchParams.set("query", libraryName);
  if (query) url.searchParams.set("topic", query);
  return url.toString();
}

export interface LibraryMatch {
  id: string;
  title: string;
  description: string;
  trustScore: number | null;
  benchmarkScore: number | null;
  totalSnippets: number | null;
}

// Pure: project the /search JSON into a flat, capped list. Exported for tests.
export function parseSearchResults(raw: string, limit = 10): LibraryMatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const results = (parsed as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];

  return results.slice(0, limit).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      id: typeof o.id === "string" ? o.id : "(no id)",
      title: typeof o.title === "string" ? o.title : "",
      description: typeof o.description === "string" ? o.description : "",
      trustScore: num(o.trustScore),
      benchmarkScore: num(o.benchmarkScore),
      totalSnippets: num(o.totalSnippets),
    };
  });
}

// Pure: render matches to a compact text block. Exported for tests.
export function renderSearchResults(matches: LibraryMatch[]): string {
  return matches
    .map((m) => {
      const meta: string[] = [];
      if (m.trustScore !== null) meta.push(`trust:${m.trustScore}`);
      if (m.benchmarkScore !== null) meta.push(`bench:${Math.round(m.benchmarkScore)}`);
      if (m.totalSnippets !== null) meta.push(`snippets:${m.totalSnippets}`);
      return `${m.id}  ${m.title}  [${meta.join(" ")}]\n  ${m.description.slice(0, 200)}`;
    })
    .join("\n\n");
}

// -- query docs: URL building ------------------------------------------------

export const DEFAULT_TOKENS = 5000;
export const MIN_TOKENS = 1000;
export const MAX_TOKENS = 50000;

// Pure: clamp a requested token budget into [MIN, MAX].
export function clampTokens(tokens?: number): number {
  return Math.min(Math.max(tokens ?? DEFAULT_TOKENS, MIN_TOKENS), MAX_TOKENS);
}

// Pure: strip a leading slash from a library ID (API path wants the bare form).
export function normalizeLibraryId(libraryId: string): string {
  return libraryId.replace(/^\//, "");
}

// Pure: build the docs URL. Exported for unit testing.
export function buildDocsUrl(libraryId: string, query?: string, tokens?: number): string {
  const libId = normalizeLibraryId(libraryId);
  const url = new URL(`${BASE_URL}/${libId}`);
  if (query) url.searchParams.set("topic", query);
  url.searchParams.set("tokens", String(clampTokens(tokens)));
  return url.toString();
}

// -- harness-agnostic orchestrators ------------------------------------------

export interface Context7Result {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function resolveLibraryId(opts: {
  libraryName: string;
  query?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<Context7Result> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = buildSearchUrl(opts.libraryName, opts.query);
  const res = await doFetch(url, { headers: authHeaders(opts.env) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      isError: true,
      text: `context7 HTTP ${res.status}: ${body.slice(0, 200)}`,
      details: { status: res.status },
    };
  }
  const raw = await res.text();
  const matches = parseSearchResults(raw);
  if (matches.length === 0) {
    return { text: `No libraries found matching "${opts.libraryName}".`, details: { count: 0 } };
  }
  return {
    text: renderSearchResults(matches),
    details: { count: matches.length, returned: matches.length, matches },
  };
}

export async function queryDocs(opts: {
  libraryId: string;
  query?: string;
  tokensNum?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<Context7Result> {
  const doFetch = opts.fetchImpl ?? fetch;
  const libId = normalizeLibraryId(opts.libraryId);
  const tokens = clampTokens(opts.tokensNum);
  const url = buildDocsUrl(opts.libraryId, opts.query, tokens);
  const res = await doFetch(url, { headers: authHeaders(opts.env) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      isError: true,
      text: `context7 HTTP ${res.status} for ${libId}: ${body.slice(0, 300)}`,
      details: { status: res.status, libraryId: opts.libraryId },
    };
  }
  const text = await res.text();
  return {
    text,
    details: { libraryId: opts.libraryId, tokens, bytes: text.length },
  };
}
