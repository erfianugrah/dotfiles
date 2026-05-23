/**
 * webfetch — fetch a URL and return clean content (markdown / text / html).
 *
 * Port of the opencode fork's tools/webfetch.ts. Same behaviour:
 *   - 5MB response size cap
 *   - 30s default timeout, 120s max
 *   - User-Agent rotation: real Chrome UA first, fall back to "Pi" if
 *     Cloudflare 403s with cf-mitigated: challenge
 *   - Format-aware Accept header (markdown / text / html with q-fallbacks)
 *   - HTML → markdown via a minimal in-tree converter (no `turndown` dep —
 *     keeps the extension single-file, no Pi package format needed)
 *   - HTML → text via Bun's HTMLRewriter (strips scripts/styles/iframes)
 *
 * Differences from opencode:
 *   - No image-attachment auto-compression (covered separately if needed).
 *     Image URLs return as-is with a hint about the bytes/mime.
 *   - No permission gating via ctx.ask (Pi has different permission model).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// Auto-escalation to the research crawler (Playwright-backed) for SPA-shell
// pages. The crawler runs locally at :8889/fetch and accepts {url, force_js}.
// We only escalate when the static fetch produced <500 visible chars on an
// HTML response — the typical signature of a JS-rendered page.
const CRAWLER_URL = process.env.CRAWLER_URL ?? "http://localhost:8889";
const SPA_SHELL_CHAR_THRESHOLD = 500;

async function fetchViaCrawler(url: string, timeoutMs: number): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CRAWLER_URL}/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        force_js: true,
        timeout: Math.floor(timeoutMs / 1000),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; error?: string };
    return j.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const HONEST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

function acceptFor(format: "markdown" | "text" | "html"): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

// ── HTML cleanup via Bun's HTMLRewriter (built-in) ────────────────────────

async function extractText(html: string): Promise<string> {
  // @ts-expect-error — Bun ships HTMLRewriter globally (same API as Cloudflare Workers)
  if (typeof HTMLRewriter === "undefined") {
    // Fallback for non-Bun runtimes — simple regex strip
    return html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }
  let text = "";
  let skipContent = false;
  // @ts-expect-error see above
  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true;
      },
    })
    .on("*", {
      element(element: { tagName: string }) {
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false;
        }
      },
      text(input: { text: string }) {
        if (!skipContent) text += input.text;
      },
    })
    .transform(new Response(html));
  await rewriter.text();
  return text.replace(/\s+/g, " ").trim();
}

// ── minimal HTML → markdown (no turndown dep) ─────────────────────────────

function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");

  // Block elements → newlines
  s = s
    .replace(/<\/(p|div|section|article|aside|header|footer|nav|ul|ol|li|table|tr|td|th|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n");

  // Headings (h1-h6)
  for (let i = 1; i <= 6; i++) {
    const hashes = "#".repeat(i);
    s = s.replace(new RegExp(`<h${i}\\b[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi"), `\n${hashes} $1\n`);
  }

  // Code blocks (pre > code) — keep contents fenced
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code) => {
    return `\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n`;
  });

  // Inline code
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Bold / italic
  s = s
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$2*");

  // Links
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // List items
  s = s.replace(/<li[^>]*>/gi, "- ").replace(/<\/li>/gi, "\n");

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");

  // Decode common entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse whitespace
  s = s.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();

  return s;
}

// ── tool ──────────────────────────────────────────────────────────────────

const webfetchTool = defineTool({
  name: "webfetch",
  label: "Web Fetch",
  promptSnippet: "webfetch — fetch a known URL as markdown / text / html.",
  promptGuidelines: [
    "If response is SPA-shell / empty, escalate to research crawler :8889/fetch with force_js:true.",
  ],
  description:
    "Fetch URL as markdown (default) / text / html. 5MB cap, 30s default timeout (max 120s), 1 retry on CF 403.",

  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch (http:// or https://)" }),
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
        description: "Output format (default: markdown)",
      }),
    ),
    timeout: Type.Optional(
      Type.Number({ description: "Timeout in seconds (max 120, default 30)" }),
    ),
  }),
  async execute(_id, params) {
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      return {
        isError: true,
        content: [{ type: "text", text: "URL must start with http:// or https://" }],
        details: { url: params.url },
      };
    }

    const format = params.format ?? "markdown";
    const timeoutMs = Math.min((params.timeout ?? 30) * 1000, MAX_TIMEOUT_MS);

    const headers = {
      "user-agent": HONEST_UA,
      accept: acceptFor(format),
      "accept-language": "en-US,en;q=0.9",
    };

    const fetchOnce = async (ua: string): Promise<Response> => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(params.url, {
          headers: { ...headers, "user-agent": ua },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }
    };

    let response: Response;
    try {
      response = await fetchOnce(HONEST_UA);
      // Cloudflare bot detection — retry with simpler UA. Sometimes works.
      if (
        response.status === 403 &&
        response.headers.get("cf-mitigated")?.includes("challenge")
      ) {
        response = await fetchOnce("Pi");
      }
      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `HTTP ${response.status} ${response.statusText} — ${params.url}` }],
          details: { url: params.url, status: response.status },
        };
      }
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Request failed: ${(err as Error).message}` }],
        details: { url: params.url },
      };
    }

    // Size guard
    const lenHeader = response.headers.get("content-length");
    if (lenHeader && parseInt(lenHeader, 10) > MAX_RESPONSE_SIZE) {
      return {
        isError: true,
        content: [{ type: "text", text: `Response too large (${lenHeader} bytes; cap is 5MB)` }],
        details: { url: params.url },
      };
    }

    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_SIZE) {
      return {
        isError: true,
        content: [{ type: "text", text: `Response too large (${buf.byteLength} bytes; cap is 5MB)` }],
        details: { url: params.url },
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const title = `${params.url} (${contentType})`;

    // Images — return URL + size hint (compression is a separate concern)
    if (contentType.startsWith("image/")) {
      return {
        content: [{ type: "text", text: `[image: ${params.url} (${contentType}, ${buf.byteLength} bytes) — not inlined; use bash curl with --output to fetch]` }],
        details: { url: params.url, mime: contentType, bytes: buf.byteLength },
      };
    }

    const html = new TextDecoder().decode(buf);
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");

    let output: string;
    if (format === "html") output = html;
    else if (format === "text") output = isHtml ? await extractText(html) : html;
    else output = isHtml ? htmlToMarkdown(html) : html;

    // SPA-shell escalation: HTML response with very little visible text
    // is almost always JavaScript-rendered. Try the local research crawler
    // (Playwright) before returning the shell to the agent. Only attempts
    // it for non-HTML format requests since the user explicitly asked for
    // markdown / text content. If the crawler isn't reachable or also
    // produces less, we keep the static result.
    let escalated = false;
    if (isHtml && format !== "html" && output.length < SPA_SHELL_CHAR_THRESHOLD) {
      const crawled = await fetchViaCrawler(params.url, timeoutMs);
      if (crawled && crawled.length > output.length) {
        output = crawled;
        escalated = true;
      }
    }

    return {
      content: [{ type: "text", text: output }],
      details: {
        url: params.url,
        format,
        contentType,
        bytes: buf.byteLength,
        title,
        ...(escalated ? { via: "crawler+js" } : {}),
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(webfetchTool);
}
