import { describe, expect, test } from "bun:test";
import {
  absorb,
  entityRegistry,
  extractClaims,
  newCorpus,
  unprovenanced,
} from "../extensions/lib/epistemic-guard-core.ts";

describe("epistemic-guard.entity", () => {
  test("registry loads and has the expected shape", () => {
    const reg = entityRegistry();
    expect(reg).not.toBeNull();
    expect(reg!.version).toBe(1);
    expect(reg!.entities.length).toBeGreaterThan(10);
    expect(reg!.entities.every((e) => e.names.length > 0 && e.kind)).toBe(true);
  });

  test("an unprovenanced entity mention is flagged", () => {
    const corpus = newCorpus();
    const claims = extractClaims("Composer runs on servarr as a systemd unit.", "prose");
    const hits = unprovenanced(corpus, claims, new Set());
    const entities = hits.filter((c) => c.cls === "entity").map((c) => c.key);
    expect(entities).toContain("composer");
    expect(entities).toContain("servarr");
  });

  test("provenance from a tool result silences the claim", () => {
    const corpus = newCorpus();
    absorb(corpus, "CONTAINER ID  IMAGE  STATUS\nabc123  composer/composerd  Up 3 days");
    const claims = extractClaims("Composer is healthy on the router.", "prose");
    const hits = unprovenanced(corpus, claims, new Set());
    expect(hits.filter((c) => c.cls === "entity" && c.key === "composer")).toHaveLength(0);
    // "router" itself was never mentioned anywhere -> still flagged
    expect(hits.filter((c) => c.cls === "entity" && c.key === "router").length).toBe(1);
  });

  test("alias provenance silences a sibling name on the same registry entry", () => {
    const corpus = newCorpus();
    absorb(corpus, "ssh ms-01 'systemctl status caddy' -> active (running)");
    const claims = extractClaims("The router proxies through Caddy.", "prose");
    const hits = unprovenanced(corpus, claims, new Set());
    expect(hits.filter((c) => c.cls === "entity")).toHaveLength(0);
  });

  test("a hedge next to the entity exempts it", () => {
    const corpus = newCorpus();
    const claims = extractClaims(
      "Composer (unverified - I have not checked where it runs this session) manages the stacks.",
      "prose",
    );
    const hits = unprovenanced(corpus, claims, new Set());
    expect(hits.filter((c) => c.cls === "entity" && c.key === "composer")).toHaveLength(0);
  });

  test("entity claims are prose-only, code mode ignores them", () => {
    const claims = extractClaims('const host = "servarr";', "code");
    expect(claims.filter((c) => c.cls === "entity")).toHaveLength(0);
  });

  test("each entity flagged once per session", () => {
    const corpus = newCorpus();
    const flagged = new Set<string>();
    const claims = extractClaims("Drawbridge fronts the docker socket.", "prose");
    expect(unprovenanced(corpus, claims, flagged).length).toBeGreaterThan(0);
    expect(unprovenanced(corpus, claims, flagged)).toHaveLength(0);
  });
});
