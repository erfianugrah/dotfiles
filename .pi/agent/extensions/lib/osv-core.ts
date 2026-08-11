/**
 * osv-core - pure osv-scanner arg-building, JSON projection, rendering, and a
 * spawn orchestrator. ZERO harness imports (node stdlib + global only).
 * Source of truth for the pi adapter (../osv-scan.ts) and the Claude Code MCP
 * toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * Extracted from osv-scan.ts (2026-08-11); see
 * .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { spawn } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// -- flattened vuln type -----------------------------------------------------

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

// Pure function over osv-scanner's JSON. Exported for unit testing.
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

// Pure: build the osv-scanner argv. Exported for unit testing.
export function buildOsvArgs(target: string, opts: { lockfileOnly?: boolean; includeDev?: boolean } = {}): string[] {
  const args: string[] = ["--format=json"];
  if (opts.lockfileOnly) args.push("-L", target);
  else args.push("-r", target);
  if (opts.includeDev) args.push("--include-dev");
  return args;
}

// Pure: render the flattened vulns to a compact text block. Exported for tests.
export function renderOsv(vulns: FlatVuln[], target: string): string {
  const lines = vulns.map((v) => {
    const sev = v.severity ? `[${v.severity}]` : "[?]";
    const fix = v.fixed ? ` -> fixed in ${v.fixed}` : "";
    const aliases = v.aliases.length > 0 ? ` (${v.aliases.slice(0, 2).join(", ")})` : "";
    return `${sev} ${v.id}${aliases}  ${v.ecosystem}/${v.package}@${v.version}${fix}\n  ${v.summary.slice(0, 200)}`;
  });
  return `${vulns.length} vulnerabilit${vulns.length === 1 ? "y" : "ies"} in ${target}:\n\n${lines.join("\n\n")}`;
}

// -- spawn helper ------------------------------------------------------------

export async function runOsvScanner(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
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

// -- harness-agnostic orchestrator -------------------------------------------

export interface OsvResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function scanOsv(opts: {
  path?: string;
  cwd: string;
  lockfileOnly?: boolean;
  includeDev?: boolean;
}): Promise<OsvResult> {
  const rawPath = opts.path ?? opts.cwd;
  const target = isAbsolute(rawPath) ? rawPath : pathResolve(opts.cwd, rawPath);

  const result = await runOsvScanner(buildOsvArgs(target, opts));
  if (result.code === 127) {
    return {
      isError: true,
      text: "osv-scanner not on PATH. Install with `sudo pacman -S osv-scanner` (or `brew install osv-scanner`).",
      details: { error: "binary-missing" },
    };
  }
  if (!result.ok) {
    return {
      isError: true,
      text: `osv-scanner failed (exit ${result.code}): ${result.stderr.slice(0, 500) || "no stderr"}`,
      details: { code: result.code, stderr: result.stderr.slice(0, 1000) },
    };
  }

  const vulns = parseOsvJson(result.stdout);
  if (vulns.length === 0) {
    return { text: `No vulnerabilities found in ${target}`, details: { count: 0, target } };
  }
  return {
    text: renderOsv(vulns, target),
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
}
