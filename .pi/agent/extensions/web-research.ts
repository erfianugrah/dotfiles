/**
 * web_research — one tool that enforces the search→fetch pipeline.
 *
 * The bakery problem: pi tends to call `websearch` (Exa) and assert facts
 * straight from snippet text without ever fetching a source. Exa snippets
 * are aggregator excerpts and routinely mislead (chains described as
 * "artisanal", stale hours, wrong addresses).
 *
 * This tool fixes that structurally: it calls Exa, parses result URLs,
 * fetches the top N in parallel, and returns one combined report. Pi
 * literally cannot produce a recommendation from snippets alone — the
 * fetched page bodies are in the tool output.
 *
 * Modes layer on extra signals:
 *
 *   default  — Exa + fetch top 2 results (trafilatura via webfetch logic)
 *   local    — same + try `force_js:true` via the research crawler at
 *              :8889 for any maps/review URLs (Google Maps, Yelp, etc.)
 *   fresh    — Exa with livecrawl=preferred + cross-check via SearXNG
 *              (research skill :8888) with time_range=week
 *   crosscheck — Exa + SearXNG, both sets of results, no fetch (use when
 *                you want to compare engines before drilling in)
 *
 * For OSINT (domain/IP/email/username/phone/CVE/VirusTotal) keep using
 * the research skill endpoints directly — out of scope for this tool.
 *
 * Endpoints:
 *   - Exa MCP:        https://mcp.exa.ai/mcp  (anonymous tier ok)
 *   - SearXNG:        http://localhost:8888/search
 *   - Research crawl: http://localhost:8889/fetch
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── config ────────────────────────────────────────────────────────────────

const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp";
const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";
const CRAWLER_URL = process.env.CRAWLER_URL ?? "http://localhost:8889";

const HONEST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_CHAR_CAP = 6000; // per-page cap to keep combined report sane

// Domains where the static fetch is hopeless — escalate straight to Playwright.
const JS_HEAVY_HOSTS = [
  "google.com/maps",
  "maps.google.",
  "yelp.com",
  "tripadvisor.",
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "reddit.com",
];

function needsJs(url: string): boolean {
  const u = url.toLowerCase();
  return JS_HEAVY_HOSTS.some((h) => u.includes(h));
}

// ── Exa MCP call (same shape as exa.ts) ───────────────────────────────────

async function exaSearch(
  query: string,
  numResults: number,
  livecrawl: "fallback" | "preferred",
  timeoutMs = 25_000,
): Promise<string | undefined> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(EXA_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query, numResults, livecrawl, type: "auto" },
        },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
    const body = await res.text();
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
  } finally {
    clearTimeout(t);
  }
}

function extractUrls(exaText: string, limit: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const m of exaText.matchAll(/^URL:\s*(\S+)/gm)) {
    const u = m[1];
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
      if (urls.length >= limit) break;
    }
  }
  return urls;
}

// ── lightweight HTML → text (no turndown, no Bun-only API needed) ─────────

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── fetch one URL: static first, escalate to crawler if needed ────────────

async function fetchOne(
  url: string,
  forceJs: boolean,
  timeoutMs: number,
): Promise<{ url: string; ok: boolean; via: string; content: string; note?: string }> {
  // JS-heavy host or explicit flag → go straight to crawler (Playwright).
  if (forceJs || needsJs(url)) {
    return await fetchViaCrawler(url, true, timeoutMs);
  }

  // Static path
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": HONEST_UA,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: ctl.signal,
    });
    if (!res.ok) {
      // CF/anti-bot or 4xx — try the crawler as fallback.
      return await fetchViaCrawler(url, false, timeoutMs);
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const lenHdr = res.headers.get("content-length");
    if (lenHdr && parseInt(lenHdr, 10) > MAX_FETCH_BYTES) {
      return { url, ok: false, via: "static", content: "", note: `too large (${lenHdr} bytes)` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FETCH_BYTES) {
      return { url, ok: false, via: "static", content: "", note: `too large (${buf.byteLength} bytes)` };
    }
    const raw = new TextDecoder().decode(buf);
    const text = ct.includes("text/html") ? htmlToText(raw) : raw;
    // SPA shell heuristic: HTML page < 500 chars of visible text → escalate.
    if (ct.includes("text/html") && text.length < 500) {
      const fallback = await fetchViaCrawler(url, true, timeoutMs);
      if (fallback.ok && fallback.content.length > text.length) return fallback;
    }
    return { url, ok: true, via: "static", content: text.slice(0, FETCH_CHAR_CAP) };
  } catch (err) {
    // Network error — try the crawler.
    const fallback = await fetchViaCrawler(url, false, timeoutMs).catch(() => null);
    if (fallback?.ok) return fallback;
    return {
      url,
      ok: false,
      via: "static",
      content: "",
      note: `fetch failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchViaCrawler(
  url: string,
  forceJs: boolean,
  timeoutMs: number,
): Promise<{ url: string; ok: boolean; via: string; content: string; note?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CRAWLER_URL}/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        force_js: forceJs,
        max_chars: FETCH_CHAR_CAP,
        timeout: Math.floor(timeoutMs / 1000),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      return {
        url,
        ok: false,
        via: forceJs ? "crawler+js" : "crawler",
        content: "",
        note: `crawler HTTP ${res.status}`,
      };
    }
    const j = (await res.json()) as { content?: string; error?: string };
    if (j.error || !j.content) {
      return {
        url,
        ok: false,
        via: forceJs ? "crawler+js" : "crawler",
        content: "",
        note: j.error ?? "no content",
      };
    }
    return {
      url,
      ok: true,
      via: forceJs ? "crawler+js" : "crawler",
      content: j.content.slice(0, FETCH_CHAR_CAP),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      via: "crawler",
      content: "",
      note: `crawler unreachable: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(t);
  }
}

// ── SearXNG cross-check ──────────────────────────────────────────────────

async function searxng(
  query: string,
  opts: { timeRange?: "day" | "week" | "month" | "year"; categories?: string },
  timeoutMs = 15_000,
): Promise<Array<{ title: string; url: string; content: string; engine: string }>> {
  const params = new URLSearchParams({ q: query, format: "json", safesearch: "0" });
  if (opts.timeRange) params.set("time_range", opts.timeRange);
  if (opts.categories) params.set("categories", opts.categories);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SEARXNG_URL}/search?${params}`, { signal: ctl.signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { results?: Array<{ title: string; url: string; content: string; engine: string }> };
    return (j.results ?? []).slice(0, 8);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ── report formatting ─────────────────────────────────────────────────────

function formatReport(parts: {
  query: string;
  mode: string;
  exa?: string;
  searx?: Array<{ title: string; url: string; content: string; engine: string }>;
  fetches?: Array<{ url: string; ok: boolean; via: string; content: string; note?: string }>;
}): string {
  const out: string[] = [];
  out.push(`# web_research: ${parts.query}`);
  out.push(`mode: ${parts.mode}\n`);

  if (parts.exa) {
    out.push("## Exa results\n");
    out.push(parts.exa.trim());
    out.push("");
  }

  if (parts.searx && parts.searx.length) {
    out.push("## SearXNG cross-check\n");
    for (const r of parts.searx) {
      out.push(`- **${r.title}** _(${r.engine})_`);
      out.push(`  ${r.url}`);
      if (r.content) out.push(`  ${r.content.slice(0, 240)}`);
    }
    out.push("");
  }

  if (parts.fetches && parts.fetches.length) {
    out.push("## Fetched source pages\n");
    out.push(
      "_Do not assert facts from Exa snippets alone — verify against the fetched bodies below. Chain sites typically expose `/filialen`, `/standorte`, `/locations`, or a long branch list._\n",
    );
    for (const f of parts.fetches) {
      out.push(`### ${f.url}`);
      out.push(`via: ${f.via}${f.ok ? "" : ` — FAILED${f.note ? ` (${f.note})` : ""}`}`);
      if (f.ok && f.content) {
        out.push("");
        out.push(f.content);
      }
      out.push("");
    }
  }

  return out.join("\n");
}

// ── tool ──────────────────────────────────────────────────────────────────

const webResearchTool = defineTool({
  name: "web_research",
  label: "Web Research",
  promptSnippet: "web_research — Exa search + auto-fetch top result pages in one call. Use this (not websearch) when making a recommendation, asserting a fact, or after user pushback.",
  promptGuidelines: [
    "Use web_research instead of websearch when you intend to recommend, cite a fact, or answer a disputed question. Returns search results AND fetched page bodies in one call — eliminates snippet-only reasoning.",
    "For local-business / maps / reviews / opening-hours queries, pass mode:'local' so JS-heavy hosts (Google Maps, Yelp, TripAdvisor) get Playwright-rendered.",
    "For freshness-sensitive queries (<1 week old) pass mode:'fresh' — enables Exa livecrawl + SearXNG time-filtered cross-check.",
  ],
  description: [
    "Search the web AND fetch the top result pages in one call. Returns combined Exa results + fetched page bodies.",
    "",
    "Use this INSTEAD of `websearch` when you intend to recommend, assert a fact, or answer a question that hinges on what the source actually says. Exa snippets are aggregator excerpts and routinely mislead — this tool eliminates snippet-only reasoning by fetching the top pages automatically.",
    "",
    "When to use which:",
    "- `web_research` — making a recommendation, citing a fact, user disputed a result, local/maps query, freshness matters",
    "- `websearch` — quick discovery only, no claims being made yet",
    "- `webfetch` — you already have a specific URL",
    "",
    "Modes:",
    "- `default` (general lookups): Exa + fetch top 2 results",
    "- `local` (best X near Y, hours, addresses): Exa + fetch top 2, force Playwright on JS-heavy hosts (maps/yelp/etc.)",
    "- `fresh` (news, prices, releases <1 week): Exa with livecrawl=preferred + SearXNG cross-check with time_range=week + fetch top 2",
    "- `crosscheck` (compare engines, ambiguous topic): Exa + SearXNG, no fetch",
    "",
    "Requires the local research stack for the fresh/local/crosscheck escalations (SearXNG :8888, crawler :8889). Falls back gracefully if they're down.",
  ].join("\n"),
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("default"),
          Type.Literal("local"),
          Type.Literal("fresh"),
          Type.Literal("crosscheck"),
        ],
        { description: "Pipeline mode (default: default)" },
      ),
    ),
    fetchTop: Type.Optional(
      Type.Number({ description: "How many top results to fetch (default: 2, max: 5)" }),
    ),
    numResults: Type.Optional(
      Type.Number({ description: "Number of Exa results to return (default: 6)" }),
    ),
  }),
  async execute(_id, params) {
    const mode = params.mode ?? "default";
    const numResults = params.numResults ?? 6;
    const fetchTop = Math.min(Math.max(params.fetchTop ?? 2, 0), 5);
    const livecrawl: "fallback" | "preferred" = mode === "fresh" ? "preferred" : "fallback";

    // 1. Exa search
    let exaText: string | undefined;
    try {
      exaText = await exaSearch(params.query, numResults, livecrawl);
    } catch (err) {
      // Hard fail on Exa → fall back to SearXNG-only.
      const searx = await searxng(params.query, {});
      return {
        content: [
          {
            type: "text",
            text: formatReport({
              query: params.query,
              mode: `${mode} (exa-failed: ${(err as Error).message})`,
              searx,
            }),
          },
        ],
        details: { query: params.query, mode, exaFailed: true },
      };
    }

    if (!exaText) {
      const searx = await searxng(params.query, {});
      return {
        content: [
          {
            type: "text",
            text: formatReport({
              query: params.query,
              mode: `${mode} (exa-empty)`,
              searx,
            }),
          },
        ],
        details: { query: params.query, mode, exaEmpty: true },
      };
    }

    // 2. Optional SearXNG cross-check
    let searx: Array<{ title: string; url: string; content: string; engine: string }> | undefined;
    if (mode === "fresh") {
      searx = await searxng(params.query, { timeRange: "week" });
    } else if (mode === "crosscheck") {
      searx = await searxng(params.query, {});
    }

    // 3. Fetch top N (skipped for crosscheck)
    let fetches: Array<{ url: string; ok: boolean; via: string; content: string; note?: string }> | undefined;
    if (mode !== "crosscheck" && fetchTop > 0) {
      const urls = extractUrls(exaText, fetchTop);
      const forceJs = mode === "local";
      fetches = await Promise.all(urls.map((u) => fetchOne(u, forceJs, 25_000)));
    }

    return {
      content: [
        {
          type: "text",
          text: formatReport({ query: params.query, mode, exa: exaText, searx, fetches }),
        },
      ],
      details: {
        query: params.query,
        mode,
        numResults,
        fetched: fetches?.filter((f) => f.ok).length ?? 0,
        searxng: searx?.length ?? 0,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(webResearchTool);
}
