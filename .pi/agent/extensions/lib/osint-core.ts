/**
 * osint-core - pure OSINT request-building, HTTP call, response projection, and
 * per-tool markdown rendering, plus a harness-agnostic orchestrator. ZERO
 * harness imports (node stdlib + global fetch only). Source of truth for the pi
 * adapter (../osint.ts) and the Claude Code MCP toolkit
 * (../../../.claude/mcp/toolkit.ts).
 *
 * Wraps `POST {OSINT_URL}/investigate/{domain,ip,email,username,url,phone,
 * threat,cve,geo,harvest,archive}` + the `/geo/*` pano-sweep family with
 * bearer auth from RESEARCH_TOKEN.
 *
 * Extracted from osint.ts (2026-08-12); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const OSINT_URL = process.env.OSINT_URL ?? "https://osint.erfi.io";
const OSINT_URL_IS_DEFAULT = process.env.OSINT_URL === undefined;

export function authHeaders(): Record<string, string> {
  const tok = process.env.RESEARCH_TOKEN?.trim();
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

// One-shot warning when the default public endpoint is in use but no bearer is
// set - requests will silently 401. Cheap to fire at module load.
if (OSINT_URL_IS_DEFAULT && !process.env.RESEARCH_TOKEN?.trim()) {
  console.warn(
    `[osint] RESEARCH_TOKEN unset; ${OSINT_URL} will reject requests with 401. ` +
      `Set RESEARCH_TOKEN or point OSINT_URL at a local instance.`,
  );
}

// -- shapes ------------------------------------------------------------------

export interface Investigation {
  entity?: string;
  entity_kind?: string;
  findings?: Finding[];
  info?: string[];
  errors?: string[];
  sources_queried?: string[];
  elapsed_ms?: number;
}

export interface Finding {
  kind: string;
  value: string;
  extra?: Record<string, unknown>;
}

export class OsintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OsintError";
    // Preserve the prototype chain across transpile targets (CJS/ES5) where
    // `extends Error` would otherwise break `instanceof OsintError`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// -- HTTP wrapper ------------------------------------------------------------

export async function osintCall(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Investigation> {
  // Combine caller's signal (cancel-from-host) with our own timeout.
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

// -- shared formatting helpers -----------------------------------------------

export function groupByKind(findings: Finding[] | undefined): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  for (const f of findings ?? []) {
    (out[f.kind] ??= []).push(f);
  }
  return out;
}

export function metaFooter(inv: Investigation, extras: string[] = []): string {
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

// -- per-tool formatters -----------------------------------------------------

export function formatDomain(inv: Investigation, mode: "summary" | "full"): string {
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

export function formatIp(inv: Investigation): string {
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

export function formatEmail(inv: Investigation): string {
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

export function formatUsername(
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

export function formatUrl(inv: Investigation): string {
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

export function formatPhone(inv: Investigation): string {
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

export function formatThreat(inv: Investigation): string {
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

export function formatCve(inv: Investigation): string {
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

export function formatHarvest(inv: Investigation): string {
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

export function poiCategory(tags: Record<string, unknown>): string {
  for (const key of POI_CATEGORY_KEYS) {
    const v = tags[key];
    if (typeof v === "string" && v) return v;
  }
  return "other";
}

export function formatGeo(inv: Investigation, mode: "summary" | "full" = "summary"): string {
  const entity = asString(inv.entity);
  const grouped = groupByKind(inv.findings);
  const geocodes = grouped["geocode"] ?? [];
  const pois = grouped["poi"] ?? [];
  const parts: string[] = [`# Location: ${entity}`];

  if (geocodes.length) {
    const ex = (geocodes[0].extra ?? {}) as Record<string, unknown>;
    const meta = [ex.type, ex.osm].filter((v) => typeof v === "string" && v);
    if (ex.lat != null && ex.lon != null) {
      const coord = `Coordinates: ${ex.lat}, ${ex.lon}`;
      parts.push(meta.length ? `${coord}  (${meta.join(", ")})` : coord);
    } else if (meta.length) {
      parts.push(meta.join(", "));
    } else {
      parts.push("Geocode returned without coordinates.");
    }
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
        const suffix = Number.isFinite(d) ? ` · ${Math.round(d)}m` : "";
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

export function deltaStr(delta: unknown): string {
  if (typeof delta !== "number") return "";
  if (delta === 0) return "  (same size)";
  return `  (${delta > 0 ? "+" : ""}${delta} bytes)`;
}

export function formatArchive(inv: Investigation, mode: "summary" | "full" = "summary"): string {
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

// -- summarise (details projection) ------------------------------------------

export function summarise(inv: Investigation): Record<string, unknown> {
  return {
    entity: inv.entity,
    findings: (inv.findings ?? []).length,
    sources: inv.sources_queried ?? [],
    elapsed_ms: inv.elapsed_ms ?? 0,
    errors: inv.errors ?? [],
  };
}

// -- harness-agnostic orchestrator -------------------------------------------

export type OsintAction =
  | "domain"
  | "ip"
  | "email"
  | "username"
  | "url"
  | "phone"
  | "threat"
  | "cve"
  | "geo"
  | "harvest"
  | "archive";

export interface OsintParams {
  action: OsintAction;
  // domain / harvest
  domain?: string;
  mode?: "summary" | "full" | "fast" | "deep";
  sources?: string;
  // ip
  ip?: string;
  include_shared_hosts?: boolean;
  // email
  email?: string;
  include_breach?: boolean;
  // username
  username?: string;
  show_all?: boolean;
  // url / archive
  url?: string;
  submit?: boolean;
  from_date?: string;
  to_date?: string;
  earliest?: boolean;
  // phone
  phone?: string;
  // threat
  target?: string;
  // cve
  cve_id?: string;
  // geo
  query?: string;
  lat?: number;
  lon?: number;
  radius_m?: number;
  tags?: Record<string, string>;
  limit?: number;
}

export interface OsintResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Dispatch an OSINT action: build the request, POST it, project + render the
 * response. All harness-agnostic. Live errors (network/401/timeout) are caught
 * and returned as an error result rather than thrown, so callers get uniform
 * shape.
 */
