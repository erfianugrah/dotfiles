/**
 * osint-core unit tests - pure request-building, response projection, and
 * per-tool markdown rendering. No network: the orchestrator's HTTP call is
 * exercised against a stubbed global fetch that captures the request and
 * returns a fixture Investigation. Live osint.erfi.io calls are
 * [blocked: needs RESEARCH_TOKEN + network]; see the port doc.
 *
 *   bun test extensions/tests/osint-core.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  formatArchive,
  formatCve,
  formatDomain,
  formatEmail,
  formatGeo,
  formatIp,
  formatThreat,
  formatUsername,
  groupByKind,
  metaFooter,
  poiCategory,
  runOsint,
  summarise,
  type Investigation,
} from "../lib/osint-core.ts";

// -- fetch stub --------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, unknown>;
  body: unknown;
}

/** Stub global fetch to capture the request and return `inv` as JSON. */
function stubFetch(inv: Investigation): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, unknown>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(inv), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

// -- shared helpers ----------------------------------------------------------

describe("groupByKind", () => {
  test("buckets by kind, tolerates undefined/empty", () => {
    const out = groupByKind([
      { kind: "dns_record", value: "1.2.3.4" },
      { kind: "dns_record", value: "5.6.7.8" },
      { kind: "subdomain", value: "www.x.com" },
    ]);
    expect(out.dns_record).toHaveLength(2);
    expect(out.subdomain).toHaveLength(1);
    expect(groupByKind(undefined)).toEqual({});
    expect(groupByKind([])).toEqual({});
  });
});

describe("metaFooter", () => {
  test("sources + elapsed, issues, extras", () => {
    const out = metaFooter(
      { sources_queried: ["crtsh", "rdap"], elapsed_ms: 42, errors: ["boom"] },
      ["hint"],
    );
    expect(out).toContain("Sources: crtsh, rdap");
    expect(out).toContain("42ms");
    expect(out).toContain("Issues: boom");
    expect(out).toContain("_hint_");
  });
  test("no sources renders (none)", () => {
    expect(metaFooter({ elapsed_ms: 10 })).toContain("(none)");
  });
});

describe("poiCategory", () => {
  test("first matching category key wins, else 'other'", () => {
    expect(poiCategory({ amenity: "cafe", shop: "bakery" })).toBe("cafe");
    expect(poiCategory({ railway: "station", network: "Singapore" })).toBe("station");
    expect(poiCategory({ network: "Singapore" })).toBe("other");
    expect(poiCategory({ amenity: 42, shop: "bakery" })).toBe("bakery");
  });
});

// -- rendering (pure projection) ---------------------------------------------

describe("formatDomain", () => {
  const inv: Investigation = {
    entity: "example.com",
    findings: [
      { kind: "dns_record", value: "1.2.3.4", extra: { type: "A" } },
      { kind: "dns_record", value: "mx.example.com", extra: { type: "MX" } },
      { kind: "subdomain", value: "www.example.com" },
      { kind: "subdomain", value: "api.example.com" },
      { kind: "certificate", value: "cert", extra: { total_certs: 12, issuer: "Let's Encrypt", not_before: "2024-01-01T00:00:00", not_after: "2024-04-01T00:00:00" } },
      { kind: "whois_field", value: "GoDaddy", extra: { field: "registrar" } },
    ],
    sources_queried: ["crtsh"],
    elapsed_ms: 100,
  };

  test("renders DNS/subdomains/certs/whois sections", () => {
    const out = formatDomain(inv, "summary");
    expect(out).toContain("# Domain investigation: example.com");
    expect(out).toContain("A: 1.2.3.4");
    expect(out).toContain("MX: mx.example.com");
    expect(out).toContain("Subdomains (2 unique)");
    expect(out).toContain("Certificates (crt.sh)");
    expect(out).toContain("registrar=GoDaddy");
  });

  test("summary mode caps subdomains at 15 with truncation note", () => {
    const many: Investigation = {
      entity: "e.com",
      findings: Array.from({ length: 20 }, (_, i) => ({ kind: "subdomain", value: `s${i}.e.com` })),
    };
    const out = formatDomain(many, "summary");
    expect(out).toContain("showing 15 of 20");
    const full = formatDomain(many, "full");
    expect(full).not.toContain("showing 15 of 20");
  });
});

