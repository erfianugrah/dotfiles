/**
 * osv-core unit tests - pure arg-building, JSON projection, rendering. No
 * osv-scanner binary needed (the live run is covered by the pi e2e suite /
 * marked [blocked: needs binary] in the port doc).
 *
 *   bun test extensions/tests/osv-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { buildOsvArgs, parseOsvJson, renderOsv } from "../lib/osv-core.ts";

const FIXTURE = JSON.stringify({
  results: [
    {
      source: { path: "/repo/go.mod" },
      packages: [
        {
          package: { name: "golang.org/x/net", version: "0.17.0", ecosystem: "Go" },
          vulnerabilities: [
            {
              id: "GHSA-qppj-fm5r-hxr3",
              aliases: ["CVE-2023-39325"],
              summary: "HTTP/2 rapid reset can cause excessive work",
              database_specific: { severity: "HIGH" },
              affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "0.17.1" }] }] }],
            },
          ],
        },
        {
          // severity via CVSS score fallback, no fixed version
          package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" },
          vulnerabilities: [
            {
              id: "GHSA-nofix",
              severity: [{ type: "CVSS_V3", score: "7.5" }],
              summary: "example",
            },
          ],
        },
      ],
    },
  ],
});

describe("osv-core.buildOsvArgs", () => {
  test("default: recursive JSON scan", () => {
    expect(buildOsvArgs("/x")).toEqual(["--format=json", "-r", "/x"]);
  });
  test("lockfile_only uses -L", () => {
    expect(buildOsvArgs("/x/go.mod", { lockfileOnly: true })).toEqual(["--format=json", "-L", "/x/go.mod"]);
  });
  test("include_dev appends the flag", () => {
    expect(buildOsvArgs("/x", { includeDev: true })).toEqual(["--format=json", "-r", "/x", "--include-dev"]);
  });
});

describe("osv-core.parseOsvJson", () => {
  test("flattens nested results to one entry per (package, vuln)", () => {
    const vulns = parseOsvJson(FIXTURE);
    expect(vulns.length).toBe(2);
    const net = vulns.find((v) => v.package === "golang.org/x/net")!;
    expect(net.severity).toBe("HIGH");
    expect(net.fixed).toBe("0.17.1");
    expect(net.aliases).toContain("CVE-2023-39325");
    expect(net.ecosystem).toBe("Go");
    expect(net.source).toBe("/repo/go.mod");
  });
  test("severity falls back to first CVSS score; fixed is null when absent", () => {
    const lp = parseOsvJson(FIXTURE).find((v) => v.package === "left-pad")!;
    expect(lp.severity).toBe("7.5");
    expect(lp.fixed).toBeNull();
  });
  test("malformed / empty JSON -> []", () => {
    expect(parseOsvJson("not json")).toEqual([]);
    expect(parseOsvJson("{}")).toEqual([]);
    expect(parseOsvJson('{"results":[]}')).toEqual([]);
  });
});

describe("osv-core.renderOsv", () => {
  test("renders count header + one block per vuln with id and fix", () => {
    const vulns = parseOsvJson(FIXTURE);
    const text = renderOsv(vulns, "/repo");
    expect(text).toContain("2 vulnerabilities in /repo");
    expect(text).toContain("[HIGH] GHSA-qppj-fm5r-hxr3");
    expect(text).toContain("Go/golang.org/x/net@0.17.0");
    expect(text).toContain("-> fixed in 0.17.1");
  });
  test("singular grammar for one vuln", () => {
    const one = parseOsvJson(FIXTURE).slice(0, 1);
    expect(renderOsv(one, "/repo")).toContain("1 vulnerability in /repo");
  });
});
