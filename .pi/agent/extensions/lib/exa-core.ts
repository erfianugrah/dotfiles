/**
 * exa-core - pure Exa MCP request/response projection + SearXNG fallback +
 * harness-agnostic orchestrators. ZERO harness imports (node stdlib + global
 * fetch only). Source of truth for the pi adapter (../exa.ts) and the Claude
 * Code MCP toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * Exa is reached over its public HTTP+SSE MCP endpoint (mcp.exa.ai). Anonymous
 * tier works without auth; EXA_API_KEY unlocks the higher tier. When Exa
 * returns empty / errors, we fall back to the SearXNG instance the research
 * skill exposes.
 *
 * Extracted from exa.ts (2026-08-12); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

// -- config (env-driven, read lazily so tests can vary it) -------------------

export function exaBaseUrl(): string {
  return process.env.EXA_API_KEY
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
    : "https://mcp.exa.ai/mcp";
}

export function searxngUrl(): string {
  return process.env.SEARXNG_URL ?? "https://searxng.erfi.io";
}

export function researchAuthHeaders(): Record<string, string> {
  const tok = process.env.RESEARCH_TOKEN?.trim();
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

// -- pure projection ---------------------------------------------------------

/**
 * Pure: extract the first `result.content[0].text` from an Exa MCP SSE body.
 * The endpoint answers with a `text/event-stream` where the JSON-RPC result is
 * carried on a `data: {...}` line. Returns undefined if no text is present.
 * Exported for unit testing (no network).
 */
export function parseExaSse(body: string): string | undefined {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        result?: { content?: Array<{ type: string; text: string }> };
      };
      const text = parsed.result?.content?.[0]?.text;
      if (text) return text;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface SearxHit {
  title: string;
  url: string;
  content: string;
  engine: string;
}

/**
 * Pure: project a SearXNG JSON `results` array (top 8) into a compact numbered
 * text block. Exported for unit testing. Returns undefined when no hits.
 */
export function renderSearxng(results: SearxHit[] | undefined): string | undefined {
  const hits = (results ?? []).slice(0, 8);
  if (hits.length === 0) return undefined;
  return hits
    .map(
      (r, i) =>
        `${i + 1}. ${r.title} _(via ${r.engine})_\n   ${r.url}\n   ${(r.content ?? "").slice(0, 240)}`,
    )
    .join("\n\n");
}

/**
 * Pure: build the Exa JSON-RPC 2.0 tools/call envelope body. Exported for tests.
 */
export function buildExaEnvelope(tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
}

/**
 * Pure: build the `web_search_exa` arguments object from user params.
 * Exported for tests.
 */
export function buildWebsearchArgs(params: {
  query: string;
  type?: "auto" | "fast" | "deep";
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  contextMaxCharacters?: number;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    query: params.query,
    type: params.type ?? "auto",
    numResults: params.numResults ?? 8,
    livecrawl: params.livecrawl ?? "fallback",
  };
  if (params.contextMaxCharacters) args.contextMaxCharacters = params.contextMaxCharacters;
  return args;
}

/**
 * Pure: clamp the codesearch token budget to [1000, 50000]. Exported for tests.
 */
export function clampTokens(tokensNum: number | undefined): number {
  return Math.min(Math.max(tokensNum ?? 5000, 1000), 50000);
}

// -- MCP / HTTP helpers (harness-agnostic; use global fetch) -----------------

export async function exaCall(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(exaBaseUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: buildExaEnvelope(tool, args),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Exa HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const body = await res.text();
    return parseExaSse(body);
  } finally {
    clearTimeout(timer);
  }
}

export async function searxngFallback(query: string, timeoutMs = 12_000): Promise<string | undefined> {
  const params = new URLSearchParams({ q: query, format: "json", safesearch: "0" });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${searxngUrl()}/search?${params}`, {
      headers: researchAuthHeaders(),
      signal: ctl.signal,
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { results?: SearxHit[] };
    return renderSearxng(j.results);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// -- harness-agnostic orchestrators ------------------------------------------

export interface ExaResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function websearch(params: {
  query: string;
  numResults?: number;
  type?: "auto" | "fast" | "deep";
  livecrawl?: "fallback" | "preferred";
  contextMaxCharacters?: number;
}): Promise<ExaResult> {
  const args = buildWebsearchArgs(params);

  let text: string | undefined;
  let exaError: string | undefined;
  try {
    text = await exaCall("web_search_exa", args, 25_000);
  } catch (err) {
    exaError = (err as Error).message;
  }

  // Empty / errored Exa response -> try SearXNG before giving up. Avoids the
  // reformulation loop where the agent sees "No results" and rewords 3 times.
  if (!text) {
    const searx = await searxngFallback(params.query);
    if (searx) {
      const note = exaError
        ? `Exa failed (${exaError}); SearXNG fallback results:\n\n`
        : "Exa returned no results; SearXNG fallback results:\n\n";
      return {
        text: note + searx,
        details: { query: params.query, fallback: "searxng", exaError },
      };
    }
    if (exaError) {
      return {
        isError: true,
        text: `Exa websearch failed: ${exaError} (SearXNG fallback also returned nothing)`,
        details: { query: params.query },
      };
    }
    return {
      text: "No search results found. Try a different query.",
      details: { query: params.query, type: args.type },
    };
  }

  return { text, details: { query: params.query, type: args.type } };
}

export async function codesearch(params: {
  query: string;
  tokensNum?: number;
}): Promise<ExaResult> {
  const tokens = clampTokens(params.tokensNum);
  try {
    const text = await exaCall(
      "get_code_context_exa",
      { query: params.query, tokensNum: tokens },
      30_000,
    );
    return {
      text:
        text ??
        "No code snippets or documentation found. Try a more specific query or check spelling of framework names.",
      details: { query: params.query, tokens },
    };
  } catch (err) {
    return {
      isError: true,
      text: `Exa codesearch failed: ${(err as Error).message}`,
      details: { query: params.query },
    };
  }
}
