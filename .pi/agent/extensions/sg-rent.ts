/**
 * sg_rent_comps / sg_refresh - Singapore rental market evidence from official data.
 *
 * HDB per-transaction rentals (block, flat type, monthly rent since 2021) and
 * URA per-project condo rental percentiles, compacted server-side by the
 * crawler service's /sg/* endpoints. Answers "is this listing overpriced" and
 * "what does a 4-room near X actually rent for" without touching portals.
 *
 * Radius comps need the block-coords map (scripts/geocode_hdb_blocks.py
 * output in the service's DATASET_DIR); without it the service degrades to
 * town-level comps and says so.
 *
 * Endpoint: https://crawler.erfi.io/sg/* (Caddy bearer, same gate as the
 * rest of the research stack). Override CRAWLER_URL for local dev at :8889.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CRAWLER_URL = process.env.CRAWLER_URL ?? "https://crawler.erfi.io";

function authHeaders(): Record<string, string> {
  const tok = process.env.RESEARCH_TOKEN?.trim();
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

async function post<T>(path: string, payload: unknown, timeoutMs: number,
                       signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("sg timeout")), timeoutMs);
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

interface FlatStats {
  n: number;
  mean: number;
  p25: number;
  median: number;
  p75: number;
  pct_change?: number | null;
}

interface CompsResult {
  mode: string;
  found?: number;
  radius_m?: number;
  window?: string;
  flats?: Record<string, FlatStats>;
  nearest_blocks?: { block: string; town: string; dist_m: number; n: number; geo_source: string }[];
  matches?: {
    project: string; district: string; latest_qtr: string;
    psf_p25: number; psf_median: number; psf_p75: number;
    contracts: number; quarters: number;
  }[];
  resolved?: string;
  degraded?: boolean;
  note?: string;
  town?: string;
}

function renderFlats(flats: Record<string, FlatStats>): string[] {
  const lines = ["| flat type | n | p25 | median | p75 | trend |", "| --- | --- | --- | --- | --- | --- |"];
  for (const [flat, s] of Object.entries(flats)) {
    const trend = s.pct_change === null || s.pct_change === undefined
      ? "-" : `${s.pct_change > 0 ? "+" : ""}${s.pct_change}%`;
    lines.push(`| ${flat} | ${s.n} | $${s.p25.toLocaleString()} | $${s.median.toLocaleString()} | $${s.p75.toLocaleString()} | ${trend} |`);
  }
  return lines;
}

const compsTool = defineTool({
  name: "sg_rent_comps",
  label: "SG Rent Comps",
  promptSnippet:
    "sg_rent_comps - official SG rental comps: HDB per-transaction rents near an address, or URA per-project condo rent percentiles.",
  promptGuidelines: [
    "Use for 'is this SG rental listing overpriced', 'what do 4-rooms near X rent for', condo project rent history.",
    "Pass address for HDB radius comps, project for condo name search. flat_type like '4-ROOM' narrows HDB.",
    "If the result says degraded/town-level, the block-coords map is missing - town comps are coarser but still official data.",
  ],
  description: [
    "Singapore rental comparables from official data (HDB per-transaction rentals since 2021,",
    "URA quarterly per-project condo rent percentiles). Pass an address (HDB radius comps),",
    "lat+lon, or a condo project name. Returns median/p25/p75 rents and trend, never raw rows.",
  ].join(" "),
  parameters: Type.Object({
    address: Type.Optional(Type.String({ description: "SG address or block, e.g. 'Blk 105 Ang Mo Kio Ave 4'" })),
    lat: Type.Optional(Type.Number({ description: "Latitude (with lon, skips geocoding)" })),
    lon: Type.Optional(Type.Number({ description: "Longitude (with lat)" })),
    flat_type: Type.Optional(Type.String({ description: "HDB flat type filter, e.g. '4-ROOM'" })),
    project: Type.Optional(Type.String({ description: "Condo project name (substring match), e.g. '18 WOODSVILLE'" })),
    radius_m: Type.Optional(Type.Number({ description: "Search radius for HDB comps (default 800, max 5000)" })),
    months: Type.Optional(Type.Number({ description: "Window back from latest data month (default 12, max 60)" })),
  }),
  async execute(_id, params, signal) {
    const data = await post<CompsResult>(
      "/sg/rent-comps",
      {
        address: params.address,
        lat: params.lat,
        lon: params.lon,
        flat_type: params.flat_type,
        project: params.project,
        radius_m: params.radius_m ?? 800,
        months: params.months ?? 12,
      },
      60_000,
      signal,
    );

    const lines: string[] = [];
    if (data.mode === "project") {
      const matches = data.matches ?? [];
      if (matches.length === 0) {
        lines.push(`No URA project matching "${params.project}".`);
      } else {
        lines.push(`**URA condo rental percentiles** (latest quarter per project, $psf/mo)`);
        lines.push("", "| project | district | qtr | p25 | median | p75 | contracts |", "| --- | --- | --- | --- | --- | --- | --- |");
        for (const m of matches) {
          lines.push(`| ${m.project} | D${m.district} | ${m.latest_qtr} | ${m.psf_p25} | ${m.psf_median} | ${m.psf_p75} | ${m.contracts} |`);
        }
      }
    } else {
      const flats = data.flats ?? {};
      const n = Object.keys(flats).length;
      if (n === 0) {
        lines.push(`No HDB rental comps found (mode: ${data.mode}). ${data.note ?? "Widen radius_m or months."}`);
      } else {
        lines.push(
          `**HDB rental comps** - ${data.mode === "town" ? `town-level (${data.town})` : `${data.found} blocks within ${data.radius_m}m`} · window ${data.window}`,
        );
        if (data.degraded) lines.push(`_${data.note}_`);
        lines.push("", ...renderFlats(flats));
        if (data.nearest_blocks?.length) {
          lines.push("", "Nearest blocks: " + data.nearest_blocks
            .map((b) => `${b.block} (${b.dist_m}m, n=${b.n})`).join("; "));
        }
      }
    }
    if (data.resolved) lines.push("", `_Resolved: ${data.resolved}_`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

const nuisanceTool = defineTool({
  name: "sg_nuisance",
  label: "SG Nuisance Layers",
  promptSnippet:
    "sg_nuisance - official-data location hazards for an SG point: dengue clusters, URA Master Plan zoning (here + nearby), rail/expressway distances.",
  promptGuidelines: [
    "Use for rental due diligence: 'what is wrong with this location' - dengue, what can be built next door, MRT viaduct / expressway noise.",
    "Layers degrade independently: a 'missing' note means that layer's asset is not on the box yet, not zero risk.",
  ],
  description: [
    "Location-hazard check for a Singapore point: active NEA dengue clusters containing the point,",
    "URA Master Plan 2025 zone of the plot and nearby plots (what may be built next door),",
    "and nearest rail/expressway distances from OSM. Pass lat+lon (geocode first with osint_geo if needed).",
  ].join(" "),
  parameters: Type.Object({
    lat: Type.Number({ description: "Latitude" }),
    lon: Type.Number({ description: "Longitude" }),
    radius_m: Type.Optional(Type.Number({ description: "Zoning nearby radius (default 250, max 2000)" })),
  }),
  async execute(_id, params, signal) {
    const data = await post<{
      dengue_clusters: { locality: string; case_size: number }[];
      master_plan: { zone_here?: string[]; zones_nearby?: string[]; missing?: string };
      transport_1000m: Record<string, number | string>;
    }>(
      "/sg/nuisance",
      { lat: params.lat, lon: params.lon, radius_m: params.radius_m ?? 250 },
      90_000,
      signal,
    );

    const lines: string[] = [];
    const dengue = data.dengue_clusters ?? [];
    if (dengue.length === 0) {
      lines.push("**Dengue:** no active cluster at this point");
    } else {
      lines.push("**Dengue clusters containing this point:**");
      for (const c of dengue) lines.push(`- ${c.locality} (${c.case_size} cases)`);
    }
    const mp = data.master_plan ?? {};
    if (mp.missing) {
      lines.push(`\n**Master Plan zoning:** ${mp.missing}`);
    } else {
      lines.push(`\n**Master Plan 2025 zone here:** ${(mp.zone_here ?? []).join(", ") || "none"}`);
      if (mp.zones_nearby?.length) {
        lines.push(`Nearby (what could be built next door): ${mp.zones_nearby.join(", ")}`);
      }
    }
    const t = data.transport_1000m ?? {};
    if (typeof t.missing === "string") {
      lines.push(`\n**Transport noise:** ${t.missing}`);
    } else {
      const parts = Object.entries(t).map(([k, v]) => `${k}: ${v}m`);
      lines.push(`\n**Transport proximity (1km):** ${parts.length ? parts.join(" · ") : "none within 1km"}`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

const reputationTool = defineTool({
  name: "place_reputation",
  label: "Place Reputation",
  promptSnippet:
    "place_reputation - community-complaint digest for a place (estate/condo/area): Reddit + HardwareZone + Lemon8 + web, distilled to themes by the local LLM.",
  promptGuidelines: [
    "Use for 'what do people complain about in <estate/condo>', rental due diligence, area red flags.",
    "Works best with a specific name ('Tampines GreenVines', 'Blk 105 Ang Mo Kio') not a bare town.",
    "Slow (~1-3 min): searches, fetches up to 8 pages, then summarizes. summarize:false for raw sources only.",
  ],
  description: [
    "Harvest community complaints about a place (reddit, HardwareZone, Lemon8, web) and return a",
    "distilled digest: complaint themes with counts, representative quotes, and an overall verdict.",
    "Summarized server-side by the local 9B model; sources list included for drill-in.",
  ].join(" "),
  parameters: Type.Object({
    place: Type.String({ description: "Estate/condo/area name, e.g. 'Tampines GreenVines'" }),
    max_sources: Type.Optional(Type.Number({ description: "Pages to fetch (default 8, max 16)" })),
    summarize: Type.Optional(Type.Boolean({ description: "LLM-distill themes (default true)" })),
  }),
  async execute(_id, params, signal) {
    const data = await post<{
      sources: { source: string; url: string; title: string; snippet_only: boolean }[];
      summary: string | null;
      note: string | null;
    }>(
      "/reputation",
      { place: params.place, max_sources: params.max_sources ?? 8, summarize: params.summarize ?? true },
      300_000,
      signal,
    );

    const lines: string[] = [];
    if (data.summary) {
      lines.push(data.summary);
    }
    if (data.note) lines.push(`_${data.note}_`);
    if (data.sources.length) {
      lines.push("", "Sources:");
      for (const s of data.sources) {
        lines.push(`- [${s.source}${s.snippet_only ? ", snippet-only" : ""}] ${s.title} - ${s.url}`);
      }
    } else {
      lines.push("No sources found for this place.");
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

const sunTool = defineTool({
  name: "sg_sun",
  label: "SG Sun Scorer",
  promptSnippet:
    "sg_sun - direct-sun hours on an SG unit's window by month + west-sun verdict, modelled from real building heights (HDB + OSM).",
  promptGuidelines: [
    "Use for 'does this unit get west sun', 'how much direct sun does floor N facing X get'.",
    "facing: 0=N, 90=E, 180=S, 270=W. floor: the unit's floor number.",
    "Read notes[]: missing height layers mean unshaded-sky results, not an unblocked window.",
  ],
  description: [
    "Model direct sun on a Singapore unit's window by month: pysolar sun path vs a horizon built",
    "from real building heights (HDB max_floor_lvl + OSM building:levels within 400-500m).",
    "Returns monthly direct-sun hours, a west-sun-after-3pm verdict, and the biggest obstructions in view.",
  ].join(" "),
  parameters: Type.Object({
    address: Type.Optional(Type.String({ description: "SG address/block (geocoded server-side)" })),
    lat: Type.Optional(Type.Number({ description: "Latitude (with lon)" })),
    lon: Type.Optional(Type.Number({ description: "Longitude (with lat)" })),
    floor: Type.Optional(Type.Number({ description: "Unit floor number (default 10)" })),
    facing: Type.Number({ description: "Window facing in degrees: 0=N, 90=E, 180=S, 270=W" }),
  }),
  async execute(_id, params, signal) {
    const data = await post<{
      monthly: { month: number; day: string; direct_hours: number; post_3pm_hours: number }[];
      avg_direct_hours: number;
      west_sun_after_3pm: { verdict: boolean; max_hours: number };
      obstructions_in_view: { name: string; elev_deg: number; dist_m: number }[];
      horizon_sources: Record<string, number>;
      notes: string[];
      resolved: string;
    }>(
      "/sg/sun",
      {
        address: params.address, lat: params.lat, lon: params.lon,
        floor: params.floor ?? 10, facing: params.facing,
      },
      120_000,
      signal,
    );

    const lines = [
      `**Sun model** for floor ${params.floor ?? 10} facing ${params.facing} deg (${data.resolved})`,
      `Average direct sun: **${data.avg_direct_hours}h/day** · West sun after 3pm: **${data.west_sun_after_3pm.verdict ? "YES" : "no"}** (up to ${data.west_sun_after_3pm.max_hours}h)`,
      "",
      "| month | direct h | post-3pm h |",
      "| --- | --- | --- |",
      ...data.monthly.map((m) => `| ${m.month} | ${m.direct_hours} | ${m.post_3pm_hours} |`),
    ];
    if (data.obstructions_in_view.length) {
      lines.push("", "Biggest obstructions in view:");
      for (const o of data.obstructions_in_view) {
        lines.push(`- ${o.name} - ${o.elev_deg} deg up, ${o.dist_m}m away`);
      }
    }
    const hs = data.horizon_sources;
    lines.push("", `_Horizon: ${hs.hdb_blocks ?? 0} HDB blocks + ${hs.osm_buildings ?? 0} OSM buildings. ${(data.notes ?? []).join(" ")}_`);
    return { content: [{ type: 'text' as const, text: lines.join("\n") }] };
  },
});

const refreshTool = defineTool({
  name: "sg_refresh",
  label: "SG Data Refresh",
  promptSnippet:
    "sg_refresh - re-download the SG rental datasets (HDB rentals, URA condo rentals, HDB block info) and rebuild the comps assets.",
  promptGuidelines: [
    "Monthly maintenance or when comps look stale (window end months behind). Runs ~1-2 min.",
  ],
  description:
    "Re-download the three data.gov.sg series behind sg_rent_comps and rebuild the compact assets file. Run monthly or when the comps window lags.",
  parameters: Type.Object({}),
  async execute(_id, _params, signal) {
    const data = await post<{
      assets: string; hdb_blocks_with_rentals: number;
      hdb_blocks_total: number; condo_projects: number; latest_hdb_month: number;
    }>("/sg/refresh", {}, 300_000, signal);
    return {
      content: [{
        type: "text" as const,
        text: [
          "SG rental assets rebuilt:",
          `- HDB blocks with rentals: ${data.hdb_blocks_with_rentals.toLocaleString()} (of ${data.hdb_blocks_total.toLocaleString()} blocks)`,
          `- Condo projects: ${data.condo_projects.toLocaleString()}`,
          `- Latest HDB rental month: ${data.latest_hdb_month}`,
        ].join("\n"),
      }],
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(compsTool);
  pi.registerTool(nuisanceTool);
  pi.registerTool(reputationTool);
  pi.registerTool(sunTool);
  pi.registerTool(refreshTool);
}
