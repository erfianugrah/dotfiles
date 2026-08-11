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

// Only start the stdio transport when run as the entrypoint, so tests can
// import { server } without spawning a transport.
if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
