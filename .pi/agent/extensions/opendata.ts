/**
 * dataset_search / dataset_fetch - official statistics as a FILE, not as rows.
 *
 * The failure this replaces: asking a government open-data portal for numbers
 * by hand. That means learning that data.gov.sg's catalogue endpoint ignores
 * every query parameter it accepts (so "search" is a local match over ~4.6k
 * entries), that downloads are an initiate-then-poll handshake behind a 2-call
 * per 10s anonymous rate limit, and then - having got a CSV - resisting the
 * urge to paste 200k rows into a context window. That was hand-rolled twice
 * before it became the crawler service's `/dataset/*` endpoints.
 *
 * The contract worth keeping in mind: **rows never come back through the
 * tool.** `dataset_fetch` streams the file to local disk and returns a path,
 * the column list and a five-line preview. Query it afterwards with duckdb:
 *
 *     duckdb -c "SELECT town, avg(resale_price) FROM '<path>' GROUP BY 1"
 *
 * Endpoint: https://crawler.erfi.io/dataset/* (Caddy bearer, same gate as the
 * rest of the research stack). Override CRAWLER_URL for local dev at :8889;
 * the bearer is attached only when RESEARCH_TOKEN is set.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CRAWLER_URL = process.env.CRAWLER_URL ?? "https://crawler.erfi.io";
const CACHE_DIR =
  process.env.DATASET_CACHE_DIR ?? join(homedir(), ".cache", "research", "datasets");
const DEFAULT_PORTAL = "data.gov.sg";

function authHeaders(): Record<string, string> {
  const tok = process.env.RESEARCH_TOKEN?.trim();
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

interface DatasetRef {
  portal: string;
  dataset_id: string;
  name: string;
  description?: string;
  fmt?: string;
  agency?: string;
  updated?: string;
  coverage?: string;
  page_url?: string;
}

interface DatasetColumn {
  name: string;
  title?: string;
  dtype?: string;
}

interface DatasetFile {
  ref: DatasetRef;
  path: string;
  file_url: string;
  bytes: number;
  columns: DatasetColumn[];
  rows: number | null;
  preview: string;
  cached: boolean;
  elapsed_ms: number;
}

async function post<T>(path: string, payload: unknown, timeoutMs: number,
                       signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("dataset timeout")), timeoutMs);
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(`${CRAWLER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`crawler HTTP ${res.status} on ${path}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Copy the service's file to this machine.
 *
 * The path in the response is inside the crawler's container on another host -
 * printing it as though duckdb could open it here would be the most misleading
 * thing this tool could do, so the local copy is what gets reported.
 */
async function localCopy(fileUrl: string, remotePath: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const base = remotePath.split("/").pop() ?? "dataset";
  const dest = join(CACHE_DIR, base);
  const tmp = `${dest}.part`;
  const res = await fetch(`${CRAWLER_URL}${fileUrl}`, { headers: authHeaders() });
  if (!res.ok || !res.body) {
    throw new Error(`file download HTTP ${res.status}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "age unknown";
  if (seconds < 90) return "just crawled";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  return `${Math.floor(seconds / 3600)}h old`;
}

const searchTool = defineTool({
  name: "dataset_search",
  label: "Dataset Search",
  promptSnippet:
    "dataset_search - find an official statistics dataset (open-data portal catalogue). Returns ids + metadata, never rows.",
  promptGuidelines: [
    "Use when a question wants NUMBERS from an official source - prices, counts, rates by year or area.",
    "Every query word must appear in the title, agency or description, so keep queries to 2-3 words.",
    "Pass the returned dataset_id to dataset_fetch; searching does not download anything.",
  ],
  description: [
    "Find an official dataset that answers a question with numbers - resale flat prices, licensed",
    "supermarket counts, rainfall records - by searching a government open-data portal catalogue.",
    "Returns dataset ids + metadata only. Portals: data.gov.sg (default).",
  ].join(" "),
  parameters: Type.Object({
    query: Type.String({ description: "2-3 words describing the data, e.g. 'resale flat prices'" }),
    portal: Type.Optional(Type.String({ description: "Portal to search (default: data.gov.sg)" })),
    limit: Type.Optional(Type.Number({ description: "Max datasets (default 10, cap 50)" })),
    refresh: Type.Optional(
      Type.Boolean({
        description:
          "Re-crawl the portal catalogue first (~460 requests, ~20s). Default false; the cache is at most a day old.",
      }),
    ),
  }),
  async execute(_id, params, signal) {
    const data = await post<{
      results: DatasetRef[];
      catalogue_size: number;
      catalogue_age_s: number | null;
      portal: string;
    }>(
      "/dataset/search",
      {
        query: params.query,
        portal: params.portal ?? DEFAULT_PORTAL,
        limit: params.limit ?? 10,
        refresh: params.refresh ?? false,
      },
      240_000,
      signal,
    );

    const { results = [], catalogue_size: size = 0, portal } = data;
    if (results.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text:
            `No dataset on ${portal} matches "${params.query}".\n\n` +
            `Matching requires every word to appear across ${size} datasets - ` +
            `drop the most specific word and retry.`,
        }],
      };
    }

    const rows = results.map((r) =>
      `| \`${r.dataset_id}\` | ${(r.name ?? "").replace(/\|/g, "/").slice(0, 70)} | ` +
      `${r.fmt ?? "?"} | ${(r.agency ?? "").replace(/\|/g, "/").slice(0, 34)} | ` +
      `${(r.updated ?? "").slice(0, 10)} |`,
    );

    return {
      content: [{
        type: "text" as const,
        text: [
          `**${results.length}** dataset(s) on ${portal} matching **${params.query}**`,
          "",
          "| dataset_id | name | fmt | agency | updated |",
          "| --- | --- | --- | --- | --- |",
          ...rows,
          "",
          `_Catalogue: ${size} datasets, ${ageLabel(data.catalogue_age_s)}._ ` +
          "Pass a dataset_id to dataset_fetch to download it.",
        ].join("\n"),
      }],
    };
  },
});

