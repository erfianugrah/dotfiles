#!/usr/bin/env bun
/**
 * erfi-toolkit - Claude Code MCP server (stdio) over the shared pi extension
 * cores. Each tool is a thin wrapper around a dependency-free
 * .pi/agent/extensions/lib/<name>-core.ts module, so pi and Claude Code run
 * identical logic. See .pi/agent/docs/pi-to-claude-code-port.md.
 *
 * Run from the REPO checkout (not the stow symlink) so both the SDK
 * (node_modules here) and the ../../.pi/agent cores resolve:
 *   claude mcp add --scope user erfi-toolkit -- bun $HOME/dotfiles/.claude/mcp/toolkit.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryOciTags } from "../../.pi/agent/extensions/lib/oci-tags-core.ts";
import { scanOsv } from "../../.pi/agent/extensions/lib/osv-core.ts";
import { scanSecrets } from "../../.pi/agent/extensions/lib/secret-scan-core.ts";
import { runHurlTest } from "../../.pi/agent/extensions/lib/hurl-core.ts";
import { runGoTests } from "../../.pi/agent/extensions/lib/go-test-core.ts";
import { runBench } from "../../.pi/agent/extensions/lib/bench-core.ts";
import { runPgAnalyser, type PgAction, type PgParams } from "../../.pi/agent/extensions/lib/pg-analyser-core.ts";

export const server = new McpServer({ name: "erfi-toolkit", version: "0.1.0" });

// -- oci_tags ----------------------------------------------------------------
server.registerTool(
  "oci_tags",
  {
    title: "OCI Tags",
    description:
      "Query OCI registries (Docker Hub, ghcr.io, quay.io, any OCI) for image tags. " +
      "Sorted by version (latest last). Use for container versions instead of web search. " +
      "semver:true returns stable releases only; current:<tag> partitions output into " +
      "same-major updates vs different-major (breaking) jumps.",
    inputSchema: {
      image: z.string().describe('Container image reference (e.g. "vaultwarden/server", "ghcr.io/astral-sh/uv", "nginx")'),
      semver: z.boolean().optional().describe("Filter to stable release tags only (excludes nightly/develop/rc/beta/preview). Default false."),
      current: z.string().optional().describe("Currently-deployed tag; partitions output into same-major vs different-major jumps."),
      limit: z.number().optional().describe("Max tags to return (default 10, max 100)."),
    },
  },
  async ({ image, semver, current, limit }) => {
    const { text } = await queryOciTags(image, { semver, current, limit });
    return { content: [{ type: "text", text }] };
  },
);

// -- osv_scan ----------------------------------------------------------------
server.registerTool(
  "osv_scan",
  {
    title: "OSV Scan",
    description:
      "Run osv-scanner against a directory or lockfile and return a flattened list of " +
      "vulnerabilities (one per package+id): package, version, ecosystem, id (GHSA/CVE/GO), " +
      "aliases, severity, fixed version, summary. Use before deploys / dep bumps. Requires the " +
      "osv-scanner binary on PATH.",
    inputSchema: {
      path: z.string().optional().describe("Directory or lockfile to scan (default: server cwd). Relative paths resolved against cwd."),
      lockfile_only: z.boolean().optional().describe("Treat `path` as a single lockfile via -L. Default: recursive directory scan via -r."),
      include_dev: z.boolean().optional().describe("Include dev dependencies (--include-dev). Default false."),
    },
  },
  async ({ path, lockfile_only, include_dev }) => {
    const { text, isError } = await scanOsv({
      path,
      cwd: process.cwd(),
      lockfileOnly: lockfile_only,
      includeDev: include_dev,
    });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- secret_scan -------------------------------------------------------------
server.registerTool(
  "secret_scan",
  {
    title: "Secret Scan",
    description:
      "Scan a directory for leaked secrets via gitleaks (default) or noseyparker. Returns findings " +
      "(rule, file, line, secret PREFIX only - first 12 chars + length, never the full secret, commit " +
      "if scanning history). Run before commits / during PR review. Requires the gitleaks or " +
      "noseyparker binary on PATH.",
    inputSchema: {
      path: z.string().optional().describe("Directory or repo path to scan (default: server cwd)."),
      backend: z.enum(["gitleaks", "noseyparker"]).optional().describe("Scanner. Default gitleaks (fast, regex); noseyparker is entropy+provenance."),
      scan_history: z.boolean().optional().describe("Scan git history too (gitleaks only). Default false = working tree."),
    },
  },
  async ({ path, backend, scan_history }) => {
    const { text, isError } = await scanSecrets({ path, cwd: process.cwd(), backend, scanHistory: scan_history });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- hurl_test ---------------------------------------------------------------
server.registerTool(
  "hurl_test",
  {
    title: "Hurl Test",
    description:
      "Execute a .hurl HTTP test file and return only what matters: on success a '{passed}/{total} " +
      "entries passed' line; on failure a per-entry breakdown (method/URL/status + failing asserts). " +
      "Pass variables to substitute {{ name }} placeholders. Requires the hurl binary on PATH.",
    inputSchema: {
      file: z.string().describe("Path to the .hurl file (relative to server cwd or absolute)."),
      variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Variables substituted into {{ name }} in the file."),
    },
  },
  async ({ file, variables }) => {
    const { text, isError } = await runHurlTest({ file, cwd: process.cwd(), variables });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- go_test -----------------------------------------------------------------
server.registerTool(
  "go_test",
  {
    title: "Go Test",
    description:
      "Run `go test -json <pattern>` and return ONLY failures + summary (total/passed/failed/skipped, " +
      "each failure with the last 30 output lines, build errors). Narrow with pattern and the run " +
      "regex. Requires the go toolchain on PATH.",
    inputSchema: {
      pattern: z.string().optional().describe("Package pattern, default './...'."),
      run: z.string().optional().describe("Regex for `go test -run` (filter by test name)."),
      timeout: z.string().optional().describe("Per-test timeout (go test -timeout). Default '5m'."),
      race: z.boolean().optional().describe("Pass -race. Default false."),
      count: z.number().optional().describe("Run each test N times (-count=N). Default 1."),
      short: z.boolean().optional().describe("Pass -short. Default false."),
      cwd: z.string().optional().describe("Working directory (default: server cwd)."),
    },
  },
  async ({ pattern, run, timeout, race, count, short, cwd }) => {
    const { text, isError } = await runGoTests({ pattern, run, timeout, race, count, short, cwd: cwd ?? process.cwd() });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- bench -------------------------------------------------------------------
server.registerTool(
  "bench",
  {
    title: "Bench",
    description:
      "Benchmark one or more commands with hyperfine and return a compact comparison: per-command " +
      "mean/stddev/min/max/median + winner + speedup factor. Use for statistical confidence that X " +
      "is faster than Y. Requires the hyperfine binary on PATH.",
    inputSchema: {
      commands: z.array(z.string()).describe("Commands to benchmark (2+ for comparison)."),
      warmup: z.number().optional().describe("Warmup runs. Default 3."),
      runs: z.number().optional().describe("Measured runs per command. Default 10."),
      shell_none: z.boolean().optional().describe("Use --shell=none (default true). Set false for pipes/globs."),
      prepare: z.string().optional().describe("Shell command run before each measured run (--prepare)."),
      cwd: z.string().optional().describe("Working directory (default: server cwd)."),
    },
  },
  async ({ commands, warmup, runs, shell_none, prepare, cwd }) => {
    const { text, isError } = await runBench({ commands, warmup, runs, shellNone: shell_none, prepare, cwd: cwd ?? process.cwd() });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- pg_analyser -------------------------------------------------------------
server.registerTool(
  "pg_analyser",
  {
    title: "pg-analyser",
    description:
      "Run the pg-analyser Postgres performance analyzer. Actions: analyze/full (collect + render a " +
      "project - PAT, or no-PAT via dbUrl/profile), snapshot (append to trend history), " +
      "report/pdf/summary (re-render a dir), import_trends/export_prometheus/scrape_init (trend " +
      "plumbing), narrate_prompt (get the grounded exec-summary prompt so YOU write it in-session) + " +
      "narrate_import (embed it back, then report narrative=true), bench + bench_list/show/compare. " +
      "Resolves $PG_ANALYSER_BIN -> pg-analyser on PATH -> bun run $PG_ANALYSER_REPO/src/index.ts.",
    inputSchema: {
      action: z
        .enum([
          "analyze", "full", "snapshot", "report", "pdf", "summary",
          "import_trends", "export_prometheus", "scrape_init",
          "narrate_prompt", "narrate_import", "bench", "bench_list", "bench_show", "bench_compare",
        ])
        .describe("What to do."),
      ref: z.string().optional().describe("Project ref (analyze/full/snapshot/scrape_init); comma/space list allowed."),
      dir: z.string().optional().describe("Report dir with analysis.json (report/pdf/summary/import_trends/export_prometheus/narrate_*)."),
      out: z.string().optional().describe("Output dir override (analyze/full)."),
      all: z.boolean().optional().describe("full: audit every project (needs a PAT)."),
      dbUrl: z.string().optional().describe("Superuser Postgres connstring (secret; sole source in no-PAT mode)."),
      profile: z.string().optional().describe("full: path to a --profile JSON."),
      noPat: z.boolean().optional().describe("Force no-PAT mode."),
      interval: z.string().optional().describe("Analytics timeframe: 15min|30min|1hr|3hr|1day|3day|7day."),
      trendDays: z.number().optional().describe("Trend query window in days (default 30)."),
      brand: z.string().optional().describe("White-label branding JSON (render paths)."),
      overlay: z.string().optional().describe("Per-project review overlay JSON (render paths)."),
      store: z.string().optional().describe("History SQLite file (snapshot/export_prometheus)."),
      files: z.array(z.string()).optional().describe("import_trends: CSV/JSON series files."),
      narrative: z.boolean().optional().describe("report/pdf: embed the narrative (run narrate_import first)."),
      summary: z.string().optional().describe("narrate_import: the executive-summary markdown to embed."),
      scripts: z.array(z.string()).optional().describe("bench: custom pgbench script file(s)."),
      builtin: z.string().optional().describe("bench: builtin script tpcb-like|simple-update|select-only."),
      scale: z.number().optional().describe("bench: scale factor (default 1)."),
      init: z.boolean().optional().describe("bench: run pgbench -i first (DROPS pgbench_* tables; needs yes)."),
      clients: z.number().optional().describe("bench: connections (default 4)."),
      threads: z.number().optional().describe("bench: worker threads."),
      timeS: z.number().optional().describe("bench: seconds per run (default 60)."),
      warmup: z.number().optional().describe("bench: warmup seconds (default 10)."),
      runs: z.number().optional().describe("bench: measured repetitions (default 3)."),
      protocol: z.string().optional().describe("bench: simple|extended|prepared."),
      rate: z.number().optional().describe("bench: target TPS (pgbench -R)."),
      resetStats: z.boolean().optional().describe("bench: pg_stat_statements_reset() first."),
      name: z.string().optional().describe("bench: label stored with the run."),
      yes: z.boolean().optional().describe("bench: skip confirmations."),
      showId: z.number().optional().describe("bench_show: stored run id."),
      compareIds: z.array(z.number()).optional().describe("bench_compare: [idA, idB]."),
    },
  },
  async ({ action, ...rest }) => {
    const { text, isError } = await runPgAnalyser(action as PgAction, rest as PgParams);
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// Only start the stdio transport when run as the entrypoint, so tests can
// import { server } without spawning a transport.
if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
