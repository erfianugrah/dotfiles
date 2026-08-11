/**
 * pg-analyser-core unit tests - pure validation + argv-building + dir scrape.
 * No pg-analyser binary needed (live run [blocked: needs binary]).
 *
 *   bun test extensions/tests/pg-analyser-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { buildPgArgs, findReportDir, validatePgAction } from "../lib/pg-analyser-core.ts";

describe("pg-analyser-core.validatePgAction", () => {
  test("collect actions need a target", () => {
    expect(validatePgAction("analyze", {})).toContain("needs ref or dbUrl");
    expect(validatePgAction("analyze", { ref: "abc" })).toBeNull();
    expect(validatePgAction("full", {})).toContain("ref, dbUrl, profile, or all");
    expect(validatePgAction("full", { all: true })).toBeNull();
  });
  test("render/narrate actions need dir", () => {
    expect(validatePgAction("report", {})).toContain("dir is required");
    expect(validatePgAction("narrate_prompt", {})).toContain("dir is required");
    expect(validatePgAction("report", { dir: "/r" })).toBeNull();
  });
  test("import_trends needs dir + files; scrape_init needs ref", () => {
    expect(validatePgAction("import_trends", { dir: "/r" })).toContain("needs dir + files");
    expect(validatePgAction("import_trends", { dir: "/r", files: ["a.csv"] })).toBeNull();
    expect(validatePgAction("scrape_init", {})).toContain("needs ref");
  });
  test("bench guardrails", () => {
    expect(validatePgAction("bench", {})).toContain("needs dbUrl");
    expect(validatePgAction("bench", { dbUrl: "x", init: true })).toContain("DROPS pgbench_* tables");
    expect(validatePgAction("bench", { dbUrl: "x", init: true, yes: true })).toBeNull();
    expect(validatePgAction("bench_show", {})).toContain("needs showId");
    expect(validatePgAction("bench_compare", { compareIds: [1] })).toContain("[idA, idB]");
    expect(validatePgAction("bench_compare", { compareIds: [1, 2] })).toBeNull();
  });
});

describe("pg-analyser-core.buildPgArgs", () => {
  test("collect: analyze with ref + full with --all", () => {
    expect(buildPgArgs("analyze", { ref: "r" })!.argv).toEqual(["analyze", "--ref", "r"]);
    expect(buildPgArgs("full", { all: true })!.argv).toContain("--all");
  });
  test("subcommand renames", () => {
    expect(buildPgArgs("import_trends", { dir: "/r", files: ["a.csv", "b.json"] })!.argv).toEqual([
      "import-trends", "/r", "a.csv", "b.json",
    ]);
    expect(buildPgArgs("export_prometheus", { dir: "/r", ref: "x" })!.argv).toEqual(["export-prometheus", "/r", "--ref", "x"]);
    expect(buildPgArgs("scrape_init", { ref: "x" })!.argv).toEqual(["scrape-init", "--ref", "x"]);
  });
  test("bench family maps to `bench` subcommand + flags", () => {
    expect(buildPgArgs("bench", { dbUrl: "pg://x", builtin: "tpcb-like" })!.argv.slice(0, 3)).toEqual([
      "bench", "--db-url", "pg://x",
    ]);
    expect(buildPgArgs("bench_list", {})!.argv).toEqual(["bench", "--list"]);
    expect(buildPgArgs("bench_show", { showId: 7 })!.argv).toEqual(["bench", "--show", "7"]);
    expect(buildPgArgs("bench_compare", { compareIds: [3, 9] })!.argv).toEqual(["bench", "--compare", "3", "9"]);
  });
  test("narrate_import carries stdin; narrate_prompt is null (two-step)", () => {
    const ni = buildPgArgs("narrate_import", { dir: "/r", summary: "# hi" })!;
    expect(ni.argv).toEqual(["narrate", "/r", "--import", "-"]);
    expect(ni.stdin).toBe("# hi");
    expect(buildPgArgs("narrate_prompt", { dir: "/r" })).toBeNull();
  });
});

describe("pg-analyser-core.findReportDir", () => {
  test("parses the CLI breadcrumbs", () => {
    expect(findReportDir("... done: reports/proj-2026")).toBe("reports/proj-2026");
    expect(findReportDir("> index: /tmp/out/index.html")).toBe("/tmp/out/index.html");
    expect(findReportDir("nothing here")).toBeUndefined();
  });
});
