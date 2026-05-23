/**
 * secret-scan — wrap `gitleaks` (default) or `noseyparker` for token-efficient
 * secret detection.
 *
 * Token economy: gitleaks JSON is one object per finding with ~15 fields.
 * This wrapper returns just the essentials: rule, file, line, secret prefix
 * (first 12 chars + length, never the full secret), commit if available.
 *
 * Two backends:
 *   - gitleaks  (default) — fast, regex-based, covers most known secret formats
 *   - noseyparker         — entropy-based + provenance tracking, smarter
 *
 * Use noseyparker when gitleaks has too many false positives in a project,
 * or when scanning historical git blobs (it's better at deduping).
 *
 * Requires gitleaks (pacman -S gitleaks) and/or noseyparker (paru -S noseyparker).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 120_000;
const MAX_FINDINGS_SHOWN = 200;

// ── flattened finding type ────────────────────────────────────────────────

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
    const secret = finding.Secret ?? "";
    const shortPrefix = secret.length > 0 ? `${secret.slice(0, 12)}... (${secret.length} chars)` : "(empty)";
    return {
      rule: finding.RuleID ?? "(unknown)",
      file: finding.File ?? "(unknown)",
      line: finding.StartLine ?? 0,
      endLine: finding.EndLine,
      secretPrefix: shortPrefix,
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
        // newer format uses different layout
        finding_id?: string;
      };
      const rule = obj.rule_name ?? obj.rule_text_id ?? "(unknown)";
      for (const m of obj.matches ?? []) {
        const prov = m.provenance?.[0];
        const file = prov?.path ?? "(unknown)";
        const commit = prov?.commit_metadata?.commit_id;
        const lineNum = m.location?.source_span?.start?.line ?? 0;
        const matching = m.snippet?.matching ?? "";
        const shortPrefix = matching.length > 0 ? `${matching.slice(0, 12)}... (${matching.length} chars)` : "(empty)";
        out.push({
          rule,
          file,
          line: lineNum,
          secretPrefix: shortPrefix,
          commit,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// ── spawn helpers ─────────────────────────────────────────────────────────

interface ScanResult {
  ok: boolean;
  findings: SecretFinding[];
  binaryMissing: boolean;
  errorMessage?: string;
}

async function runGitleaks(target: string, scanHistory: boolean): Promise<ScanResult> {
  const reportPath = join(mkdtempSync(join(tmpdir(), "gitleaks-")), "report.json");
  try {
    const args = [
      "detect",
      "--no-banner",
      "--report-format=json",
      `--report-path=${reportPath}`,
      `--source=${target}`,
    ];
    if (!scanHistory) args.push("--no-git");
    const res = await spawnAndWait("gitleaks", args);
    if (res.binaryMissing) return { ok: false, findings: [], binaryMissing: true };
    // gitleaks exits 1 when findings are present, 0 when clean
    if (res.code !== 0 && res.code !== 1) {
      return { ok: false, findings: [], binaryMissing: false, errorMessage: res.stderr.slice(0, 500) };
    }
    if (!existsSync(reportPath)) return { ok: true, findings: [], binaryMissing: false };
    const raw = readFileSync(reportPath, "utf-8");
    return { ok: true, findings: parseGitleaksJson(raw), binaryMissing: false };
  } finally {
    try {
      rmSync(reportPath, { force: true });
      rmSync(join(reportPath, ".."), { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

async function runNoseyparker(target: string): Promise<ScanResult> {
  const datastoreDir = mkdtempSync(join(tmpdir(), "np-"));
  try {
    const scanRes = await spawnAndWait("noseyparker", ["scan", "--datastore", datastoreDir, target]);
    if (scanRes.binaryMissing) return { ok: false, findings: [], binaryMissing: true };
    if (scanRes.code !== 0) {
      return { ok: false, findings: [], binaryMissing: false, errorMessage: scanRes.stderr.slice(0, 500) };
    }
    const reportRes = await spawnAndWait("noseyparker", [
      "report",
      "--datastore",
      datastoreDir,
      "--format",
      "jsonl",
    ]);
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

interface SpawnRes {
  code: number;
  stdout: string;
  stderr: string;
  binaryMissing: boolean;
}

async function spawnAndWait(cmd: string, args: string[]): Promise<SpawnRes> {
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

// ── tool definition ───────────────────────────────────────────────────────

const secretScanTool = defineTool({
  name: "secret_scan",
  label: "Secret Scan",
  promptSnippet: "secret_scan — find leaked secrets in code. Run before commits, in pre-commit hooks, or during PR review.",
  promptGuidelines: [
    "Default backend is gitleaks (fast). Use backend='noseyparker' for smarter dedup or when gitleaks misses entropy-based secrets.",
    "Defaults to working-tree only (no git history). Set scan_history=true to also scan commits.",
    "Secret values are TRUNCATED to first 12 chars in output \u2014 the full value never appears in the agent's context.",
  ],
  description: [
    "Scan a directory for leaked secrets using gitleaks (default) or noseyparker.",
    "",
    "Returns a list of findings: rule (which detector fired), file, line, secret prefix (first 12 chars + total length), commit (if scanning git history).",
    "",
    "Secret values are intentionally truncated so the full secret never enters the agent's context window.",
  ].join("\n"),
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Directory or repo path to scan (default: cwd). Relative resolved against cwd.",
      }),
    ),
    backend: Type.Optional(
      Type.Union([Type.Literal("gitleaks"), Type.Literal("noseyparker")], {
        description: "Scanner to use. Default: gitleaks (fast, regex). noseyparker is entropy+provenance-based.",
      }),
    ),
    scan_history: Type.Optional(
      Type.Boolean({
        description: "If true, scan git history too. Only meaningful for gitleaks. Default: false (working tree only).",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const rawPath = params.path ?? ctx.cwd;
    const target = isAbsolute(rawPath) ? rawPath : pathResolve(ctx.cwd, rawPath);
    const backend = params.backend ?? "gitleaks";

    const result =
      backend === "noseyparker"
        ? await runNoseyparker(target)
        : await runGitleaks(target, params.scan_history ?? false);

    if (result.binaryMissing) {
      const install =
        backend === "noseyparker"
          ? "paru -S noseyparker"
          : "sudo pacman -S gitleaks";
      return {
        isError: true,
        content: [{ type: "text", text: `${backend} not on PATH. Install with \`${install}\`.` }],
        details: { error: "binary-missing", backend },
      };
    }
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `${backend} failed: ${result.errorMessage ?? "unknown error"}` }],
        details: { error: "scan-failed", backend, errorMessage: result.errorMessage },
      };
    }

    if (result.findings.length === 0) {
      return {
        content: [{ type: "text", text: `No secrets detected in ${target} (via ${backend})` }],
        details: { count: 0, backend, target },
      };
    }

    const shown = result.findings.slice(0, MAX_FINDINGS_SHOWN);
    const truncated = result.findings.length - shown.length;
    const lines = shown.map((f) => {
      const where = f.commit ? `${f.file}:${f.line}@${f.commit.slice(0, 8)}` : `${f.file}:${f.line}`;
      return `[${f.rule}] ${where}\n  ${f.secretPrefix}${f.description ? `\n  ${f.description}` : ""}`;
    });
    const footer =
      truncated > 0
        ? `\n\n(... ${truncated} more findings hidden. Use the structured details.findings array for full list.)`
        : "";
    const text = `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} (${backend}, ${target}):\n\n${lines.join("\n\n")}${footer}`;

    return {
      content: [{ type: "text", text }],
      details: {
        count: result.findings.length,
        shown: shown.length,
        backend,
        target,
        byRule: result.findings.reduce<Record<string, number>>((acc, f) => {
          acc[f.rule] = (acc[f.rule] ?? 0) + 1;
          return acc;
        }, {}),
        findings: result.findings,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(secretScanTool);
}