const fetchTool = defineTool({
  name: "dataset_fetch",
  label: "Dataset Fetch",
  promptSnippet:
    "dataset_fetch - download one dataset to a local FILE; returns path + schema + preview, never the rows.",
  promptGuidelines: [
    "Takes a dataset_id from dataset_search.",
    "Rows are deliberately withheld - query the returned path with duckdb / mlr instead.",
    "A repeat fetch of the same dataset is served from the local copy; pass refresh:true to re-download.",
  ],
  description: [
    "Download one dataset to a local file and return its path, columns, row count and a short preview -",
    "deliberately NOT the rows, which are routinely tens of thousands. Query the file with duckdb after.",
  ].join(" "),
  parameters: Type.Object({
    dataset_id: Type.String({ description: "Id from dataset_search, e.g. 'd_8b84c4ee58e3...'" }),
    portal: Type.Optional(Type.String({ description: "Portal the id belongs to (default: data.gov.sg)" })),
    refresh: Type.Optional(Type.Boolean({ description: "Re-download even if already on disk" })),
  }),
  async execute(_id, params, signal) {
    const data = await post<DatasetFile>(
      "/dataset/fetch",
      {
        dataset_id: params.dataset_id,
        portal: params.portal ?? DEFAULT_PORTAL,
        refresh: params.refresh ?? false,
      },
      300_000,
      signal,
    );

    let path = "";
    let note = "";
    try {
      path = await localCopy(data.file_url, data.path);
      const st = await stat(path);
      if (st.size !== data.bytes) {
        note = `local copy is ${st.size} bytes, service reported ${data.bytes}`;
      }
    } catch (err) {
      note =
        `could not copy the file locally (${(err as Error).message}); ` +
        `it is at ${CRAWLER_URL}${data.file_url}`;
    }

    const ref = data.ref ?? ({} as DatasetRef);
    const lines = [
      `# ${ref.name || params.dataset_id}`,
      `_${ref.agency || "unknown agency"} · ${ref.portal || "?"} · ${ref.fmt || "?"}` +
      ` · updated ${(ref.updated ?? "?").slice(0, 10)}_`,
      "",
      `**File:** \`${path || data.path}\``,
      `**Size:** ${data.bytes.toLocaleString()} bytes` +
      (typeof data.rows === "number" ? ` · **Rows:** ${data.rows.toLocaleString()}` : "") +
      (data.cached ? " · _served from an earlier download_" : ""),
    ];
    if (ref.coverage) lines.push(`**Coverage:** ${ref.coverage}`);
    if (note) lines.push(`_${note}_`);

    if (data.columns?.length) {
      lines.push("", "| column | type |", "| --- | --- |");
      for (const c of data.columns) {
        lines.push(`| \`${c.name}\` | ${c.dtype || c.title || ""} |`);
      }
    }
    if (data.preview) lines.push("", "```", data.preview.trimEnd(), "```");
    if (path) {
      lines.push(
        "",
        "_Rows are deliberately not returned. Query the file:_",
        "```sh",
        `duckdb -c "SELECT * FROM '${path}' LIMIT 10"`,
        "```",
      );
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(searchTool);
  pi.registerTool(fetchTool);
}