export async function runOsint(params: OsintParams, signal?: AbortSignal): Promise<OsintResult> {
  try {
    switch (params.action) {
      case "domain": {
        const domain = (params.domain ?? "").trim();
        if (!domain) return errResult("`domain` is required.");
        const inv = await osintCall("/investigate/domain", { domain }, 180_000, signal);
        return ok(formatDomain(inv, normSubMode(params.mode)), inv);
      }
      case "ip": {
        const ip = (params.ip ?? "").trim();
        if (!ip) return errResult("`ip` is required.");
        const inv = await osintCall(
          "/investigate/ip",
          { ip, include_shared_hosts: params.include_shared_hosts ?? true },
          30_000,
          signal,
        );
        return ok(formatIp(inv), inv);
      }
      case "email": {
        const email = (params.email ?? "").trim();
        if (!email) return errResult("`email` is required.");
        const inv = await osintCall(
          "/investigate/email",
          { email, include_breach: params.include_breach ?? true },
          240_000,
          signal,
        );
        return ok(formatEmail(inv), inv);
      }
      case "username": {
        const username = (params.username ?? "").trim();
        if (!username) return errResult("`username` is required.");
        const mode = params.mode === "deep" ? "deep" : "fast";
        const inv = await osintCall(
          "/investigate/username",
          { username, mode },
          mode === "fast" ? 180_000 : 700_000,
          signal,
        );
        return ok(formatUsername(inv, mode, params.show_all ?? false), inv);
      }
      case "url": {
        const url = (params.url ?? "").trim();
        if (!url) return errResult("`url` is required.");
        const submit = params.submit ?? false;
        const inv = await osintCall(
          "/investigate/url",
          { url, submit },
          submit ? 120_000 : 30_000,
          signal,
        );
        return ok(formatUrl(inv), inv);
      }
      case "phone": {
        const phone = (params.phone ?? "").trim();
        if (!phone) return errResult("`phone` is required.");
        const inv = await osintCall("/investigate/phone", { phone }, 10_000, signal);
        return ok(formatPhone(inv), inv);
      }
      case "threat": {
        const target = (params.target ?? "").trim();
        if (!target) return errResult("`target` is required.");
        const inv = await osintCall("/investigate/threat", { target }, 30_000, signal);
        return ok(formatThreat(inv), inv);
      }
      case "cve": {
        const cveId = (params.cve_id ?? "").trim();
        if (!cveId) return errResult("`cve_id` is required.");
        const inv = await osintCall("/investigate/cve", { cve_id: cveId }, 30_000, signal);
        return ok(formatCve(inv), inv);
      }
      case "geo": {
        const query = params.query?.trim() || undefined;
        if (!query && (params.lat === undefined || params.lon === undefined)) {
          return errResult("pass `query`, or both `lat` and `lon`.");
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
        return ok(formatGeo(inv, normSubMode(params.mode)), inv);
      }
      case "harvest": {
        const domain = (params.domain ?? "").trim();
        if (!domain) return errResult("`domain` is required.");
        const inv = await osintCall(
          "/investigate/harvest",
          {
            domain,
            sources: params.sources ?? null,
            limit: Math.min(Math.max(params.limit ?? 500, 10), 5000),
          },
          420_000,
          signal,
        );
        return ok(formatHarvest(inv), inv);
      }
      case "archive": {
        const url = (params.url ?? "").trim();
        if (!url) return errResult("`url` is required.");
        const payload: Record<string, unknown> = { url, limit: params.limit ?? 50 };
        if (params.from_date?.trim()) payload.from_date = params.from_date.trim();
        if (params.to_date?.trim()) payload.to_date = params.to_date.trim();
        if (params.earliest) payload.earliest = true;
        const inv = await osintCall("/investigate/archive", payload, 60_000, signal);
        return ok(formatArchive(inv, normSubMode(params.mode)), inv);
      }
      default:
        return errResult(`unknown action '${(params as { action?: string }).action}'.`);
    }
  } catch (err) {
    const msg = err instanceof OsintError ? err.message : ((err as Error)?.message ?? String(err));
    return { isError: true, text: `OSINT error: ${msg}`, details: { error: msg } };
  }
}

function normSubMode(mode: OsintParams["mode"]): "summary" | "full" {
  return mode === "full" ? "full" : "summary";
}

function ok(text: string, inv: Investigation): OsintResult {
  return { text, details: summarise(inv) };
}

function errResult(msg: string): OsintResult {
  return { isError: true, text: `Error: ${msg}`, details: { error: msg } };
}

// -- geo pano pipeline (/geo/*) -----------------------------------------------

export interface GeoSweepResult {
  sweep_id: string;
  n_candidates: number;
  n_panos: number;
  n_sheets: number;
  manifest: string;
  sheets: string;
}

export function formatGeoArea(inv: Investigation): string {
  const pois = groupByKind(inv.findings)["poi"] ?? [];
  const lines = pois.map((f) => {
    const ex = (f.extra ?? {}) as Record<string, unknown>;
    const tags = (ex.tags ?? {}) as Record<string, unknown>;
    return `${f.value} | ${ex.lat ?? "?"},${ex.lon ?? "?"} | ${poiCategory(tags)}`;
  });
  const parts = [`# ${asString(inv.entity)}: ${pois.length} candidates`, ""];
  parts.push(...(lines.length ? lines : ["(no candidates)"]));
  parts.push("", metaFooter(inv));
  return parts.join("\n");
}

export function formatGeoSweep(r: GeoSweepResult): string {
  return [
    `sweep_id: ${r.sweep_id}`,
    `candidates: ${r.n_candidates} | panos: ${r.n_panos} | sheets: ${r.n_sheets}`,
    "Pull a sheet to view locally with osint_geo_sheet.",
  ].join("\n");
}

// Copy a service-side artifact (contact sheet, manifest) to this machine.
// Same contract as the dataset localCopy: the path in the response is inside
// the osint container on another host, so the local copy is what gets reported.
// tmp+rename so a killed download never leaves a half-written file behind.
export async function osintDownload(
  path: string,
  localPath: string,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(dirname(localPath), { recursive: true });
  const tmp = `${localPath}.part`;
  const res = await fetch(`${OSINT_URL}${path}`, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) {
    throw new OsintError(`file download HTTP ${res.status}: ${path}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    await rename(tmp, localPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return localPath;
}

export interface GeoClassifyResult {
  sweep_id: string;
  mode: string;
  granularity: string;
  n_scored: number;
  top: { name: string; score: number; sheet?: string; pano_id?: string; path: string }[];
}

export function formatGeoClassify(r: GeoClassifyResult): string {
  const lines = r.top.map((v, i) => `${i + 1}. ${v.name} | ${v.score}`);
  return [
    `# ${r.sweep_id} - ${r.mode} (${r.granularity}), ${r.n_scored} scored`,
    "",
    ...(lines.length ? lines : ["(nothing scored)"]),
    "",
    "Eyeball a hit with osint_geo_sheet(sweep_id, name).",
  ].join("\n");
}