describe("formatIp", () => {
  test("geo, ports, cve/tag split", () => {
    const out = formatIp({
      entity: "8.8.8.8",
      findings: [
        { kind: "geolocation", value: "geo", extra: { country: "US", city: "Mountain View", org: "Google" } },
        { kind: "open_port", value: "443" },
        { kind: "open_port", value: "53" },
        { kind: "vuln_tag", value: "CVE-2021-1", extra: { is_cve: true } },
        { kind: "vuln_tag", value: "self-signed", extra: {} },
      ],
    });
    expect(out).toContain("US · Mountain View · Google");
    expect(out).toContain("53, 443");
    expect(out).toContain("## Tags\nself-signed");
    expect(out).toContain("## CVEs\nCVE-2021-1");
  });
});

describe("formatEmail", () => {
  test("holehe regs + HIBP-key-missing note", () => {
    const out = formatEmail({
      entity: "a@b.com",
      findings: [{ kind: "platform_registration", value: "github" }],
      sources_queried: ["holehe"],
    });
    expect(out).toContain("Registered on 1 services");
    expect(out).toContain("API key not set");
  });
});

describe("formatUsername", () => {
  test("fast mode appends deep hint, caps at 30", () => {
    const accounts = Array.from({ length: 35 }, (_, i) => ({
      kind: "account", value: `https://x/${i}`, extra: { platform: `p${i}` },
    }));
    const out = formatUsername({ entity: "alice", findings: accounts }, "fast", false);
    expect(out).toContain("(35 hits)");
    expect(out).toContain("showing top 30");
    expect(out).toContain('mode="deep"');
  });
});

describe("formatThreat", () => {
  test("malicious verdict + facts", () => {
    const out = formatThreat({
      entity: "evil.com",
      entity_kind: "domain",
      findings: [{ kind: "reputation", value: "r", extra: { malicious: 5, suspicious: 1, harmless: 60, total: 70, registrar: "NameCheap" } }],
    });
    expect(out).toContain("⚠ malicious");
    expect(out).toContain("5 malicious");
    expect(out).toContain("registrar: NameCheap");
  });
  test("no VT key note", () => {
    const out = formatThreat({ entity: "x", entity_kind: "domain", info: ["VT_API_KEY not set"] });
    expect(out).toContain("VT_API_KEY not set");
  });
});

describe("formatCve", () => {
  test("cvss + description truncation + refs", () => {
    const out = formatCve({
      entity: "CVE-2021-44228",
      findings: [{
        kind: "cve", value: "CVE-2021-44228",
        extra: {
          cvss_score: 10, cvss_severity: "CRITICAL", cvss_version: "3.1",
          published: "2021-12-10T00:00:00", description: "Log4j RCE",
          cwes: ["CWE-502"], cvss_vector: "AV:N/AC:L",
          references: ["https://a", "https://b"], ref_total: 12,
        },
      }],
    });
    expect(out).toContain("**10 (CRITICAL)**");
    expect(out).toContain("Log4j RCE");
    expect(out).toContain("CWE-502");
    expect(out).toContain("showing 5 of 12 references");
  });
  test("invalid id path", () => {
    const out = formatCve({ entity: "nope", info: ["not a valid CVE id"] });
    expect(out).toContain("not a valid CVE id");
  });
});

describe("formatGeo", () => {
  test("geocode coords + POI grouped by category with distances", () => {
    const out = formatGeo({
      entity: "SG",
      findings: [
        { kind: "geocode", value: "g", extra: { lat: 1.35, lon: 103.8, type: "city" } },
        { kind: "poi", value: "Cafe A", extra: { tags: { amenity: "cafe" }, distance_m: 120 } },
        { kind: "poi", value: "Shop B", extra: { tags: { shop: "supermarket" }, distance_m: 50 } },
      ],
    }, "summary");
    expect(out).toContain("Coordinates: 1.35, 103.8");
    expect(out).toContain("### cafe (1)");
    expect(out).toContain("120m");
  });
});

