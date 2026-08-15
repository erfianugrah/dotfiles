/**
 * osint — OSINT investigations via the research stack's FastAPI service.
 *
 * Wraps `POST https://osint.erfi.io/investigate/{domain,ip,email,username,
 * url,phone,threat,cve,geo,harvest,archive}` (production) /
 * `http://localhost:8890/...` (local dev) with bearer auth from
 * `RESEARCH_TOKEN`. Mirrors the python MCP wrapper at
 * ~/research/mcp/research-server.py + formatters/osint.py but as a single
 * self-contained extension — no async job manager (tool calls block on fetch
 * directly), no caching, just the 11 tools and terse markdown rendering.
 *
 * URL + auth pattern matches web-research.ts / webfetch.ts:
 *   - OSINT_URL env var overrides the default
 *   - RESEARCH_TOKEN env var attaches `Authorization: Bearer …` header
 *
 * Pure request-building / response-projection / rendering lives in
 * ./lib/osint-core.ts (shared with the Claude Code MCP toolkit); this file is
 * the thin pi adapter and re-exports `_internals` so existing importers
 * (tests/extensions.test.ts) keep resolving the formatters here.
 *
 * Tools registered:
 *   osint_domain    — DNS, subdomains, certs (crt.sh), WHOIS
 *   osint_ip        — geo, hostnames, open ports (Shodan InternetDB), CVEs
 *   osint_email     — Holehe platform registrations, HIBP breaches
 *   osint_username  — Sherlock (fast) / Maigret (deep) social-platform scan
 *   osint_url       — urlscan.io recent scans (+ optional submit-now)
 *   osint_phone     — libphonenumber + paid scanner aggregation
 *   osint_threat    — VirusTotal hash/URL/IP/domain reputation
 *   osint_cve       — NVD CVE lookup
 *   osint_geo       — OSM geocode / reverse-geocode / nearby POI by tag
 *   osint_harvest   - theHarvester emails + hosts (slow, ~7min)
 *   archive_lookup  - Wayback change log for a URL (the one temporal tool)
 *   osint_geo_area  - area-wide OSM candidate enumeration (all X in area Y)
 *   osint_geo_panos - server-side street-level pano sweep + contact sheets
 *   osint_geo_sheet - pull one contact sheet locally to eyeball facades
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  authHeaders,
  deltaStr,
  formatArchive,
  formatCve,
  formatDomain,
  formatEmail,
  formatGeo,
  formatGeoArea,
  formatGeoSweep,
  formatHarvest,
  formatIp,
  formatPhone,
  formatThreat,
  formatUrl,
  formatUsername,
  groupByKind,
  metaFooter,
  OSINT_URL,
  osintCall,
  osintDownload,
  poiCategory,
  summarise,
  type GeoSweepResult,
  type Investigation,
} from "./lib/osint-core.ts";

// ── tool definitions ──────────────────────────────────────────────────────

function makeResult(text: string, details: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  return { content: [{ type: "text", text }], details };
}

const osintDomain = defineTool({
  name: "osint_domain",
  promptSnippet: "osint_domain — domain DNS / subdomains / certs / WHOIS via subfinder + crt.sh + RDAP.",
  promptGuidelines: [
    "Pass mode='full' to dump all subdomains (default 'summary' caps at 15).",
    "Slow on first call (~30-90s); subsequent calls hit the upstream cache.",
  ],
  label: "OSINT Domain",
  description: "Domain investigation: DNS records, subdomains (subfinder), certs (crt.sh), WHOIS/RDAP.",
  parameters: Type.Object({
    domain: Type.String({ description: "Domain name (e.g. example.com)" }),
    mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")], {
      description: "Output mode: 'summary' (default, top 15 subdomains) or 'full' (all)",
    })),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/domain",
      { domain: params.domain.trim() },
      180_000,
      signal,
    );
    return makeResult(formatDomain(inv, params.mode ?? "summary"), summarise(inv));
  },
});

const osintIp = defineTool({
  name: "osint_ip",
  promptSnippet: "osint_ip — IP geo / hostnames / open ports (Shodan InternetDB) / CVEs.",
  promptGuidelines: [
    "Pass include_shared_hosts=false to skip the slow hackertarget/OTX passive-DNS lookup.",
  ],
  label: "OSINT IP",
  description: "IP investigation: geolocation, reverse DNS, open ports + CVE tags (Shodan InternetDB), shared hosts.",
  parameters: Type.Object({
    ip: Type.String({ description: "IPv4 or IPv6 address" }),
    include_shared_hosts: Type.Optional(Type.Boolean({
      description: "Include passive-DNS shared-host lookup (default: true; slow on CDN IPs)",
    })),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/ip",
      {
        ip: params.ip.trim(),
        include_shared_hosts: params.include_shared_hosts ?? true,
      },
      30_000,
      signal,
    );
    return makeResult(formatIp(inv), summarise(inv));
  },
});

const osintEmail = defineTool({
  name: "osint_email",
  promptSnippet: "osint_email — Holehe platform registrations + HIBP breach lookup.",
  promptGuidelines: [
    "Slow (~30-180s) — Holehe queries 100+ services serially.",
    "HIBP requires HIBP_API_KEY env on the OSINT service; without it breach lookup is skipped.",
  ],
  label: "OSINT Email",
  description: "Email investigation: which platforms it's registered on (Holehe) + breach exposure (HIBP).",
  parameters: Type.Object({
    email: Type.String({ description: "Email address" }),
    include_breach: Type.Optional(Type.Boolean({
      description: "Include HIBP breach lookup (default: true; needs HIBP_API_KEY on server)",
    })),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/email",
      {
        email: params.email.trim(),
        include_breach: params.include_breach ?? true,
      },
      240_000,
      signal,
    );
    return makeResult(formatEmail(inv), summarise(inv));
  },
});

const osintUsername = defineTool({
  name: "osint_username",
  promptSnippet: "osint_username — social-platform username scan (Sherlock fast / Maigret deep).",
  promptGuidelines: [
    "Default mode='fast' (Sherlock, ~30-60s, ~400 sites).",
    "mode='deep' uses Maigret (~5min, 3000+ sites with recursive pivots) — only when fast turns up nothing useful.",
    "show_all=true to dump >30 hits; otherwise top 30 are shown.",
  ],
  label: "OSINT Username",
  description: "Username scan across social platforms via Sherlock (fast) or Maigret (deep).",
  parameters: Type.Object({
    username: Type.String({ description: "Username / handle to look up" }),
    mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("deep")], {
      description: "'fast' (Sherlock, default) or 'deep' (Maigret, ~5min)",
    })),
    show_all: Type.Optional(Type.Boolean({
      description: "Show all hits instead of top 30 (default: false)",
    })),
  }),
  async execute(_id, params, signal) {
    const mode = params.mode ?? "fast";
    const inv = await osintCall(
      "/investigate/username",
      { username: params.username.trim(), mode },
      mode === "fast" ? 180_000 : 700_000,
      signal,
    );
    return makeResult(formatUsername(inv, mode, params.show_all ?? false), summarise(inv));
  },
});

const osintUrl = defineTool({
  name: "osint_url",
  promptSnippet: "osint_url — urlscan.io recent scans for a URL/domain.",
  promptGuidelines: [
    "Default looks up cached scans only (fast). Pass submit=true to enqueue a new scan (~30-90s).",
  ],
  label: "OSINT URL",
  description: "urlscan.io lookup: recent scan history for a URL/domain. Optional submit=true to scan now.",
  parameters: Type.Object({
    url: Type.String({ description: "URL or domain" }),
    submit: Type.Optional(Type.Boolean({
      description: "Submit a new urlscan.io scan (~30-90s); default false (search cache only)",
    })),
  }),
  async execute(_id, params, signal) {
    const submit = params.submit ?? false;
    const inv = await osintCall(
      "/investigate/url",
      { url: params.url.trim(), submit },
      submit ? 120_000 : 30_000,
      signal,
    );
    return makeResult(formatUrl(inv), summarise(inv));
  },
});

const osintPhone = defineTool({
  name: "osint_phone",
  promptSnippet: "osint_phone — phone number metadata (libphonenumber + paid scanner aggregation).",
  promptGuidelines: [
    "Pass numbers in international format with leading +, e.g. +14155552671.",
    "Most scanners require API keys server-side; without keys only 'local' (libphonenumber) returns data.",
  ],
  label: "OSINT Phone",
  description: "Phone number lookup: libphonenumber metadata + carrier/region/owner data from paid scanners.",
  parameters: Type.Object({
    phone: Type.String({ description: "Phone number in international format (e.g. +14155552671)" }),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/phone",
      { phone: params.phone.trim() },
      10_000,
      signal,
    );
    return makeResult(formatPhone(inv), summarise(inv));
  },
});

const osintThreat = defineTool({
  name: "osint_threat",
  promptSnippet: "osint_threat — VirusTotal reputation for hash / URL / IP / domain.",
  promptGuidelines: [
    "Auto-detects target kind (sha256/md5/sha1 hash, URL, IP, domain).",
    "Requires VT_API_KEY on the OSINT service.",
  ],
  label: "OSINT Threat",
  description: "VirusTotal reputation lookup. Target type (hash/URL/IP/domain) is auto-detected.",
  parameters: Type.Object({
    target: Type.String({ description: "Hash (SHA256/MD5/SHA1), URL, IP, or domain" }),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/threat",
      { target: params.target.trim() },
      30_000,
      signal,
    );
    return makeResult(formatThreat(inv), summarise(inv));
  },
});

const osintCve = defineTool({
  name: "osint_cve",
  promptSnippet: "osint_cve — NVD lookup for a CVE id.",
  promptGuidelines: [
    "Format: CVE-YYYY-NNNNN (e.g. CVE-2021-44228).",
  ],
  label: "OSINT CVE",
  description: "NVD CVE lookup: description, CVSS score+vector, CWE weaknesses, references.",
  parameters: Type.Object({
    cve_id: Type.String({ description: "CVE id (e.g. CVE-2021-44228)" }),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/cve",
      { cve_id: params.cve_id.trim() },
      30_000,
      signal,
    );
    return makeResult(formatCve(inv), summarise(inv));
  },
});

const osintGeo = defineTool({
  name: "osint_geo",
  promptSnippet:
    "osint_geo — geocode a place name, reverse-geocode a coordinate, and find nearby POI (OpenStreetMap).",
  promptGuidelines: [
    "Pass `query` for a place name, or `lat`+`lon` for reverse geocoding. One or the other.",
    "POI search only runs when `tags` is given, e.g. {\"shop\":\"supermarket\",\"railway\":\"station\"}. Values may be '*' to match any.",
    "Amenity-density reconnaissance, not brand completeness — OSM commercial-POI coverage is partial, so treat counts as a floor.",
    "Key-less (Nominatim + Overpass). Overpass rate-limits to 2 concurrent slots and 504s under load; failures are recorded, not raised.",
  ],
  label: "OSINT Geo",
  description:
    "Geocoding and POI search via OpenStreetMap: place name to coordinates, coordinates to address, and nearby features by OSM tag with distances.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Place name to geocode, e.g. 'Choa Chu Kang, Singapore'" })),
    lat: Type.Optional(Type.Number({ description: "Latitude for reverse geocoding / POI search" })),
    lon: Type.Optional(Type.Number({ description: "Longitude for reverse geocoding / POI search" })),
    radius_m: Type.Optional(Type.Number({ description: "POI search radius in metres (default 2000, max 50000)" })),
    tags: Type.Optional(Type.Record(Type.String(), Type.String(), {
      description: "OSM tags to search for, e.g. {'shop':'supermarket'}. Omit to skip POI search.",
    })),
    limit: Type.Optional(Type.Number({ description: "Max results (default 50, max 200)" })),
    mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")], {
      description: "'summary' (default) caps POI output; 'full' lists every hit",
    })),
  }),
  async execute(_id, params, signal) {
    const query = params.query?.trim() || undefined;
    if (!query && (params.lat === undefined || params.lon === undefined)) {
      return makeResult("Error: pass `query`, or both `lat` and `lon`.", { error: true });
    }
    const inv = await osintCall(
      "/investigate/geo",
      {
        query: query ?? null,
        lat: params.lat ?? null,
        lon: params.lon ?? null,
        radius_m: params.radius_m ?? 2000,
        tags: params.tags ?? null,
        limit: params.limit ?? 50,
      },
      60_000,
      signal,
    );
    return makeResult(formatGeo(inv, params.mode ?? "summary"), summarise(inv));
  },
});

const osintHarvest = defineTool({
  name: "osint_harvest",
  promptSnippet: "osint_harvest — theHarvester emails + hosts for a domain (slow, ~7min).",
  promptGuidelines: [
    "Slow (~5-7min). Prefer osint_domain for subdomains-only — harvest is broader (search engines, DNS bruteforce, etc).",
    "Pass sources='bing,duckduckgo' (comma-separated) to scope sources; default uses theHarvester defaults.",
  ],
  label: "OSINT Harvest",
  description: "theHarvester broad sweep: emails + hosts from search engines, certificate logs, DNS bruteforce.",
  parameters: Type.Object({
    domain: Type.String({ description: "Domain to harvest" }),
    sources: Type.Optional(Type.String({
      description: "Comma-separated theHarvester sources (e.g. 'bing,duckduckgo,crtsh'); omit for defaults",
    })),
    limit: Type.Optional(Type.Number({
      description: "Per-source result cap (default 500, max 5000)",
    })),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall(
      "/investigate/harvest",
      {
        domain: params.domain.trim(),
        sources: params.sources ?? null,
        limit: Math.min(Math.max(params.limit ?? 500, 10), 5000),
      },
      420_000,
      signal,
    );
    return makeResult(formatHarvest(inv), summarise(inv));
  },
});

const archiveLookup = defineTool({
  name: "archive_lookup",
  promptSnippet:
    "archive_lookup - Wayback change log for a URL: when a page changed, byte deltas, openable snapshots.",
  promptGuidelines: [
    "The stack's only TEMPORAL tool. Use for what a page USED to say and when it changed - pricing, leadership, policy, claims that quietly disappeared.",
    "Returns the MOST RECENT changes by default (digest-collapsed) - the archive stores many identical copies and only transitions are edits. Pass earliest=true for the origin question ('what did this look like originally').",
    "Byte deltas are for triage, not proof: a small delta is usually a template tweak, a large one a rewrite. Open the snapshot URL to confirm.",
    "Dates are digits only, YYYY[MM[DD]] - a dashed date is rejected rather than silently widening the window.",
    "Absence of captures is not absence of a page: the archive's coverage is uneven, so treat the change count as a floor.",
  ],
  label: "Archive Lookup",
  description:
    "Wayback Machine change log for a URL: when the page changed, with byte deltas and directly-openable archived snapshots.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to look up, e.g. 'example.com/pricing'" }),
    limit: Type.Optional(Type.Number({ description: "Max changes (default 50, cap 200)" })),
    from_date: Type.Optional(Type.String({ description: "Lower bound, digits only: '2021' or '202106'" })),
    to_date: Type.Optional(Type.String({ description: "Upper bound, digits only" })),
    earliest: Type.Optional(Type.Boolean({
      description: "Sample the OLDEST changes instead of the most recent (origin question). Default false.",
    })),
    mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")], {
      description: "'summary' (default) caps at 20 changes; 'full' lists all",
    })),
  }),
  async execute(_id, params, signal) {
    const url = params.url?.trim();
    if (!url) return makeResult("Error: `url` is required.", { error: true });
    const payload: Record<string, unknown> = { url, limit: params.limit ?? 50 };
    if (params.from_date?.trim()) payload.from_date = params.from_date.trim();
    if (params.to_date?.trim()) payload.to_date = params.to_date.trim();
    if (params.earliest) payload.earliest = true;
    const inv = await osintCall("/investigate/archive", payload, 60_000, signal);
    return makeResult(formatArchive(inv, params.mode ?? "summary"), summarise(inv));
  },
});

const osintGeoArea = defineTool({
  name: "osint_geo_area",
  promptSnippet:
    "osint_geo_area - enumerate every POI of a kind across a whole named area (e.g. all hawker centres in Singapore) via Overpass.",
  promptGuidelines: [
    "Area defaults to Singapore. tags values are exact or '*'; name_regex is POSIX (Overpass), always applied case-insensitively.",
    "Pair with osint_geo_panos to street-view-verify the candidates.",
  ],
  label: "OSINT Geo Area",
  description:
    "Area-wide OSM candidate enumeration: every nwr matching tags (+ optional name regex) inside a named administrative area. Returns name | lat,lon | category rows.",
  parameters: Type.Object({
    area: Type.Optional(Type.String({ description: "OSM area name (default: Singapore)" })),
    tags: Type.Record(Type.String(), Type.String(), {
      description: "OSM tags, e.g. {amenity: 'marketplace'}",
    }),
    name_regex: Type.Optional(Type.String({
      description: "POSIX regex on the name tag, e.g. 'food centre|hawker'",
    })),
    limit: Type.Optional(Type.Number({ description: "Max results (default 200, cap 1000)" })),
  }),
  async execute(_id, params, signal) {
    const inv = await osintCall("/geo/area", {
      area: params.area ?? "Singapore",
      tags: params.tags,
      name_regex: params.name_regex ?? null,
      limit: params.limit ?? 200,
    }, 120_000, signal);
    return makeResult(formatGeoArea(inv), summarise(inv));
  },
});

const osintGeoPanos = defineTool({
  name: "osint_geo_panos",
  promptSnippet:
    "osint_geo_panos - fetch street-level panoramas around a point or candidate list, server-side, with directional sampling (rear facades included); builds contact sheets.",
  promptGuidelines: [
    "Runs on servarr; artifacts persist under a sweep_id. Sheets, not raw panos, are what you pull back - the inter-site link is ~1 MB/s.",
    "A sweep of ~190 candidates takes ~8 min. Use osint_geo_sheet to view results.",
    "Negatives mean 'not visible from street coverage', never proof of absence - small podium ducts can sit below sheet resolution.",
  ],
  label: "OSINT Geo Panos",
  description:
    "Keyless street-level pano sweep (Google Street View via streetlevel): candidates -> panos -> manifest + contact sheets, persisted server-side. Returns sweep_id.",
  parameters: Type.Object({
    name: Type.Optional(Type.String({ description: "Label for a single point" })),
    lat: Type.Optional(Type.Number({ description: "Latitude (single-point mode)" })),
    lon: Type.Optional(Type.Number({ description: "Longitude (single-point mode)" })),
    candidates: Type.Optional(Type.Array(Type.Object({
      name: Type.String(),
      lat: Type.Number(),
      lon: Type.Number(),
      note: Type.Optional(Type.String()),
    }), { description: "Batch mode: up to 500 candidates" })),
    radius_m: Type.Optional(Type.Number({ description: "Search radius per seed (default 100)" })),
    cap: Type.Optional(Type.Number({ description: "Max panos per candidate (default 8)" })),
    zoom: Type.Optional(Type.Number({ description: "2=2048px (default), 3=4096" })),
    history: Type.Optional(Type.Boolean({
      description: "Also fetch dated historical panos (demolished buildings)",
    })),
  }),
  async execute(_id, params, signal) {
    const shared = {
      radius_m: params.radius_m ?? 100,
      cap: params.cap ?? 8,
      zoom: params.zoom ?? 2,
      history: params.history ?? false,
    };
    const body = params.candidates
      ? { candidates: params.candidates, ...shared }
      : { name: params.name, lat: params.lat, lon: params.lon, ...shared };
    const r = await osintCall("/geo/panos", body, 900_000, signal) as unknown as GeoSweepResult;
    return makeResult(formatGeoSweep(r), { sweep_id: r.sweep_id });
  },
});

const osintGeoSheet = defineTool({
  name: "osint_geo_sheet",
  promptSnippet:
    "osint_geo_sheet - pull one candidate's contact sheet from a sweep to a local file so you can read it.",
  promptGuidelines: [
    "Returns the LOCAL path - read it with the read tool to eyeball the facades.",
  ],
  label: "OSINT Geo Sheet",
  description:
    "Download one contact sheet from a server-side pano sweep to local disk and report the local path.",
  parameters: Type.Object({
    sweep_id: Type.String({ description: "From osint_geo_panos output" }),
    name: Type.String({ description: "Candidate name (any slugifiable form)" }),
  }),
  async execute(_id, params, signal) {
    const slug = params.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const rel = `${params.sweep_id}/sheets/${slug}.jpg`;
    const local = await osintDownload(
      `/geo/file/${rel}`,
      `${process.env.HOME}/.cache/geo-sheets/${rel}`,
      signal,
    );
    return makeResult(`sheet: ${local}`, { local_path: local });
  },
});

// Exports for unit tests + extension entry. Re-exported from the pure core so
// existing importers (tests/extensions.test.ts) keep resolving them here.
export const _internals = {
  groupByKind,
  metaFooter,
  formatDomain,
  formatIp,
  formatEmail,
  formatUsername,
  formatUrl,
  formatPhone,
  formatThreat,
  formatCve,
  formatHarvest,
  formatGeo,
  formatArchive,
  poiCategory,
  deltaStr,
  authHeaders,
  OSINT_URL,
};

export type { Investigation };

export default function (pi: ExtensionAPI) {
  pi.registerTool(osintDomain);
  pi.registerTool(osintIp);
  pi.registerTool(osintEmail);
  pi.registerTool(osintUsername);
  pi.registerTool(osintUrl);
  pi.registerTool(osintPhone);
  pi.registerTool(osintThreat);
  pi.registerTool(osintCve);
  pi.registerTool(osintGeo);
  pi.registerTool(osintHarvest);
  pi.registerTool(archiveLookup);
  pi.registerTool(osintGeoArea);
  pi.registerTool(osintGeoPanos);
  pi.registerTool(osintGeoSheet);
}
