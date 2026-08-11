/**
 * pg-analyser-core - pure per-action validation + argv-building + the
 * report-dir scraper, plus the binary-resolution spawn. ZERO harness imports.
 * Source of truth for the pi adapter (../pg-analyser.pi.ts) and the Claude Code
 * MCP toolkit (../../../.claude/mcp/toolkit.ts).
 *
 * pg-analyser is a thin CLI wrapper, so the reusable/pure surface is the
 * argument construction and the stderr breadcrumb parsing; the tool stays thin.
 * Extracted 2026-08-12; see .pi/agent/docs/pi-to-claude-code-port.md.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.PG_ANALYSER_REPO ?? join(homedir(), "work", "pg-analyser");

export type PgAction =
  | "analyze" | "full" | "snapshot"
  | "report" | "pdf" | "summary"
  | "import_trends" | "export_prometheus" | "scrape_init"
  | "narrate_prompt" | "narrate_import"
  | "bench" | "bench_list" | "bench_show" | "bench_compare";

export interface PgParams {
  ref?: string;
  dir?: string;
  out?: string;
  all?: boolean;
  dbUrl?: string;
  profile?: string;
  noPat?: boolean;
  interval?: string;
  trendDays?: number;
  brand?: string;
  overlay?: string;
  store?: string;
  files?: string[];
  narrative?: boolean;
  summary?: string;
  scripts?: string[];
  builtin?: string;
  scale?: number;
  init?: boolean;
  clients?: number;
  threads?: number;
  timeS?: number;
  warmup?: number;
  runs?: number;
  protocol?: string;
  rate?: number;
  resetStats?: boolean;
  name?: string;
  yes?: boolean;
  showId?: number;
  compareIds?: number[];
}

// Pure: return an error message if the action's required params are missing, else null.
export function validatePgAction(a: PgAction, p: PgParams): string | null {
  if ((a === "analyze" || a === "snapshot") && !p.ref && !p.dbUrl) return `${a} needs ref or dbUrl`;
  if (a === "full" && !p.ref && !p.dbUrl && !p.profile && !p.all) return "full needs ref, dbUrl, profile, or all";
  if ((a === "report" || a === "pdf" || a === "summary" || a === "export_prometheus" || a.startsWith("narrate")) && !p.dir)
    return `dir is required for ${a}`;
  if (a === "import_trends" && (!p.dir || !p.files?.length)) return "import_trends needs dir + files";
  if (a === "scrape_init" && !p.ref) return "scrape_init needs ref";
  if (a === "bench" && !p.dbUrl) return "bench needs dbUrl (pgbench speaks the wire protocol)";
  if (a === "bench" && p.init && !p.yes) return "bench init DROPS pgbench_* tables - pass yes:true to confirm";
  if (a === "bench_show" && p.showId == null) return "bench_show needs showId";
  if (a === "bench_compare" && (p.compareIds?.length ?? 0) !== 2) return "bench_compare needs compareIds: [idA, idB]";
  return null;
}

function collectFlags(p: PgParams): string[] {
  const f: string[] = [];
  if (p.ref) f.push("--ref", p.ref);
  if (p.dbUrl) f.push("--db-url", p.dbUrl);
  if (p.profile) f.push("--profile", p.profile);
  if (p.noPat) f.push("--no-pat");
  if (p.interval) f.push("--interval", p.interval);
  if (p.trendDays != null) f.push("--trend-days", String(p.trendDays));
  if (p.store) f.push("--store", p.store);
  return f;
}

function renderFlags(p: PgParams): string[] {
  const f: string[] = [];
  if (p.brand) f.push("--brand", p.brand);
  if (p.overlay) f.push("--overlay", p.overlay);
  return f;
}

// Pure: pull an output/report/index dir from the CLI's stderr breadcrumbs.
export function findReportDir(s: string): string | undefined {
  return s.match(/done: (\S+)|> index: (\S+)|> (reports\/\S+)/)?.slice(1).find(Boolean);
}

// Pure: build the argv (+ optional stdin) for an action. Returns null for
// narrate_prompt, whose two-step flow is handled by the orchestrator.
export function buildPgArgs(a: PgAction, p: PgParams): { argv: string[]; stdin?: string } | null {
  if (a === "analyze" || a === "full" || a === "snapshot") {
    return {
      argv: [
        a,
        ...collectFlags(p),
        ...(p.all && a === "full" ? ["--all"] : []),
        ...(p.out ? ["--out", p.out] : []),
        ...(a === "full" ? renderFlags(p) : []),
      ],
    };
  }
  if (a === "report" || a === "pdf" || a === "summary") {
    return { argv: [a, p.dir!, ...(p.narrative && a !== "summary" ? ["--narrative"] : []), ...renderFlags(p)] };
  }
  if (a === "import_trends") return { argv: ["import-trends", p.dir!, ...p.files!] };
  if (a === "export_prometheus") {
    return { argv: ["export-prometheus", p.dir!, ...(p.ref ? ["--ref", p.ref] : []), ...(p.store ? ["--store", p.store] : [])] };
  }
  if (a === "scrape_init") return { argv: ["scrape-init", "--ref", p.ref!, ...(p.out ? ["--dir", p.out] : [])] };
  if (a === "bench") {
    return {
      argv: [
        "bench",
        "--db-url", p.dbUrl!,
        ...(p.ref ? ["--ref", p.ref] : []),
        ...(p.scripts ?? []).flatMap((s) => ["-f", s]),
        ...(p.builtin ? ["-b", p.builtin] : []),
        ...(p.scale != null ? ["--scale", String(p.scale)] : []),
        ...(p.init ? ["--init"] : []),
        ...(p.clients != null ? ["-c", String(p.clients)] : []),
        ...(p.threads != null ? ["-j", String(p.threads)] : []),
        ...(p.timeS != null ? ["-T", String(p.timeS)] : []),
        ...(p.warmup != null ? ["--warmup", String(p.warmup)] : []),
        ...(p.runs != null ? ["--runs", String(p.runs)] : []),
        ...(p.protocol ? ["--protocol", p.protocol] : []),
        ...(p.rate != null ? ["--rate", String(p.rate)] : []),
        ...(p.resetStats ? ["--reset-stats"] : []),
        ...(p.name ? ["--name", p.name] : []),
        ...(p.yes ? ["--yes"] : []),
        ...(p.store ? ["--store", p.store] : []),
      ],
    };
  }
  if (a === "bench_list" || a === "bench_show" || a === "bench_compare") {
    return {
      argv: [
        "bench",
        ...(a === "bench_list" ? ["--list"] : []),
        ...(a === "bench_show" ? ["--show", String(p.showId)] : []),
        ...(a === "bench_compare" ? ["--compare", ...p.compareIds!.map(String)] : []),
        ...(p.ref && a === "bench_list" ? ["--ref", p.ref] : []),
        ...(p.store ? ["--store", p.store] : []),
      ],
    };
  }
  if (a === "narrate_import") return { argv: ["narrate", p.dir!, "--import", "-"], stdin: p.summary };
  return null; // narrate_prompt
}

// -- binary resolution + spawn (harness-agnostic) ----------------------------

function spawn(cmd: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ENOENT (binary not found) rejects so we can fall back; a non-zero exit
      // with output resolves (the CLI prints its error to stderr).
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

// Resolve pg-analyser: explicit $PG_ANALYSER_BIN, else `pg-analyser` on PATH, else bun+source.
export async function runPg(argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  if (process.env.PG_ANALYSER_BIN) return spawn(process.env.PG_ANALYSER_BIN, argv, stdin);
  try {
    return await spawn("pg-analyser", argv, stdin);
  } catch {
    return spawn("bun", ["run", join(REPO, "src/index.ts"), ...argv], stdin);
  }
}

// -- harness-agnostic orchestrator -------------------------------------------

export interface PgResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

export async function runPgAnalyser(a: PgAction, p: PgParams): Promise<PgResult> {
  const verr = validatePgAction(a, p);
  if (verr) return { isError: true, text: `error: ${verr}`, details: { error: verr } };

  try {
    if (a === "narrate_prompt") {
      await runPg(["narrate", p.dir!, "--print-prompt"]);
      const prompt = readFileSync(join(p.dir!, "prompt.md"), "utf-8");
      return {
        text:
          "Grounded executive-summary prompt below. Write the summary per its rules, then call " +
          "pg-analyser(action:'narrate_import', dir, summary:<your markdown>).\n\n" +
          prompt,
        details: { dir: p.dir },
      };
    }

    const built = buildPgArgs(a, p);
    if (!built) return { isError: true, text: `error: unhandled action ${a}`, details: { error: "unhandled" } };
    const { stdout, stderr } = await runPg(built.argv, built.stdin);

    if (a === "analyze" || a === "full" || a === "snapshot") {
      return { text: stderr.trim() || "done", details: { dir: findReportDir(stderr) } };
    }
    if (a === "bench" || a === "bench_list" || a === "bench_show" || a === "bench_compare") {
      return { text: `${stderr.trim()}\n${stdout.trim()}`.trim(), details: {} };
    }
    if (a === "narrate_import") {
      return {
        text: `${stderr.trim()}\n> render: pg-analyser(action:'report', dir, narrative:true)`,
        details: { dir: p.dir },
      };
    }
    // report / pdf / summary / import_trends / export_prometheus / scrape_init
    return { text: stderr.trim() || "done", details: {} };
  } catch (err) {
    return {
      isError: true,
      text: `pg-analyser failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { error: "spawn-failed" },
    };
  }
}
