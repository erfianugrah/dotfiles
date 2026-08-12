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
import { runSearchMessages, runSemanticSearch, runSearchLedger, runSearchMemories, runListSessions } from "../../.pi/agent/extensions/lib/memledger-core.ts";
import { runDocs, type DocsAction, type DocsParams } from "../../.pi/agent/extensions/lib/docs-core.ts";
import { websearch, codesearch } from "../../.pi/agent/extensions/lib/exa-core.ts";
import { runOsint, type OsintAction } from "../../.pi/agent/extensions/lib/osint-core.ts";
import { renderDiagram } from "../../.pi/agent/extensions/lib/render-diagram-core.ts";
import { extractPdf } from "../../.pi/agent/extensions/lib/pdf-core.ts";
import { queryDocs as context7QueryDocs, resolveLibraryId as context7ResolveLibraryId } from "../../.pi/agent/extensions/lib/context7-core.ts";
import { buildFaviconSet } from "../../.pi/agent/extensions/lib/build-favicon-set-core.ts";
import { runVideoReview, type VideoReviewArgs } from "../../.pi/agent/extensions/lib/video-review-core.ts";

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

// -- memledger (5 tools over PostgREST/embedder at memledger.erfi.io) --------
// Reads are LAN/tailnet-open by design; no credentials. MEMLEDGER_URL overrides
// the default base https://memledger.erfi.io.
server.registerTool(
  "search_messages",
  {
    title: "memledger: search messages",
    description:
      "Full-text search across ALL agent session messages (pi/opencode/claude) in the central memledger store. " +
      "Websearch syntax: words, \"phrases\", OR, -negation. Use for anything older than ~30 days (local logs are pruned) or cross-client.",
    inputSchema: {
      q: z.string().describe("Search query (websearch syntax: words, phrases, OR, -negation)."),
      source: z.string().optional().describe("Filter messages to one client: pi | opencode | claude."),
      limit: z.number().optional().describe("Max rows (default 10, max 50)."),
    },
  },
  async ({ q, source, limit }) => {
    const { text, isError } = await runSearchMessages({ q, source, limit });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

server.registerTool(
  "semantic_search",
  {
    title: "memledger: semantic search",
    description:
      "Semantic (pgvector) similarity search over messages, memories, or ledger_entries in memledger. " +
      "Use for concepts, not exact strings.",
    inputSchema: {
      q: z.string().describe("Concept query."),
      kind: z.enum(["messages", "memories", "ledger_entries"]).optional().describe("Which store (default messages)."),
      source: z.string().optional().describe("Filter messages to one client: pi | opencode | claude."),
      limit: z.number().optional().describe("Max rows (default 10, max 50)."),
    },
  },
  async ({ q, kind, source, limit }) => {
    const { text, isError } = await runSemanticSearch({ q, kind, source, limit });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

server.registerTool(
  "search_ledger",
  {
    title: "memledger: search ledger",
    description: "Search work-ledger summaries in memledger (what was done in past sessions, by project).",
    inputSchema: {
      q: z.string().describe("Search query."),
      limit: z.number().optional().describe("Max rows (default 10, max 50)."),
    },
  },
  async ({ q, limit }) => {
    const { text, isError } = await runSearchLedger({ q, limit });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

server.registerTool(
  "search_memories",
  {
    title: "memledger: search memories",
    description: "Search persistent agent memories in memledger.",
    inputSchema: {
      q: z.string().describe("Search query."),
      limit: z.number().optional().describe("Max rows (default 10, max 50)."),
    },
  },
  async ({ q, limit }) => {
    const { text, isError } = await runSearchMemories({ q, limit });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

server.registerTool(
  "list_sessions",
  {
    title: "memledger: list sessions",
    description: "List recent sessions in memledger, optionally filtered by project basename and/or client (pi|opencode|claude).",
    inputSchema: {
      project: z.string().optional().describe("Project basename filter (ilike)."),
      source: z.string().optional().describe("Filter to one client: pi | opencode | claude."),
      limit: z.number().optional().describe("Max rows (default 10, max 50)."),
    },
  },
  async ({ project, source, limit }) => {
    const { text, isError } = await runListSessions({ project, source, limit });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- docs --------------------------------------------------------------------
server.registerTool(
  "docs",
  {
    title: "docs.erfi.io",
    description:
      "Query the docs.erfi.io documentation mirror over SSH (rg/bat/find on the remote). " +
      "Actions: search (title+summary index, use FIRST), read (a /docs/<source>/... file, " +
      "full or offset+lines range), grep (regex with context inside a path), find (files by " +
      "name/glob), summary (headings-only outline + size), sources (list sources with file " +
      "counts). Docs paths look like /docs/<source>/... - these tools target docs.erfi.io, NOT " +
      "the local filesystem (use the built-in Read tool for local files). Always cite the source " +
      "path(s) in your answer.",
    inputSchema: {
      action: z
        .enum(["search", "read", "grep", "find", "summary", "sources"])
        .describe("Which docs operation to run."),
      query: z.string().optional().describe("search: index search text (multi-word auto-ORs, quote a phrase). grep: regex pattern."),
      source: z.string().optional().describe("search/find: filter to a source (e.g. 'supabase', 'cloudflare'). Omit for all."),
      filter: z.string().optional().describe("sources: filter source names (e.g. 'postgres')."),
      path: z.string().optional().describe("read/grep/summary: /docs/<source>/... file or dir path."),
      filePath: z.string().optional().describe("Alias for 'path' (built-in Read compatibility)."),
      offset: z.number().optional().describe("read: start line (1-indexed)."),
      lines: z.number().optional().describe("read: read N lines (omit to read to end / with offset for a range)."),
      context: z.number().optional().describe("grep: context lines per match (default 3)."),
      pattern: z.string().optional().describe("find: glob pattern (e.g. '*.md', '*auth*')."),
      maxResults: z.number().optional().describe("search (default 15) / find (default 30): max results."),
    },
  },
  async ({ action, ...rest }) => {
    const { text, isError } = await runDocs(action as DocsAction, rest as DocsParams);
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- web_search --------------------------------------------------------------
server.registerTool(
  "web_search",
  {
    title: "Web Search",
    description:
      "Exa web search returning LLM-optimised content strings (not raw HTML). type: auto|fast|deep; " +
      "livecrawl: fallback|preferred. Falls back to SearXNG when Exa returns empty / errors. Use as the " +
      "primary external lookup path for quick discovery. Anonymous Exa tier needs no auth; EXA_API_KEY " +
      "unlocks the higher tier.",
    inputSchema: {
      query: z.string().describe("Search query."),
      numResults: z.number().optional().describe("Number of results (default 8)."),
      type: z.enum(["auto", "fast", "deep"]).optional().describe("Search type (default auto)."),
      livecrawl: z.enum(["fallback", "preferred"]).optional().describe("Live crawl mode (default fallback)."),
      contextMaxCharacters: z.number().optional().describe("Max characters for the LLM-optimised context string (default 10000)."),
    },
  },
  async ({ query, numResults, type, livecrawl, contextMaxCharacters }) => {
    const { text, isError } = await websearch({ query, numResults, type, livecrawl, contextMaxCharacters });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- code_search -------------------------------------------------------------
server.registerTool(
  "code_search",
  {
    title: "Code Search",
    description:
      "Code examples + library documentation via Exa (get_code_context_exa). Token budget 1000-50000 " +
      "(default 5000, clamped). Use for API usage patterns, framework concepts, and specific library docs. " +
      "Anonymous Exa tier needs no auth; EXA_API_KEY unlocks the higher tier.",
    inputSchema: {
      query: z.string().describe("Code/API/library search query. Be specific about the framework, library, or concept."),
      tokensNum: z.number().optional().describe("Tokens to return (1000-50000, default 5000)."),
    },
  },
  async ({ query, tokensNum }) => {
    const { text, isError } = await codesearch({ query, tokensNum });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- osint --------------------------------------------------------------------
server.registerTool(
  "osint",
  {
    title: "OSINT",
    description:
      "OSINT investigations via the research stack's FastAPI service (osint.erfi.io :8890; " +
      "bearer auth from RESEARCH_TOKEN env). Pick an `action`, pass the matching entity arg:\n" +
      "- domain: DNS records, subdomains (subfinder), certs (crt.sh), WHOIS/RDAP. arg: domain; opt mode.\n" +
      "- ip: geolocation, reverse DNS, open ports + CVE tags (Shodan InternetDB), shared hosts. arg: ip; opt include_shared_hosts.\n" +
      "- email: platform registrations (Holehe) + breach exposure (HIBP). arg: email; opt include_breach.\n" +
      "- username: social-platform scan via Sherlock (fast) / Maigret (deep). arg: username; opt mode (fast|deep), show_all.\n" +
      "- url: urlscan.io recent scan history. arg: url; opt submit (scan now).\n" +
      "- phone: libphonenumber metadata + paid-scanner aggregation. arg: phone (intl format, leading +).\n" +
      "- threat: VirusTotal reputation, auto-detects hash/URL/IP/domain. arg: target.\n" +
      "- cve: NVD CVE lookup (CVSS, CWE, refs). arg: cve_id (CVE-YYYY-NNNNN).\n" +
      "- geo: OSM geocode / reverse-geocode / nearby POI. arg: query OR (lat+lon); opt radius_m, tags, limit, mode.\n" +
      "- harvest: theHarvester emails + hosts (slow, ~7min). arg: domain; opt sources, limit.\n" +
      "- archive: Wayback change log for a URL (byte deltas, openable snapshots). arg: url; opt limit, from_date, to_date (digits only), earliest, mode.\n" +
      "Some actions are slow (email/username-deep/harvest run for minutes). Returns terse markdown.",
    inputSchema: {
      action: z
        .enum([
          "domain", "ip", "email", "username", "url",
          "phone", "threat", "cve", "geo", "harvest", "archive",
        ])
        .describe("Which OSINT investigation to run; determines which entity arg is required."),
      domain: z.string().optional().describe("Domain name (action=domain|harvest), e.g. example.com."),
      ip: z.string().optional().describe("IPv4/IPv6 address (action=ip)."),
      email: z.string().optional().describe("Email address (action=email)."),
      username: z.string().optional().describe("Username / handle (action=username)."),
      url: z.string().optional().describe("URL or domain (action=url|archive)."),
      phone: z.string().optional().describe("Phone number, international format with leading + (action=phone)."),
      target: z.string().optional().describe("Hash (SHA256/MD5/SHA1), URL, IP, or domain (action=threat); type auto-detected."),
      cve_id: z.string().optional().describe("CVE id, e.g. CVE-2021-44228 (action=cve)."),
      query: z.string().optional().describe("Place name to geocode (action=geo), e.g. 'Choa Chu Kang, Singapore'."),
      lat: z.number().optional().describe("Latitude for reverse-geocode / POI search (action=geo)."),
      lon: z.number().optional().describe("Longitude for reverse-geocode / POI search (action=geo)."),
      radius_m: z.number().optional().describe("POI search radius in metres (action=geo; default 2000, max 50000)."),
      tags: z.record(z.string(), z.string()).optional().describe("OSM tags for POI search (action=geo), e.g. {\"shop\":\"supermarket\"}; values may be '*'. Omit to skip POI."),
      mode: z.enum(["summary", "full", "fast", "deep"]).optional().describe("domain/geo/archive: 'summary' (default) or 'full'. username: 'fast' (default) or 'deep' (Maigret, ~5min)."),
      include_shared_hosts: z.boolean().optional().describe("action=ip: include passive-DNS shared-host lookup (default true; slow on CDN IPs)."),
      include_breach: z.boolean().optional().describe("action=email: include HIBP breach lookup (default true; needs HIBP_API_KEY server-side)."),
      show_all: z.boolean().optional().describe("action=username: show all hits instead of top 30 (default false)."),
      submit: z.boolean().optional().describe("action=url: submit a new urlscan.io scan (~30-90s); default false (search cache only)."),
      sources: z.string().optional().describe("action=harvest: comma-separated theHarvester sources (e.g. 'bing,duckduckgo,crtsh'); omit for defaults."),
      limit: z.number().optional().describe("Result cap. geo: default 50 max 200. harvest: default 500 max 5000. archive: default 50 cap 200."),
      from_date: z.string().optional().describe("action=archive: lower bound, digits only ('2021' or '202106')."),
      to_date: z.string().optional().describe("action=archive: upper bound, digits only."),
      earliest: z.boolean().optional().describe("action=archive: sample the OLDEST changes instead of most recent (origin question). Default false."),
    },
  },
  async (args) => {
    const { text, isError } = await runOsint({
      ...args,
      action: args.action as OsintAction,
    });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- render_diagram ----------------------------------------------------------
server.registerTool(
  "render_diagram",
  {
    title: "Render Diagram",
    description:
      "Render mermaid/d2 source to SVG (default) or PNG. PNG requires outputPath " +
      "(binary can't be inlined); if outputPath is omitted for SVG the content is " +
      "returned inline. Validates syntax - render/syntax errors are returned as text. " +
      "Requires the mmdc (mermaid-cli) and/or d2 binaries on PATH. d2 for system " +
      "architecture (cleaner, faster); mermaid for sequence/gantt/ER.",
    inputSchema: {
      language: z.enum(["mermaid", "d2"]).describe("Diagram language."),
      source: z.string().describe("Diagram source code (mermaid or d2 syntax)."),
      outputPath: z.string().optional().describe(
        "Where to write the rendered file (absolute or relative to server cwd). Required for PNG. If omitted for SVG, content is returned in tool output.",
      ),
      format: z.enum(["svg", "png"]).optional().describe("Output format (default: svg)."),
      theme: z.string().optional().describe(
        "Theme name. mermaid: 'default'|'dark'|'forest'|'neutral'. d2: theme id (e.g. '0' default, '100' dark, '300' terminal). Omit for default.",
      ),
    },
  },
  async ({ language, source, outputPath, format, theme }) => {
    const { text, isError } = await renderDiagram({
      language,
      source,
      cwd: process.cwd(),
      outputPath,
      format,
      theme,
    });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- pdf ---------------------------------------------------------------------
server.registerTool(
  "pdf",
  {
    title: "PDF Extract",
    description:
      "Extract text from a PDF (the built-in read tool cannot open PDFs). Diagnostic-first routing " +
      "(auto unless `mode` is set): born-digital (has text layer) -> pdftotext -layout (instant, exact); " +
      "scanned (no text layer) -> pdftoppm 300 DPI + tesseract OCR; mode:'tables' -> pdfplumber table " +
      "extraction as markdown (born-digital only, runs ephemerally under uv); mode:'visual' -> rasterize " +
      "pages to PNG and return paths to `read` for layout/figure judgment. Returns extracted text plus " +
      "which strategy ran and a word-count quality signal; auto text-extraction transparently falls back " +
      "to OCR if it comes back empty. Requires poppler-utils (pdffonts/pdftotext/pdftoppm) + tesseract on PATH.",
    inputSchema: {
      path: z.string().describe("Path to the PDF file. Relative paths resolve against server cwd."),
      mode: z.enum(["text", "ocr", "tables", "visual"]).optional().describe("Force a strategy: 'text' (pdftotext), 'ocr' (tesseract), 'tables' (pdfplumber -> markdown), 'visual' (rasterize to PNG for the model to read). Omit for auto."),
      first: z.number().optional().describe("First page (1-indexed) to process."),
      last: z.number().optional().describe("Last page (1-indexed) to process."),
      lang: z.string().optional().describe("Tesseract language(s), e.g. 'eng' or 'eng+nld'. Default 'eng'. OCR only."),
      dpi: z.number().optional().describe("Rasterization DPI for OCR/visual. Default 300."),
    },
  },
  async ({ path, mode, first, last, lang, dpi }) => {
    const { text, isError } = await extractPdf({ path, cwd: process.cwd(), mode, first, last, lang, dpi });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- context7_resolve_library_id ---------------------------------------------
server.registerTool(
  "context7_resolve_library_id",
  {
    title: "Context7 Resolve Library ID",
    description:
      "Resolve a package/product NAME to context7-compatible library IDs (format /org/project). " +
      "Call this BEFORE context7_query_docs unless the user already gave a /org/project ID. " +
      "Each result: library ID, title, description, code-snippet count, trustScore (0-10), " +
      "benchmarkScore (100 best). Use the official name with punctuation (e.g. 'Next.js', 'Three.js').",
    inputSchema: {
      libraryName: z
        .string()
        .describe("Library name to search for. Use the official name with proper punctuation (e.g. 'Next.js' not 'nextjs', 'Three.js' not 'threejs')."),
      query: z
        .string()
        .optional()
        .describe("Optional: the question/task you need help with, used to rank results by relevance. Do NOT include sensitive data."),
    },
  },
  async ({ libraryName, query }) => {
    const { text, isError } = await context7ResolveLibraryId({ libraryName, query });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- context7_query_docs -----------------------------------------------------
server.registerTool(
  "context7_query_docs",
  {
    title: "Context7 Query Docs",
    description:
      "Retrieve up-to-date documentation + code examples from context7 for a library/framework. " +
      "Call context7_resolve_library_id FIRST to obtain the library ID unless the user gave one. " +
      "Library ID format: /org/project or /org/project/version (e.g. /vercel/next.js, /supabase/supabase). " +
      "Token budget defaults 5000 (clamped to 1000-50000): lower = focused, higher = comprehensive.",
    inputSchema: {
      libraryId: z
        .string()
        .describe("Exact context7-compatible library ID (e.g. '/vercel/next.js' or '/vercel/next.js/v14.3.0-canary.87')."),
      query: z
        .string()
        .optional()
        .describe("Specific question / topic. Be specific (e.g. 'How to set up JWT auth in Express.js')."),
      tokensNum: z
        .number()
        .optional()
        .describe("Token budget (1000-50000, default 5000). Lower = focused, higher = comprehensive."),
    },
  },
  async ({ libraryId, query, tokensNum }) => {
    const { text, isError } = await context7QueryDocs({ libraryId, query, tokensNum });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- build_favicon_set -------------------------------------------------------
server.registerTool(
  "build_favicon_set",
  {
    title: "Build Favicon Set",
    description:
      "Generate the full PWA favicon artifact set from a single SVG string or a high-res PNG " +
      "(>=512x512 ideal). Writes to outDir: favicon.ico (multi-res 16/32/48), favicon-16.png, " +
      "favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable.png " +
      "(512x512 with 80% safe-zone), site.webmanifest, and favicon.svg (if SVG input). Returns a " +
      "ready-to-paste HTML <head> snippet. Requires rsvg-convert (SVG input) and ImageMagick " +
      "`magick` on PATH.",
    inputSchema: {
      svg: z.string().optional().describe("SVG source string. Mutually exclusive with pngPath."),
      pngPath: z.string().optional().describe("Path to a high-res PNG (>=512x512 ideal). Mutually exclusive with svg."),
      outDir: z.string().describe("Output directory (absolute or relative to server cwd, e.g. 'public' or 'static')."),
      name: z.string().optional().describe("Filename prefix for favicon.ico/svg/-16/-32 (default: 'favicon')."),
      manifestName: z.string().optional().describe("App name for site.webmanifest (default: 'App')."),
      manifestShortName: z.string().optional().describe("Short name for site.webmanifest (default: same as manifestName, <=12 chars recommended)."),
      themeColor: z.string().optional().describe("PWA theme color (default: '#000000')."),
      backgroundColor: z.string().optional().describe("PWA background color (default: '#ffffff')."),
    },
  },
  async ({ svg, pngPath, outDir, name, manifestName, manifestShortName, themeColor, backgroundColor }) => {
    const { text, isError } = await buildFaviconSet({
      svg,
      pngPath,
      outDir,
      cwd: process.cwd(),
      name,
      manifestName,
      manifestShortName,
      themeColor,
      backgroundColor,
    });
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// -- video_review ------------------------------------------------------------
server.registerTool(
  "video_review",
  {
    title: "Video Review",
    description:
      "Turn a recorded video (call, demo, walkthrough) into a structured doc or an objective " +
      "conversation review via the local whisper stack (:7860). One tool, dispatched by `action`:\n" +
      "  extract - transcribe+diarize (optionally VLM frames), cache a bundle, return a COMPACT summary + bundle path (SLOW, GPU).\n" +
      "  overlap - objective conversation analysis over a cached bundle: speech overlaps (who came in over whom, who yielded), speaking-time, turn-taking latency.\n" +
      "  metrics - speaking-style metrics (wpm/fillers/gap-percentiles/pair-gap-matrix/blocks/repeats) + DAMSL-lite question-flow (self-answered vs assent vs elaboration).\n" +
      "  doc     - assemble markdown-ready evidence (diarized transcript + visual timeline + overlap summary) for you to write the final doc; pass output_path to write it to disk.\n" +
      "  enroll  - manage server-side voice prints (enroll_action add/list/remove) so speakers are auto-named in ALL future transcripts.\n" +
      "  name    - relabel speakers in a cached bundle from a {label:name} map (client-side).\n" +
      "For overlap/metrics/doc/name pass `bundle` (path from extract) or `file` (auto-runs extract first). Requires the whisper service on WHISPER_URL (default http://localhost:7860).",
    inputSchema: {
      action: z.enum(["extract", "overlap", "metrics", "doc", "enroll", "name"]).describe("Which operation to run."),
      file: z.string().optional().describe("Server-side path (/media/... or /tmp/...), 'latest'/'newest', or a filename substring resolved via /api/media. Required for extract; usable in place of bundle for overlap/metrics/doc."),
      bundle: z.string().optional().describe("Path to a cached bundle from a prior extract (overlap/metrics/doc/name/enroll-from-bundle)."),
      diarize: z.boolean().optional().describe("extract: speaker labels + word-level speaker timing (default true; required for overlap)."),
      frames: z.boolean().optional().describe("extract: also run the VLM frame-description pass for the visual track (default false)."),
      min_speakers: z.number().optional().describe("extract: diarization floor (0 = auto)."),
      max_speakers: z.number().optional().describe("extract: diarization ceiling (0 = auto)."),
      language: z.string().optional().describe("extract: ISO code (en, fr) or 'Auto-detect' (default)."),
      translate: z.union([z.boolean(), z.literal("auto")]).optional().describe("extract: 'auto' (default) translates non-English to English; true forces; false keeps source."),
      fps_interval: z.number().optional().describe("extract: seconds between described frames (default 10; only with frames:true)."),
      max_frames: z.number().optional().describe("extract: cap on described frames (default 60; only with frames:true)."),
      timeout_sec: z.number().optional().describe("extract: max seconds to wait for transcription (default 1800)."),
      refresh: z.boolean().optional().describe("extract: bypass the local bundle cache and re-run (default false)."),
      format: z.string().optional().describe("extract/metrics: call format tag (review, customer, discovery, 1:1) for per-format longitudinal baselines; persisted on the bundle."),
      min_overlap_sec: z.number().optional().describe("overlap/metrics: minimum collision duration to count (default 0.3; filters alignment jitter + short backchannels)."),
      max_events: z.number().optional().describe("overlap: cap the overlap-event list (default 40). metrics: cap the question-event list (default 30). Math still runs over all."),
      question_window_sec: z.number().optional().describe("metrics: seconds to wait for a response before classifying a question self-answered/unanswered (default 10)."),
      include_transcript: z.boolean().optional().describe("doc: include the full diarized transcript (default true; can be large)."),
      include_frames: z.boolean().optional().describe("doc: include the VLM visual timeline if present (default true)."),
      include_overlap: z.boolean().optional().describe("doc: include the overlap summary (default true when diarized)."),
      speaker: z.string().optional().describe("doc: filter transcript to these speakers (comma-separated). enroll add-from-bundle: the diarized label to enroll (e.g. 'M-SPEAKER_01')."),
      start: z.number().optional().describe("doc: only include transcript segments ending after this time (seconds). enroll add-from-clip: clip start."),
      end: z.number().optional().describe("doc: only include transcript segments starting before this time (seconds). enroll add-from-clip: clip end."),
      output_path: z.string().optional().describe("doc: write the assembled markdown to this file instead of returning it; returns only stats. Parent dirs are created."),
      enroll_action: z.enum(["add", "list", "remove"]).optional().describe("enroll: 'add' (default), 'list', or 'remove'. On the name action, set to 'add' to also enroll the mapped names as server-side voice prints."),
      name: z.string().optional().describe("enroll: person's name (required for add/remove)."),
      map: z.string().optional().describe("name: name map, JSON {\"M-SPEAKER_01\":\"Alice\"} or compact 'M-SPEAKER_01=Alice, M-SPEAKER_00=Erfi'."),
    },
  },
  async (args) => {
    const { text, isError } = await runVideoReview(args as VideoReviewArgs);
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
  },
);

// Only start the stdio transport when run as the entrypoint, so tests can
// import { server } without spawning a transport.
if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