describe("formatArchive", () => {
  const snap = (iso: string, delta?: number) => ({
    kind: "snapshot", value: iso,
    extra: { iso, timestamp: iso.replace(/\D/g, ""), status: "200", url: `http://web.archive/${iso}`, delta_bytes: delta },
  });
  test("orders by timestamp, shows deltas, caps at 20 in summary", () => {
    const many = Array.from({ length: 25 }, (_, i) => snap(`2020-01-${String(i + 1).padStart(2, "0")}`, i * 10));
    const out = formatArchive({ entity: "e.com/pricing", findings: many }, "summary");
    expect(out).toContain("25 content changes");
    expect(out).toContain("showing 20 of 25");
    const full = formatArchive({ entity: "e.com/pricing", findings: many }, "full");
    expect(full).not.toContain("showing 20 of 25");
  });
  test("no snapshots falls back to info/errors", () => {
    expect(formatArchive({ entity: "e.com", info: ["no captures in range"] })).toContain("no captures in range");
    expect(formatArchive({ entity: "e.com" })).toContain("No captures.");
  });
});

describe("summarise", () => {
  test("projects entity/findings-count/sources/elapsed/errors", () => {
    expect(summarise({ entity: "x", findings: [{ kind: "a", value: "1" }], sources_queried: ["s"], elapsed_ms: 5, errors: [] })).toEqual({
      entity: "x", findings: 1, sources: ["s"], elapsed_ms: 5, errors: [],
    });
  });
});

// -- orchestrator: request-building + dispatch -------------------------------

describe("runOsint request-building", () => {
  test("domain: POSTs to /investigate/domain with trimmed domain, renders", async () => {
    const { calls } = stubFetch({ entity: "example.com", findings: [{ kind: "subdomain", value: "www.example.com" }], sources_queried: ["crtsh"], elapsed_ms: 9 });
    const res = await runOsint({ action: "domain", domain: "  example.com  " });
    expect(calls[0].url).toContain("/investigate/domain");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ domain: "example.com" });
    expect(res.text).toContain("# Domain investigation: example.com");
    expect(res.details).toMatchObject({ entity: "example.com", findings: 1 });
    expect(res.isError).toBeUndefined();
  });

  test("ip: include_shared_hosts defaults true", async () => {
    const { calls } = stubFetch({ entity: "1.1.1.1", findings: [] });
    await runOsint({ action: "ip", ip: "1.1.1.1" });
    expect(calls[0].body).toEqual({ ip: "1.1.1.1", include_shared_hosts: true });
  });

  test("username: deep mode maps through", async () => {
    const { calls } = stubFetch({ entity: "bob", findings: [] });
    await runOsint({ action: "username", username: "bob", mode: "deep" });
    expect(calls[0].body).toEqual({ username: "bob", mode: "deep" });
  });

  test("harvest: limit clamped to [10,5000]", async () => {
    const { calls } = stubFetch({ entity: "e.com", findings: [] });
    await runOsint({ action: "harvest", domain: "e.com", limit: 99999 });
    expect((calls[0].body as { limit: number }).limit).toBe(5000);
  });

  test("archive: optional date bounds only included when set", async () => {
    const { calls } = stubFetch({ entity: "e.com", findings: [] });
    await runOsint({ action: "archive", url: "e.com", from_date: "2021", earliest: true });
    expect(calls[0].body).toEqual({ url: "e.com", limit: 50, from_date: "2021", earliest: true });
  });

  test("geo: rejects missing query and coords without a network call", async () => {
    const { calls } = stubFetch({ entity: "x", findings: [] });
    const res = await runOsint({ action: "geo" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("query");
    expect(calls).toHaveLength(0);
  });

  test("missing required arg errors before fetch", async () => {
    const { calls } = stubFetch({ entity: "x", findings: [] });
    const res = await runOsint({ action: "domain" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("HTTP error surfaces as isError result, not a throw", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const res = await runOsint({ action: "cve", cve_id: "CVE-2021-44228" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("401");
  });
});
