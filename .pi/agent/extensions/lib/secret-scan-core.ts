/**
 * secret-scan-core - pure gitleaks/noseyparker parsers (with the 12-char secret
 * truncation baked in so a full secret NEVER reaches a model context), plus the
 * spawn runners and a harness-agnostic orchestrator. ZERO harness imports.
 *
 * Source of truth for the pi adapter (../secret-scan.ts) and the Claude Code
 * MCP toolkit (../../../.claude/mcp/toolkit.ts). Extracted from secret-scan.ts
 * (2026-08-11); see .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as pathResolve } from "node:path";

const TIMEOUT_MS = 120_000;
const MAX_FINDINGS_SHOWN = 200;

// -- flattened finding type --------------------------------------------------

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
  endLine?: number;
  secretPrefix: string; // first 12 chars + length, e.g. "AKIA1234567... (40 chars)"
  commit?: string;
  description?: string;
  tags?: string[];
}

// The single place the truncation happens - keep it here so every caller and
// backend inherits it. Never returns more than 12 chars of the raw secret.
function truncateSecret(secret: string): string {
  return secret.length > 0 ? `${secret.slice(0, 12)}... (${secret.length} chars)` : "(empty)";
}

// Exported for unit testing.
export function parseGitleaksJson(raw: string): SecretFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.map((f) => {
    const finding = f as {
      RuleID?: string;
      File?: string;
      StartLine?: number;
      EndLine?: number;
      Secret?: string;
      Commit?: string;
      Description?: string;
      Tags?: string[];
    };
    return {
      rule: finding.RuleID ?? "(unknown)",
      file: finding.File ?? "(unknown)",
      line: finding.StartLine ?? 0,
      endLine: finding.EndLine,
      secretPrefix: truncateSecret(finding.Secret ?? ""),
      commit: finding.Commit ?? undefined,
      description: finding.Description?.trim(),
      tags: finding.Tags,
    };
  });
}

// Exported for unit testing.
export function parseNoseyparkerJsonl(jsonl: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        rule_name?: string;
        rule_text_id?: string;
        matches?: Array<{
          provenance?: Array<{ path?: string; commit_metadata?: { commit_id?: string } }>;
          location?: { source_span?: { start?: { line?: number } } };
          snippet?: { matching?: string };
        }>;
        finding_id?: string;
      };
      const rule = obj.rule_name ?? obj.rule_text_id ?? "(unknown)";
      for (const m of obj.matches ?? []) {
        const prov = m.provenance?.[0];
        out.push({
          rule,
          file: prov?.path ?? "(unknown)",
          line: m.location?.source_span?.start?.line ?? 0,
          secretPrefix: truncateSecret(m.snippet?.matching ?? ""),
          commit: prov?.commit_metadata?.commit_id,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// -- spawn helpers -----------------------------------------------------------

export interface ScanResult {
  ok: boolean;
  findings: SecretFinding[];
  binaryMissing: boolean;
  errorMessage?: string;
}

interface SpawnRes {
  code: number;
  stdout: string;
  stderr: string;
  binaryMissing: boolean;
}

function spawnAndWait(cmd: string, args: string[]): Promise<SpawnRes> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: `${cmd} not on PATH`, binaryMissing: true });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        binaryMissing: false,
      });
    });
  });
}

export async function runGitleaks(target: string, scanHistory: boolean): Promise<ScanResult> {
  const reportPath = join(mkdtempSync(join(tmpdir(), "gitleaks-")), "report.json");
  try {
    const args = ["detect", "--no-banner", "--report-format=json", `--report-path=${reportPath}`, `--source=${target}`];
    if (!scanHistory) args.push("--no-git");
    const res = await spawnAndWait("gitleaks", args);
    if (res.binaryMissing) return { ok: false, findings: [], binaryMissing: true };
    // gitleaks exits 1 when findings are present, 0 when clean
    if (res.code !== 0 && res.code !== 1) {
      return { ok: false, findings: [], binaryMissing: false, errorMessage: res.stderr.slice(0, 500) };
    }
    if (!existsSync(reportPath)) return { ok: true, findings: [], binaryMissing: false };
    return { ok: true, findings: parseGitleaksJson(readFileSync(reportPath, "utf-8")), binaryMissing: false };
  } finally {
    try {
      rmSync(reportPath, { force: true });
      rmSync(join(reportPath, ".."), { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

export async function runNoseyparker(target: string): Promise<ScanResult> {
  const datastoreDir = mkdtempSync(join(tmpdir(), "np-"));
  try {
    const scanRes = await spawnAndWait("noseyparker", ["scan", "--datastore", datastoreDir, target]);
    if (scanRes.binaryMissing) return { ok: false, findings: [], binaryMissing: true };
    if (scanRes.code !== 0) {
      return { ok: false, findings: [], binaryMissing: false, errorMessage: scanRes.stderr.slice(0, 500) };
    }
    const reportRes = await spawnAndWait("noseyparker", ["report", "--datastore", datastoreDir, "--format", "jsonl"]);
    if (reportRes.code !== 0) {
      return { ok: false, findings: [], binaryMissing: false, errorMessage: reportRes.stderr.slice(0, 500) };
    }
    return { ok: true, findings: parseNoseyparkerJsonl(reportRes.stdout), binaryMissing: false };
  } finally {
    try {
      rmSync(datastoreDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// -- pure rendering ----------------------------------------------------------

export function renderSecrets(findings: SecretFinding[], backend: string, target: string): string {
  const shown = findings.slice(0, MAX_FINDINGS_SHOWN);
  const truncated = findings.length - shown.length;
  const lines = shown.map((f) => {
    const where = f.commit ? `${f.file}:${f.line}@${f.commit.slice(0, 8)}` : `${f.file}:${f.line}`;
    return `[${f.rule}] ${where}\n  ${f.secretPrefix}${f.description ? `\n  ${f.description}` : ""}`;
  });
  const footer =
    truncated > 0
      ? `\n\n(... ${truncated} more findings hidden. Use the structured details.findings array for full list.)`
      : "";
  return `${findings.length} finding${findings.length === 1 ? "" : "s"} (${backend}, ${target}):\n\n${lines.join("\n\n")}${footer}`;
}

// -- harness-agnostic orchestrator -------------------------------------------

export type SecretBackend = "gitleaks" | "noseyparker";

export interface SecretResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function scanSecrets(opts: {
  path?: string;
  cwd: string;
  backend?: SecretBackend;
  scanHistory?: boolean;
}): Promise<SecretResult> {
  const rawPath = opts.path ?? opts.cwd;
  const target = isAbsolute(rawPath) ? rawPath : pathResolve(opts.cwd, rawPath);
  const backend: SecretBackend = opts.backend ?? "gitleaks";

  const result =
    backend === "noseyparker" ? await runNoseyparker(target) : await runGitleaks(target, opts.scanHistory ?? false);

  if (result.binaryMissing) {
    const install = backend === "noseyparker" ? "paru -S noseyparker" : "sudo pacman -S gitleaks (or brew install gitleaks)";
    return {
      isError: true,
      text: `${backend} not on PATH. Install with \`${install}\`.`,
      details: { error: "binary-missing", backend },
    };
  }
  if (!result.ok) {
    return {
      isError: true,
      text: `${backend} failed: ${result.errorMessage ?? "unknown error"}`,
      details: { error: "scan-failed", backend, errorMessage: result.errorMessage },
    };
  }
  if (result.findings.length === 0) {
    return { text: `No secrets detected in ${target} (via ${backend})`, details: { count: 0, backend, target } };
  }

  return {
    text: renderSecrets(result.findings, backend, target),
    details: {
      count: result.findings.length,
      shown: Math.min(result.findings.length, MAX_FINDINGS_SHOWN),
      backend,
      target,
      byRule: result.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.rule] = (acc[f.rule] ?? 0) + 1;
        return acc;
      }, {}),
      findings: result.findings,
    },
  };
}
