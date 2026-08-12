/**
 * Pure unit tests for epistemic-guard-core - the harness-agnostic provenance
 * checker shared by the pi adapter and the Claude Code PostToolUse hook.
 *
 * No network, no binary, no harness: exercise claim extraction, corpus
 * absorption, provenance matching, the payload-mode router, the commit/patch
 * parsers, the message renderers, and the gateWrite / gatePatch orchestrators
 * with realistic fixtures.
 *
 *   cd .pi/agent && bun test extensions/tests/epistemic-guard-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  type Claim,
  absorb,
  assistantAnswerText,
  blockReason,
  commitMessageText,
  extractClaims,
  footerLine,
  gatePatch,
  gateWrite,
  hasProvenance,
  hedgedNear,
  isMessagePersist,
  newCorpus,
  patchAddedText,
  patchTargets,
  payloadMode,
  provenanceText,
  unprovenanced,
} from "../lib/epistemic-guard-core.ts";

const keysOf = (text: string, mode: "prose" | "code" = "prose") =>
  extractClaims(text, mode).map((c) => `${c.cls}:${c.key}`);

// -- claim extraction --------------------------------------------------------

describe("extractClaims / prose", () => {
  test("worded version, CVE, url, perf, flag, syspath, date all extracted", () => {
    const text = [
      "We deploy Caddy 2.8.4 to fix CVE-2024-12345.",
      "Docs: https://caddyserver.com/docs/caddyfile/directives/tls",
      "It benchmarked 12ms and was 3x faster.",
      "Pass --dns-01 and read /etc/knot/knot.conf.",
      "Shipped 2026-08-10.",
    ].join("\n");
    const keys = keysOf(text);
    expect(keys).toContain("version:2.8.4");
    expect(keys).toContain("cve:CVE-2024-12345");
    expect(keys).toContain(
      "url:https://caddyserver.com/docs/caddyfile/directives/tls",
    );
    expect(keys).toContain("perf:12ms");
    expect(keys).toContain("perf:3x");
    expect(keys).toContain("flag:--dns-01");
    expect(keys).toContain("syspath:/etc/knot/knot.conf");
    expect(keys).toContain("date:2026-08-10");
  });

  test("ubiquitous flags and IPv4 are not claims", () => {
    const keys = keysOf("run with --help --json against 10.0.69.4");
    expect(keys.some((k) => k.startsWith("flag:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("version:"))).toBe(false);
  });

  test("a hedge next to the claim exempts it", () => {
    expect(keysOf("Caddy 2.8.4 (unverified, from memory)")).toEqual([]);
  });

  test("shallow / placeholder URLs are not citation claims", () => {
    expect(keysOf("see https://example.com and http://localhost:8080/x")).toEqual([]);
  });

  test("version bookkeeping headings are not claims", () => {
    expect(keysOf("## [1.2.0] - 2026-08-10\nchangelog entry")).toEqual([]);
  });
});

describe("extractClaims / code scope", () => {
  test("code mode keeps pins + CVEs, drops flags/paths/urls/perf", () => {
    const text = 'image: "app:1.2.3" # CVE-2021-44228 --dns-01 /etc/x https://x.io/y 12ms';
    const keys = keysOf(text, "code");
    expect(keys).toContain("version:1.2.3");
    expect(keys).toContain("cve:CVE-2021-44228");
    expect(keys.some((k) => k.startsWith("flag:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("syspath:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("url:"))).toBe(false);
  });

  test("fenced block inside prose is treated as code (no flag/path claims)", () => {
    const text = "Prose says --real-flag matters.\n```\nrun --fenced-flag /etc/foo\n```\n";
    const keys = keysOf(text);
    expect(keys).toContain("flag:--real-flag");
    expect(keys).not.toContain("flag:--fenced-flag");
    expect(keys.some((k) => k === "syspath:/etc/foo")).toBe(false);
  });
});

// -- payloadMode router ------------------------------------------------------

describe("payloadMode", () => {
  test("prose for markdown + docs/ paths, code otherwise, skip for scratch/lock", () => {
    expect(payloadMode("/repo/README.md")).toBe("prose");
    expect(payloadMode("/repo/docs/design.txt")).toBe("prose");
    expect(payloadMode("/repo/src/index.ts")).toBe("code");
    expect(payloadMode("/tmp/scratch.md")).toBe("skip");
    expect(payloadMode("/repo/bun.lock")).toBe("skip");
    expect(payloadMode("/repo/node_modules/x/y.ts")).toBe("skip");
    expect(payloadMode("")).toBe("skip");
  });
});

// -- corpus / provenance -----------------------------------------------------

describe("absorb + hasProvenance", () => {
  test("a literal seen in tool output silences its claim", () => {
    const corpus = newCorpus();
    absorb(corpus, "$ caddy version\nv2.8.4 built with go1.22");
    const claim: Claim = { cls: "version", key: "2.8.4", raw: "Caddy 2.8.4" };
    expect(hasProvenance(corpus, claim)).toBe(true);
  });

  test("syspath prefix match: /etc/knot covers /etc/knot/knot.conf", () => {
    const corpus = newCorpus();
    absorb(corpus, "ls /etc/knot");
    expect(
      hasProvenance(corpus, { cls: "syspath", key: "/etc/knot/knot.conf", raw: "x" }),
    ).toBe(true);
  });

  test("ISO <-> worded date cross-match on same month", () => {
    const corpus = newCorpus();
    absorb(corpus, "the log shows 2026-07-31");
    expect(
      hasProvenance(corpus, { cls: "date", key: "late july 2026", raw: "late July 2026" }),
    ).toBe(true);
  });

  test("an unseen literal has no provenance", () => {
    const corpus = newCorpus();
    absorb(corpus, "nothing relevant here");
    expect(hasProvenance(corpus, { cls: "version", key: "9.9.9", raw: "9.9.9" })).toBe(false);
  });
});

describe("unprovenanced dedup", () => {
  test("flags each specific at most once per session", () => {
    const corpus = newCorpus();
    const flagged = new Set<string>();
    const claims: Claim[] = [{ cls: "version", key: "2.8.4", raw: "Caddy 2.8.4" }];
    expect(unprovenanced(corpus, claims, flagged)).toHaveLength(1);
    expect(unprovenanced(corpus, claims, flagged)).toHaveLength(0); // retry passes
  });
});

// -- provenance harvesting ---------------------------------------------------

describe("provenanceText", () => {
  test("tool results and bash output count; assistant text does not", () => {
    const toolResult = {
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "v2.8.4" }] },
    };
    const bash = {
      type: "message",
      message: { role: "bashExecution", command: "caddy version", output: "v2.8.4" },
    };
    const assistant = {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Caddy 2.8.4" }] },
    };
    expect(provenanceText(toolResult)).toContain("v2.8.4");
    expect(provenanceText(bash)).toContain("caddy version");
    expect(provenanceText(assistant)).toBe("");
  });
});

describe("assistantAnswerText", () => {
  test("plain answer yields text; a tool-calling step yields empty", () => {
    expect(
      assistantAnswerText({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
    ).toBe("hello");
    expect(
      assistantAnswerText({
        role: "assistant",
        content: [{ type: "text", text: "working" }, { type: "toolCall" }],
      }),
    ).toBe("");
  });
});

// -- commit / patch parsing --------------------------------------------------

describe("commit + patch helpers", () => {
  test("isMessagePersist detects git commit / gh pr create", () => {
    expect(isMessagePersist("git commit -m 'x'")).toBe(true);
    expect(isMessagePersist("gh pr create --title y")).toBe(true);
    expect(isMessagePersist("ls -la")).toBe(false);
  });

  test("commitMessageText pulls -m and heredoc bodies", () => {
    expect(commitMessageText("git commit -m 'fix Caddy 2.8.4'")).toContain("2.8.4");
    const heredoc = "gh pr create --body \"$(cat <<'EOF'\nships 1.2.3\nEOF\n)\"";
    expect(commitMessageText(heredoc)).toContain("1.2.3");
  });

  test("patchTargets + patchAddedText parse an apply_patch envelope", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/notes.md",
      "+We shipped Caddy 2.8.4",
      "+++ ignored header line",
      "*** End Patch",
    ].join("\n");
    expect(patchTargets(patch)).toContain("docs/notes.md");
    expect(patchAddedText(patch)).toContain("Caddy 2.8.4");
    expect(patchAddedText(patch)).not.toContain("ignored header");
  });
});

// -- message rendering -------------------------------------------------------

describe("blockReason + footerLine", () => {
  const claims: Claim[] = [
    { cls: "version", key: "2.8.4", raw: "Caddy 2.8.4" },
    { cls: "flag", key: "--dns-01", raw: "--dns-01" },
  ];

  test("blockReason names the payload location, each specific, and the retry contract", () => {
    const r = blockReason(claims, "write -> /repo/README.md");
    expect(r).toContain("write -> /repo/README.md");
    expect(r).toContain("Caddy 2.8.4");
    expect(r).toContain("--dns-01");
    expect(r).toContain("flagged once per session");
  });

  test("footerLine lists the recalled specifics", () => {
    const f = footerLine(claims);
    expect(f).toContain("recalled, not verified");
    expect(f).toContain("Caddy 2.8.4");
  });
});

// -- orchestrators -----------------------------------------------------------

describe("gateWrite orchestrator", () => {
  test("prose target with an unprovenanced version returns a gate hit", () => {
    const corpus = newCorpus();
    const res = gateWrite(corpus, "/repo/README.md", "We run Caddy 2.8.4.", new Set());
    expect(res).not.toBeNull();
    expect(res!.hits.map((c) => c.key)).toContain("2.8.4");
    expect(res!.reason).toContain("Caddy 2.8.4");
  });

  test("provenanced version passes clean (null)", () => {
    const corpus = newCorpus();
    absorb(corpus, "$ caddy version\nv2.8.4");
    expect(gateWrite(corpus, "/repo/README.md", "We run Caddy 2.8.4.", new Set())).toBeNull();
  });

  test("skip target (scratch) is never gated", () => {
    expect(gateWrite(newCorpus(), "/tmp/x.md", "Caddy 2.8.4", new Set())).toBeNull();
  });

  test("custom where label is used in the reason", () => {
    const res = gateWrite(
      newCorpus(),
      "/repo/README.md",
      "Caddy 2.8.4",
      new Set(),
      "PostToolUse Write",
    );
    expect(res!.where).toBe("PostToolUse Write");
  });
});

describe("gatePatch orchestrator", () => {
  test("prose wins in a mixed patch; unprovenanced doc claim is flagged", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/x.ts",
      "+const x = 1;",
      "*** Add File: docs/n.md",
      "+Caddy 2.8.4 fixes it",
      "*** End Patch",
    ].join("\n");
    const res = gatePatch(newCorpus(), patch, new Set());
    expect(res).not.toBeNull();
    expect(res!.where).toBe("apply_patch");
    expect(res!.hits.map((c) => c.key)).toContain("2.8.4");
  });
});

// -- absorb-then-clean loop (self-healing) ------------------------------------

describe("self-healing: verify silences the flag", () => {
  test("gateWrite flags, then absorbing tool output makes a re-gate pass", () => {
    const corpus = newCorpus();
    const flagged = new Set<string>();
    const first = gateWrite(corpus, "/repo/README.md", "Postgres 17.2 is out.", flagged);
    expect(first).not.toBeNull();
    // agent verifies; the literal enters the corpus
    absorb(corpus, "SELECT version(); -> PostgreSQL 17.2");
    const fresh = new Set<string>();
    expect(gateWrite(corpus, "/repo/README.md", "Postgres 17.2 is out.", fresh)).toBeNull();
  });
});

// hedgedNear sanity (used by extraction internally, exported for parity)
describe("hedgedNear", () => {
  test("detects a nearby hedge", () => {
    const t = "Caddy 2.8.4, unverified";
    expect(hedgedNear(t, t.indexOf("2.8.4"))).toBe(true);
    expect(hedgedNear("Caddy 2.8.4 is stable", 6)).toBe(false);
  });
});
