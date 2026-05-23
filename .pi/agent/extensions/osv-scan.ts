/**
 * osv-scan — wrap `osv-scanner` for token-efficient vuln lookups.
 *
 * The raw `osv-scanner` JSON output is nested 4 levels deep with a lot of
 * fields the agent doesn't need. This extension flattens to one line per
 * vulnerability with just the actionable bits: package, version, ecosystem,
 * vuln ID, severity, fixed version, summary.
 *
 * Use this when:
 *   - You want a CVE check on the current repo
 *   - Reviewing whether a dep bump is safe
 *   - Periodic security audit during refactors
 *
 * Requires the `osv-scanner` binary (pacman -S osv-scanner).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// ── flattened vuln type ───────────────────────────────────────────────────

export interface FlatVuln {
  package: string;
  version: string;
  ecosystem: string;
  id: string;
  aliases: string[];
  severity: string | null;
  fixed: string | null;
  summary: string;
  source: string;
}

// Exported for unit testing — pure function over osv-scanner's JSON.
export function parseOsvJson(raw: string): FlatVuln[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const out: FlatVuln[] = [];
  const results = (parsed as { results?: unknown[] }).results ?? [];
  if (!Array.isArray(results)) return [];

  for (const r of results) {
    const result = r as {
      source?: { path?: string };
      packages?: Array<{
        package?: { name?: string; version?: string; ecosystem?: string };
        vulnerabilities?: Array<{
          id?: string;
          aliases?: string[];
          summary?: string;
          severity?: Array<{ type?: string; score?: string }>;
          database_specific?: { severity?: string };
          affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
        }>;
      }>;
    };
    const sourcePath = result.source?.path ?? "(unknown)";
    for (const p of result.packages ?? []) {
      const name = p.package?.name ?? "(unknown)";
      const version = p.package?.version ?? "(unknown)";
      const ecosystem = p.package?.ecosystem ?? "(unknown)";
      for (const v of p.vulnerabilities ?? []) {
        // Severity precedence: database_specific.severity > first CVSS score
        let severity: string | null = v.database_specific?.severity ?? null;
        if (!severity && v.severity?.[0]?.score) severity = v.severity[0].score;

        // First "fixed" event across all affected ranges
        let fixed: string | null = null;
        for (const aff of v.affected ?? []) {
          for (const range of aff.ranges ?? []) {
            for (const event of range.events ?? []) {
              if (event.fixed) {
                fixed = event.fixed;
                break;
              }
            }
            if (fixed) break;
          }
          if (fixed) break;
        }

        out.push({
          package: name,
          version,
          ecosystem,
          id: v.id ?? "(no id)",
          aliases: v.aliases ?? [],
          severity,
          fixed,
          summary: (v.summary ?? "").trim(),
          source: sourcePath,
        });
      }
    }
  }
  return out;
}

// ── spawn helper ──────────────────────────────────────────────────────────

async function runOsvScanner(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("osv-scanner", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => {
      totalBytes += b.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      stdoutChunks.push(b);
    });
    proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: "osv-scanner not found on PATH", code: 127 });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      // osv-scanner exits 1 when vulns found, 0 when clean. Both are "ok" runs.
      const ok = (code === 0 || code === 1) && !truncated;
      resolve({ ok, stdout, stderr, code: code ?? 1 });
    });
  });
}

// ── tool definition ───────────────────────────────────────────────────────

const osvScanTool = defineTool({
  name: "osv_scan",
  label: "OSV Scan",
  promptSnippet: "osv_scan — vuln scan via osv-scanner. Use before deploys / dep bumps.",
  promptGuidelines: [
    "Default scans cwd. Pass `lockfile` to scan a specific lockfile only.",
    "Result is flattened — one entry per (package, vulnerability_id) pair.",
  ],
  description: [
    "Run osv-scanner against a directory or lockfile and return a flattened list of vulnerabilities.",
    "",
    "Each entry contains: package, version, ecosystem, id (e.g. GHSA-xxx / CVE-yyyy-N / GO-zzz), aliases, severity, fixed version, summary, source path.",
    "",
    "Covers all ecosystems osv-scanner supports (Go modules, npm/pnpm/yarn, Cargo, pip/poetry, Composer, Maven, NuGet, RubyGems, ...).",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Directory or lockfile to scan (default: cwd). Relative paths resolved against cwd.",
      }),
    ),
    lockfile_only: Type.Optional(
      Type.Boolean({
        description: "If true, treat `path` as a single lockfile via -L. Default: recursive directory scan via -r.",
      }),
    ),
    include_dev: Type.Optional(
      Type.Boolean({
        description: "Include dev dependencies (--include-dev). Default: false.",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const rawPath = params.path ?? ctx.cwd;
    const target = isAbsolute(rawPath) ? rawPath : pathResolve(ctx.cwd, rawPath);

    const args: string[] = ["--format=json"];
    if (params.lockfile_only) args.push("-L", target);
    else args.push("-r", target);
    if (params.include_dev) args.push("--include-dev");

    const result = await runOsvScanner(args);
    if (result.code === 127) {
      return {
        isError: true,
        content: [{ type: "text", text: "osv-scanner not on PATH. Install with `sudo pacman -S osv-scanner`." }],
        details: { error: "binary-missing" },
      };
    }
    if (!result.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `osv-scanner failed (exit ${result.code}): ${result.stderr.slice(0, 500) || "no stderr"}`,
          },
        ],
        details: { code: result.code, stderr: result.stderr.slice(0, 1000) },
      };
    }

    const vulns = parseOsvJson(result.stdout);
    if (vulns.length === 0) {
      return {
        content: [{ type: "text", text: `No vulnerabilities found in ${target}` }],
        details: { count: 0, target },
      };
    }

    // Compact text rendering — one line per vuln, severity-color-coded by prefix
    const lines = vulns.map((v) => {
      const sev = v.severity ? `[${v.severity}]` : "[?]";
      const fix = v.fixed ? ` → fixed in ${v.fixed}` : "";
      const aliases = v.aliases.length > 0 ? ` (${v.aliases.slice(0, 2).join(", ")})` : "";
      return `${sev} ${v.id}${aliases}  ${v.ecosystem}/${v.package}@${v.version}${fix}\n  ${v.summary.slice(0, 200)}`;
    });
    const text = `${vulns.length} vulnerabilit${vulns.length === 1 ? "y" : "ies"} in ${target}:\n\n${lines.join("\n\n")}`;
    return {
      content: [{ type: "text", text }],
      details: {
        count: vulns.length,
        target,
        bySeverity: vulns.reduce<Record<string, number>>((acc, v) => {
          const k = v.severity ?? "unknown";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        vulns,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(osvScanTool);
}
