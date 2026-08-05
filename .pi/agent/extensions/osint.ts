/**
 * osint — OSINT investigations via the research stack's FastAPI service.
 *
 * Wraps `POST https://osint.erfi.io/investigate/{domain,ip,email,username,
 * url,phone,threat,cve,geo,harvest,archive}` (production) /
 * `http://localhost:8890/...` (local dev) with bearer auth from
 * `RESEARCH_TOKEN`. Mirrors the python MCP wrapper at
 * ~/research/mcp/research-server.py + formatters/osint.py but as a single
 * self-contained pi extension — no async job manager (pi tool calls block
 * on fetch directly), no caching, just the 11 tools and terse markdown
 * rendering.
 *
 * URL + auth pattern matches web-research.ts / webfetch.ts:
 *   - OSINT_URL env var overrides the default
 *   - RESEARCH_TOKEN env var attaches `Authorization: Bearer …` header
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
 *   osint_harvest   — theHarvester emails + hosts (slow, ~7min)
 *   archive_lookup  — Wayback change log for a URL (the one temporal tool)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OSINT_URL = process.env.OSINT_URL ?? "https://osint.erfi.io";
const OSINT_URL_IS_DEFAULT = process.env.OSINT_URL === undefined;

function authHeaders(): Record<string, string> {
  const tok = process.env.RESEARCH_TOKEN?.trim();
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

// One-shot warning when the default public endpoint is in use but no bearer
// is set — requests will silently 401. Cheap to fire at module load.
if (OSINT_URL_IS_DEFAULT && !process.env.RESEARCH_TOKEN?.trim()) {
  console.warn(
    `[osint] RESEARCH_TOKEN unset; ${OSINT_URL} will reject requests with 401. ` +
      `Set RESEARCH_TOKEN or point OSINT_URL at a local instance.`,
  );
}

// ── HTTP wrapper ──────────────────────────────────────────────────────────

interface Investigation {
  entity?: string;
  entity_kind?: string;
  findings?: Finding[];
  info?: string[];
  errors?: string[];
  sources_queried?: string[];
  elapsed_ms?: number;
}

interface Finding {
  kind: string;
  value: string;
  extra?: Record<string, unknown>;
}

class OsintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OsintError";
    // Preserve the prototype chain across transpile targets (CJS/ES5) where
    // `extends Error` would otherwise break `instanceof OsintError`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function osintCall(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Investigation> {
  // Combine caller's signal (cancel-from-pi) with our own timeout.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("osint timeout")), timeoutMs);
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(`${OSINT_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OsintError(
        `OSINT HTTP ${res.status} on ${path}${text ? `: ${text.slice(0, 240)}` : ""}`,
      );
    }
    return (await res.json()) as Investigation;
  } catch (err) {
    if (err instanceof OsintError) throw err;
    const reason =
      (err as Error)?.name === "AbortError"
        ? `timed out after ${Math.round(timeoutMs / 1000)}s (or cancelled)`
        : ((err as Error)?.message ?? String(err));
    throw new OsintError(`OSINT call to ${path} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ── shared formatting helpers ─────────────────────────────────────────────

function groupByKind(findings: Finding[] | undefined): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  for (const f of findings ?? []) {
    (out[f.kind] ??= []).push(f);
  }
  return out;
}

function metaFooter(inv: Investigation, extras: string[] = []): string {
  const sources = inv.sources_queried ?? [];
  const errors = inv.errors ?? [];
  const lines = [`_Sources: ${sources.join(", ") || "(none)"} · ${inv.elapsed_ms ?? 0}ms_`];
  if (errors.length) lines.push(`_Issues: ${errors.slice(0, 3).join("; ")}_`);
  for (const ex of extras) lines.push(`_${ex}_`);
  return lines.join("\n");
}

function infoLines(inv: Investigation, prefix: string): string[] {
  return (inv.info ?? []).filter((line) => line.startsWith(prefix));
}

function asString(v: unknown, fallback = "?"): string {
  return v === null || v === undefined || v === "" ? fallback : String(v);
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function capList(items: string[], cap: number): { shown: string[]; truncated: boolean } {
  if (items.length <= cap) return { shown: items, truncated: false };
  return { shown: items.slice(0, cap), truncated: true };
}

// ── per-tool formatters ───────────────────────────────────────────────────

function formatDomain(inv: Investigation, mode: "summary" | "full"): string {
  const domain = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const parts: string[] = [`# Domain investigation: ${domain}`];

  // DNS records grouped by type
  const byType: Record<string, string[]> = {};
  for (const f of grouped["dns_record"] ?? []) {
    const t = asString((f.extra ?? {})["type"]);
    (byType[t] ??= []).push(f.value);
  }
  const dnsLines: string[] = [];
  for (const rtype of ["A", "AAAA", "MX", "NS", "TXT", "CNAME"]) {
    if (byType[rtype]) {
      const vals = byType[rtype];
      const shown = vals.length > 6 ? [...vals.slice(0, 6), `…+${vals.length - 6} more`] : vals;
      dnsLines.push(`  ${rtype}: ${shown.join(", ")}`);
    }
  }
  if (dnsLines.length) parts.push("## DNS\n" + dnsLines.join("\n"));

  // Subdomains
  const subs = [...new Set((grouped["subdomain"] ?? []).map((f) => f.value))].sort();
  if (subs.length) {
    const cap = mode === "summary" ? 15 : subs.length;
    const { shown, truncated } = capList(subs, cap);
    const more = truncated ? `\n_(showing ${cap} of ${subs.length} — pass mode="full" for all)_` : "";
    parts.push(`## Subdomains (${subs.length} unique)\n${shown.join(", ")}${more}`);
  }

  // Certificates (crt.sh)
  const certs = grouped["certificate"] ?? [];
  if (certs.length) {
    const ex = (certs[0].extra ?? {}) as Record<string, unknown>;
    parts.push(
      "## Certificates (crt.sh)\n" +
        `Total: ${asString(ex.total_certs)} · Latest issuer: ${asString(ex.issuer).slice(0, 80)}\n` +
        `Valid ${asString(ex.not_before).slice(0, 10)} → ${asString(ex.not_after).slice(0, 10)}`,
    );
  }

  // WHOIS
  const whois = grouped["whois_field"] ?? [];
  if (whois.length) {
    const wmap: Record<string, string> = {};
    for (const f of whois) {
      const field = asString((f.extra ?? {})["field"]);
      if (!(field in wmap)) wmap[field] = f.value;
    }
    const wanted = ["registrar", "created", "expires", "dnssec"];
    const lp = wanted.filter((k) => k in wmap).map((k) => `${k}=${wmap[k]}`);
    if (lp.length) parts.push("## WHOIS\n" + lp.join(" · "));
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

function formatIp(inv: Investigation): string {
  const ip = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const parts: string[] = [`# IP investigation: ${ip}`];

  const geo = grouped["geolocation"] ?? [];
  if (geo.length) {
    const ex = (geo[0].extra ?? {}) as Record<string, unknown>;
    const right = ex.org ?? ex.asn;
    parts.push(
      "## Geolocation\n" +
        `${asString(ex.country)} · ${asString(ex.city)} · ${asString(right)}`,
    );
  }

  const hostnames = [...new Set((grouped["hostname"] ?? []).map((f) => f.value))].sort();
  if (hostnames.length) parts.push("## Hostnames\n" + hostnames.slice(0, 8).join(", "));

  const ports = [...new Set(
    (grouped["open_port"] ?? [])
      .map((f) => parseInt(f.value, 10))
      .filter((n) => Number.isFinite(n)),
  )].sort((a, b) => a - b);
  if (ports.length) parts.push("## Open ports (Shodan InternetDB)\n" + ports.join(", "));

  const tags = grouped["vuln_tag"] ?? [];
  const cves = tags.filter((f) => Boolean((f.extra ?? {})["is_cve"]));
  const plain = tags.filter((f) => !(f.extra ?? {})["is_cve"]);
  if (plain.length) parts.push("## Tags\n" + plain.map((f) => f.value).join(", "));
  if (cves.length) parts.push("## CVEs\n" + cves.slice(0, 10).map((f) => f.value).join(", "));

  const shared = [...new Set((grouped["shared_host"] ?? []).map((f) => f.value))].sort();
  if (shared.length) {
    const { shown, truncated } = capList(shared, 15);
    const more = truncated
      ? `\n_(showing 15 of ${shared.length} — IP may be a shared CDN)_`
      : "";
    parts.push(`## Shared hosts (${shared.length} unique)\n${shown.join(", ")}${more}`);
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

function formatEmail(inv: Investigation): string {
  const email = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const parts: string[] = [`# Email investigation: ${email}`];

  const regs = [...new Set((grouped["platform_registration"] ?? []).map((f) => f.value))].sort();
  if (regs.length) {
    parts.push(`## Registered on ${regs.length} services (Holehe)\n${regs.join(", ")}`);
  } else {
    parts.push("## Holehe\nNo platform registrations detected.");
  }

  const breaches = grouped["breach"] ?? [];
  if (breaches.length) {
    const lines = breaches.map((b) => {
      const ex = (b.extra ?? {}) as Record<string, unknown>;
      const dc = (ex.data_classes as string[] | undefined) ?? [];
      return (
        `- **${asString(ex.title, b.value)}** (${asString(ex.breach_date)}) ` +
        `· ${asString(ex.pwn_count)} accounts · ${dc.slice(0, 5).join(", ")}`
      );
    });
    parts.push(`## Breaches (HIBP) — ${breaches.length} known\n${lines.join("\n")}`);
  } else if ((inv.sources_queried ?? []).includes("haveibeenpwned")) {
    parts.push("## Breaches (HIBP)\nNo breaches found.");
  } else {
    parts.push("## Breaches (HIBP)\n_API key not set — pass HIBP_API_KEY env to enable._");
  }

  parts.push(metaFooter(inv, infoLines(inv, "holehe:")));
  return parts.join("\n\n");
}

function formatUsername(
  inv: Investigation,
  mode: "fast" | "deep",
  showAll: boolean,
): string {
  const username = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const accounts = grouped["account"] ?? [];
  const parts: string[] = [`# Username investigation: ${username}  (${mode})`];

  if (!accounts.length) {
    parts.push("No accounts found.");
  } else {
    const cap = showAll ? accounts.length : 30;
    const shown = accounts.slice(0, cap);
    const lines = shown.map(
      (a) => `- **${asString((a.extra ?? {})["platform"])}**: ${a.value}`,
    );
    let header = `## Confirmed accounts (${accounts.length} hits)`;
    if (accounts.length > cap) header += ` — showing top ${cap}, pass show_all=true for the rest`;
    parts.push(header + "\n" + lines.join("\n"));
  }

  const tool = mode === "deep" ? "maigret" : "sherlock";
  const extras = infoLines(inv, `${tool}:`);
  if (mode !== "deep") {
    extras.push('Run with mode="deep" for Maigret (~5min, 3000+ sites, recursive pivots).');
  }
  parts.push(metaFooter(inv, extras));
  return parts.join("\n\n");
}

function formatUrl(inv: Investigation): string {
  const url = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const scans = grouped["scan_result"] ?? [];
  const parts: string[] = [`# URL investigation: ${url}`];

  if (!scans.length) {
    parts.push(
      "No urlscan.io scans found for this domain. Pass `submit=true` to scan now.",
    );
  } else {
    const lines = scans.slice(0, 5).map((s) => {
      const ex = (s.extra ?? {}) as Record<string, unknown>;
      const verdict = ex.malicious ? "⚠ malicious" : "clean";
      const asn = asString(ex.asn, "").trim();
      const asnname = asString(ex.asnname, "").slice(0, 40);
      const asnStr = `${asn} ${asnname}`.trim() || "?";
      return (
        `- ${asString(ex.url).slice(0, 80)}\n` +
        `  IP: ${asString(ex.ip)} · ${asString(ex.country)} · ${asnStr}\n` +
        `  ${asString(ex.scan_time)} · ${verdict}`
      );
    });
    parts.push(`## urlscan.io — ${scans.length} recent scans\n${lines.join("\n")}`);
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

function formatPhone(inv: Investigation): string {
  const number = asString(inv.entity);
  const findings = inv.findings ?? [];
  const parts: string[] = [`# Phone investigation: ${number}`];

  if (!findings.length) {
    parts.push("No data returned. Most scanners require API keys; only 'local' is free.");
  } else {
    const byScanner: Record<string, Record<string, unknown>> = {};
    for (const f of findings) {
      const ex = (f.extra ?? {}) as Record<string, unknown>;
      const scanner = asString(ex.scanner);
      const target = (byScanner[scanner] ??= {});
      for (const [k, v] of Object.entries(ex)) {
        if (k === "scanner") continue;
        if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
        target[k] = v;
      }
    }
    for (const [scanner, fields] of Object.entries(byScanner)) {
      const lines = [`## ${scanner}`];
      for (const [k, v] of Object.entries(fields)) lines.push(`- ${k}: ${JSON.stringify(v)}`);
      parts.push(lines.join("\n"));
    }
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

function formatThreat(inv: Investigation): string {
  const target = asString(inv.entity);
  const kind = asString(inv.entity_kind);
  const grouped = groupByKind(inv.findings);
  const rep = grouped["reputation"] ?? [];
  const detections = grouped["detection"] ?? [];
  const parts: string[] = [`# Threat lookup: ${target}  (${kind})`];

  if (!rep.length) {
    const info = inv.info ?? [];
    const errors = inv.errors ?? [];
    if (info.some((m) => m.includes("VT_API_KEY"))) {
      parts.push("VirusTotal lookup unavailable: VT_API_KEY not set in environment.");
    } else if (info.some((m) => m.includes("could not classify"))) {
      parts.push(`Could not auto-detect '${target}' as hash/URL/IP/domain.`);
    } else if (errors.length) {
      parts.push("Lookup failed — see footer for details.");
    } else {
      parts.push("No reputation data available (target not in VT corpus).");
    }
  } else {
    const ex = (rep[0].extra ?? {}) as Record<string, unknown>;
    const m = asNumber(ex.malicious);
    const s = asNumber(ex.suspicious);
    const h = asNumber(ex.harmless);
    const verdict = m > 0 ? "⚠ malicious" : s > 0 ? "? suspicious" : "clean";
    parts.push(
      `## Verdict: ${verdict}\n` +
        `${m} malicious · ${s} suspicious · ${h} harmless · ${asNumber(ex.undetected)} undetected ` +
        `(total ${asNumber(ex.total)} engines)`,
    );

    const facts: string[] = [];
    for (const [key, label] of [
      ["magic", "type"],
      ["size", "size (B)"],
      ["country", "country"],
      ["asn", "ASN"],
      ["as_owner", "AS"],
      ["registrar", "registrar"],
      ["reputation", "reputation"],
    ] as const) {
      const v = ex[key];
      if (v !== null && v !== undefined && v !== "" && v !== 0) facts.push(`- ${label}: ${v}`);
    }
    if (facts.length) parts.push("## Facts\n" + facts.join("\n"));

    const tags = (ex.tags as string[] | undefined) ?? [];
    if (tags.length) parts.push("## Tags\n" + tags.slice(0, 10).join(", "));

    if (detections.length) {
      const lines = detections.map((d) => {
        const de = (d.extra ?? {}) as Record<string, unknown>;
        return `- **${d.value}**: ${asString(de.result)} (${asString(de.category)})`;
      });
      parts.push(`## Sample flagged engines (top ${detections.length})\n${lines.join("\n")}`);
    }
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

function formatCve(inv: Investigation): string {
  const cveId = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const cves = grouped["cve"] ?? [];
  const parts: string[] = [`# CVE lookup: ${cveId}`];

  if (!cves.length) {
    const info = inv.info ?? [];
    const errors = inv.errors ?? [];
    if (info.some((m) => m.includes("not a valid CVE id"))) {
      parts.push(`\`${cveId}\` is not a valid CVE id. Expected format: CVE-YYYY-NNNNN.`);
    } else if (info.some((m) => m.includes("no record"))) {
      parts.push(`NVD has no record for ${cveId}.`);
    } else if (errors.length) {
      parts.push("Lookup failed — see footer for details.");
    } else {
      parts.push("No data returned.");
    }
    parts.push(metaFooter(inv));
    return parts.join("\n\n");
  }

  const ex = (cves[0].extra ?? {}) as Record<string, unknown>;
  const score = ex.cvss_score;
  const severity = ex.cvss_severity;
  const version = ex.cvss_version;
  const summary: string[] = [`## Summary (${cveId})`];
  if (score !== undefined && severity) {
    summary.push(`CVSS v${asString(version)}: **${score} (${severity})**`);
  } else if (severity) {
    summary.push(`CVSS v${asString(version)} severity: **${severity}**`);
  }
  const pub = asString(ex.published, "").slice(0, 10);
  const mod = asString(ex.modified, "").slice(0, 10);
  if (pub) summary.push(`Published: ${pub}` + (mod && mod !== pub ? ` · Modified: ${mod}` : ""));
  parts.push(summary.join("\n"));

  let desc = asString(ex.description, "").trim();
  if (desc) {
    if (desc.length > 700) desc = desc.slice(0, 700).trimEnd() + "…";
    parts.push("## Description\n" + desc);
  }

  const cwes = (ex.cwes as string[] | undefined) ?? [];
  if (cwes.length) parts.push("## Weaknesses\n" + cwes.slice(0, 8).join(", "));

  const vector = ex.cvss_vector;
  if (vector) parts.push(`## CVSS vector\n\`${vector}\``);

  const refs = (ex.references as string[] | undefined) ?? [];
  const refTotal = asNumber(ex.ref_total, refs.length);
  if (refs.length) {
    const cap = 5;
    const shown = refs.slice(0, cap).map((u) => `- ${u}`);
    const more = refTotal > cap ? `\n_(showing ${cap} of ${refTotal} references)_` : "";
    parts.push(`## References (${refTotal})\n${shown.join("\n")}${more}`);
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

function formatHarvest(inv: Investigation): string {
  const domain = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const parts: string[] = [`# Harvest: ${domain}`];

  const emails = [...new Set((grouped["harvested_email"] ?? []).map((f) => f.value))].sort();
  const hosts = [...new Set((grouped["harvested_host"] ?? []).map((f) => f.value))].sort();

  if (emails.length) {
    const { shown, truncated } = capList(emails, 30);
    const more = truncated ? `\n_(showing 30 of ${emails.length})_` : "";
    parts.push(`## Emails (${emails.length})\n${shown.join(", ")}${more}`);
  }
  if (hosts.length) {
    const { shown, truncated } = capList(hosts, 30);
    const more = truncated ? `\n_(showing 30 of ${hosts.length})_` : "";
    parts.push(`## Hosts (${hosts.length})\n${shown.join(", ")}${more}`);
  }
  if (!emails.length && !hosts.length) parts.push("No emails or hosts harvested.");

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

// Category tags worth grouping POIs under. Order matters: the first match
// wins. Transit keys are included because MRT stations carry railway=station
// with no amenity/shop/leisure tag, and falling through to an arbitrary tag
// value grouped five of them under "Singapore" (from network=Singapore).
const POI_CATEGORY_KEYS = [
  "amenity", "shop", "tourism", "leisure", "railway", "public_transport",
  "highway", "building",
] as const;

const POI_CAP = 25;

function poiCategory(tags: Record<string, unknown>): string {
  for (const key of POI_CATEGORY_KEYS) {
    const v = tags[key];
    if (typeof v === "string" && v) return v;
  }
  return "other";
}

function formatGeo(inv: Investigation, mode: "summary" | "full" = "summary"): string {
  const entity = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const geocodes = grouped["geocode"] ?? [];
  const pois = grouped["poi"] ?? [];
  const parts: string[] = [`# Location: ${entity}`];

  if (geocodes.length) {
    const ex = (geocodes[0].extra ?? {}) as Record<string, unknown>;
    const meta = [ex.type, ex.osm].filter((v) => typeof v === "string" && v);
    const coord = `Coordinates: ${ex.lat}, ${ex.lon}`;
    parts.push(meta.length ? `${coord}  (${meta.join(", ")})` : coord);
  } else if (!pois.length) {
    parts.push("No location data returned.");
  }

  if (pois.length) {
    const byCat: Record<string, Finding[]> = {};
    for (const p of pois) {
      const tags = ((p.extra ?? {}) as Record<string, unknown>).tags ?? {};
      (byCat[poiCategory(tags as Record<string, unknown>)] ??= []).push(p);
    }
    const dist = (f: Finding) => {
      const d = ((f.extra ?? {}) as Record<string, unknown>).distance_m;
      return typeof d === "number" ? d : Number.POSITIVE_INFINITY;
    };
    const cap = mode === "full" ? pois.length : POI_CAP;
    let rendered = 0;
    const lines: string[] = ["## POI nearby"];

    for (const cat of Object.keys(byCat).sort()) {
      const items = byCat[cat].sort((a, b) => dist(a) - dist(b));
      lines.push(`\n### ${cat} (${items.length})`);
      for (const p of items) {
        if (rendered >= cap) break;
        const d = dist(p);
        const suffix = Number.isFinite(d) ? ` \u00b7 ${Math.round(d)}m` : "";
        lines.push(`- ${asString(p.value)}${suffix}`);
        rendered++;
      }
      if (rendered >= cap) break;
    }
    if (rendered < pois.length) {
      lines.push(`\n_${pois.length - rendered} more POI not shown - pass mode='full'._`);
    }
    parts.push(lines.join("\n"));
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

const ARCHIVE_CAP = 20;

function deltaStr(delta: unknown): string {
  if (typeof delta !== "number") return "";
  if (delta === 0) return "  (same size)";
  return `  (${delta > 0 ? "+" : ""}${delta} bytes)`;
}

function formatArchive(inv: Investigation, mode: "summary" | "full" = "summary"): string {
  const entity = asString(inv.entity);
  const snaps = groupByKind(inv.findings)["snapshot"] ?? [];
  const parts: string[] = [`# Archive history: ${entity}`];

  if (!snaps.length) {
    const info = (inv.info ?? []) as string[];
    const errors = (inv.errors ?? []) as string[];
    parts.push(info.length ? info.join("\n") : errors.length ? errors.join("\n") : "No captures.");
    parts.push(metaFooter(inv));
    return parts.join("\n\n");
  }

  const ts = (f: Finding) => asString(((f.extra ?? {}) as Record<string, unknown>).timestamp);
  const ordered = [...snaps].sort((a, b) => ts(a).localeCompare(ts(b)));
  const firstEx = (ordered[0].extra ?? {}) as Record<string, unknown>;
  const lastEx = (ordered[ordered.length - 1].extra ?? {}) as Record<string, unknown>;
  let window = `${ordered.length} content changes`;
  if (firstEx.iso && lastEx.iso && firstEx.iso !== lastEx.iso) {
    window += ` between ${firstEx.iso} and ${lastEx.iso}`;
  }
  parts.push(window);

  const cap = mode === "full" ? ordered.length : ARCHIVE_CAP;
  const lines: string[] = ["## Changes"];
  for (const snap of ordered.slice(0, cap)) {
    const ex = (snap.extra ?? {}) as Record<string, unknown>;
    const status = ex.status === "200" ? "" : ` [${asString(ex.status)}]`;
    lines.push(`- ${asString(ex.iso) || asString(snap.value)}${status}${deltaStr(ex.delta_bytes)}\n  ${asString(ex.url)}`);
  }
  parts.push(lines.join("\n"));
  if (ordered.length > cap) {
    parts.push(`_(showing ${cap} of ${ordered.length} changes - pass mode='full' for all)_`);
  }

  parts.push(metaFooter(inv));
  return parts.join("\n\n");
}

// ── tool definitions ──────────────────────────────────────────────────────

function makeResult(text: string, details: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  return { content: [{ type: "text", text }], details };
}

function summarise(inv: Investigation): Record<string, unknown> {
  return {
    entity: inv.entity,
    findings: (inv.findings ?? []).length,
    sources: inv.sources_queried ?? [],
    elapsed_ms: inv.elapsed_ms ?? 0,
    errors: inv.errors ?? [],
  };
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
    "osint_geo \u2014 geocode a place name, reverse-geocode a coordinate, and find nearby POI (OpenStreetMap).",
  promptGuidelines: [
    "Pass `query` for a place name, or `lat`+`lon` for reverse geocoding. One or the other.",
    "POI search only runs when `tags` is given, e.g. {\"shop\":\"supermarket\",\"railway\":\"station\"}. Values may be '*' to match any.",
    "Amenity-density reconnaissance, not brand completeness \u2014 OSM commercial-POI coverage is partial, so treat counts as a floor.",
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

// Exports for unit tests + extension entry.
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
}
