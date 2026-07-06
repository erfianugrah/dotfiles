/**
 * sbperf pi extension - drive the sbperf CLI from pi as a single tool.
 *
 * This repo file is the source of truth; sync it into your pi env after edits:
 *   cp ~/sbperf/extensions/sbperf.pi.ts ~/.pi/agent/extensions/sbperf.pi.ts
 *   # (or symlink it). Restart pi. The `sbperf` tool then appears.
 *
 * Binary resolution (first that works):
 *   1. $SBPERF_BIN                       (explicit path to the compiled binary)
 *   2. `sbperf` on $PATH                 (after `bun run build && mv sbperf ~/.local/bin`)
 *   3. `bun run $SBPERF_REPO/src/index.ts`  ($SBPERF_REPO or ~/sbperf)
 *
 * The interesting bit is the copy-paste narrate round-trip WITHOUT any LLM
 * endpoint: pi itself is the model.
 *   - action "narrate_prompt" runs `narrate <dir> --print-prompt` and RETURNS the
 *     grounded prompt (system rules + JSON digest) as the tool result, so pi can
 *     write the executive summary in-session, grounded in the collected facts.
 *   - action "narrate_import" takes that written summary back and embeds it via
 *     `narrate <dir> --import -`, then you render with report(narrative:true).
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REPO = process.env.SBPERF_REPO ?? join(homedir(), "sbperf");

/** Run a command, feeding optional stdin, capturing output (no throw on exit>0). */
function spawn(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
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

/** Invoke sbperf: explicit $SBPERF_BIN, else `sbperf` on PATH, else bun+source. */
async function run(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  if (process.env.SBPERF_BIN) return spawn(process.env.SBPERF_BIN, args, stdin);
  try {
    return await spawn("sbperf", args, stdin);
  } catch {
    return spawn("bun", ["run", join(REPO, "src/index.ts"), ...args], stdin);
  }
}

const sbperfTool = defineTool({
  name: "sbperf",
  label: "sbperf",
  description:
    "Run the sbperf Supabase performance auditor. Actions: analyze/full (collect + render a project - PAT, or no-PAT via db_url/profile), snapshot (append to the trend history store), report/pdf/summary (re-render a dir), import_trends/export_prometheus/scrape_init (trend plumbing), narrate_prompt (get the grounded executive-summary prompt so YOU can write it in-session), narrate_import (embed a summary you wrote back). Then report with narrative=true.",
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("analyze"),
        Type.Literal("full"),
        Type.Literal("snapshot"),
        Type.Literal("report"),
        Type.Literal("pdf"),
        Type.Literal("summary"),
        Type.Literal("import_trends"),
        Type.Literal("export_prometheus"),
        Type.Literal("scrape_init"),
        Type.Literal("narrate_prompt"),
        Type.Literal("narrate_import"),
      ],
      { description: "What to do" },
    ),
    ref: Type.Optional(
      Type.String({
        description:
          "Project ref (analyze/full/snapshot/scrape_init). Accepts comma/space lists for a full subset sweep.",
      }),
    ),
    dir: Type.Optional(
      Type.String({
        description:
          "Report dir with analysis.json (report/pdf/summary/import_trends/export_prometheus/narrate_*)",
      }),
    ),
    out: Type.Optional(Type.String({ description: "Output dir override (analyze/full)" })),
    all: Type.Optional(
      Type.Boolean({ description: "full: audit every project in the account (needs a PAT)" }),
    ),
    dbUrl: Type.Optional(
      Type.String({
        description:
          "Superuser Postgres connstring - the full-access SQL tier (analyze/full/snapshot). SOLE data source in no-PAT mode. A secret; never written to analysis.json.",
      }),
    ),
    profile: Type.Optional(
      Type.String({
        description:
          "full: path to a --profile JSON (forces no-PAT + region-mapped Grafana + customer DBs -> per-DB sweep).",
      }),
    ),
    noPat: Type.Optional(
      Type.Boolean({
        description: "Force no-PAT mode: ignore any token, run on db_url + Grafana alone.",
      }),
    ),
    interval: Type.Optional(
      Type.String({
        description: "Analytics timeframe: 15min|30min|1hr|3hr|1day|3day|7day (default 1day).",
      }),
    ),
    trendDays: Type.Optional(
      Type.Number({
        description: "Trend query window in days (default 30; profile.trendDays wins).",
      }),
    ),
    brand: Type.Optional(Type.String({ description: "White-label branding JSON (render paths)." })),
    overlay: Type.Optional(
      Type.String({
        description: "Per-project review overlay JSON (hide sections + notes; render paths).",
      }),
    ),
    store: Type.Optional(
      Type.String({
        description:
          "History SQLite file (snapshot/export_prometheus; default ~/.sbperf/history.db).",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description: "import_trends: CSV/JSON series files to merge into analysis.trends.",
      }),
    ),
    narrative: Type.Optional(
      Type.Boolean({ description: "report/pdf: embed the narrative (run narrate_import first)" }),
    ),
    summary: Type.Optional(
      Type.String({ description: "narrate_import: the executive-summary markdown to embed" }),
    ),
  }),

  async execute(_id, p) {
    const a = p.action;
    const err = (text: string) => ({
      content: [{ type: "text" as const, text: `error: ${text}` }],
    });
    // A collect path needs SOMETHING to target: a ref, a superuser db_url, a
    // profile (its own DBs), or --all. no-PAT runs off db_url/profile alone.
    if ((a === "analyze" || a === "snapshot") && !p.ref && !p.dbUrl)
      return err(`${a} needs ref or dbUrl`);
    if (a === "full" && !p.ref && !p.dbUrl && !p.profile && !p.all)
      return err("full needs ref, dbUrl, profile, or all");
    if (
      (a === "report" ||
        a === "pdf" ||
        a === "summary" ||
        a === "export_prometheus" ||
        a.startsWith("narrate")) &&
      !p.dir
    )
      return err(`dir is required for ${a}`);
    if (a === "import_trends" && (!p.dir || !p.files?.length))
      return err("import_trends needs dir + files");
    if (a === "scrape_init" && !p.ref) return err("scrape_init needs ref");

    // Flags shared by the collect paths (analyze/full/snapshot).
    const collectFlags = (): string[] => {
      const f: string[] = [];
      if (p.ref) f.push("--ref", p.ref);
      if (p.dbUrl) f.push("--db-url", p.dbUrl);
      if (p.profile) f.push("--profile", p.profile);
      if (p.noPat) f.push("--no-pat");
      if (p.interval) f.push("--interval", p.interval);
      if (p.trendDays != null) f.push("--trend-days", String(p.trendDays));
      if (p.store) f.push("--store", p.store);
      return f;
    };
    // Presentation flags for the render paths (full also renders).
    const renderFlags = (): string[] => {
      const f: string[] = [];
      if (p.brand) f.push("--brand", p.brand);
      if (p.overlay) f.push("--overlay", p.overlay);
      return f;
    };
    // Pull an output/report/index dir out of the CLI's stderr breadcrumbs.
    const findDir = (s: string): string | undefined =>
      s
        .match(/done: (\S+)|> index: (\S+)|> (reports\/\S+)/)
        ?.slice(1)
        .find(Boolean);

    try {
      if (a === "analyze" || a === "full" || a === "snapshot") {
        const args = [
          a,
          ...collectFlags(),
          ...(p.all ? ["--all"] : []),
          ...(p.out ? ["--out", p.out] : []),
          ...(a === "full" ? renderFlags() : []),
        ];
        const { stderr } = await run(args);
        return {
          content: [{ type: "text", text: stderr.trim() || "done" }],
          details: { dir: findDir(stderr) },
        };
      }
      if (a === "report" || a === "pdf" || a === "summary") {
        const args = [
          a,
          p.dir!,
          ...(p.narrative && a !== "summary" ? ["--narrative"] : []),
          ...renderFlags(),
        ];
        const { stderr } = await run(args);
        return { content: [{ type: "text", text: stderr.trim() || "done" }] };
      }
      if (a === "import_trends") {
        const { stderr } = await run(["import-trends", p.dir!, ...p.files!]);
        return { content: [{ type: "text", text: stderr.trim() || "done" }] };
      }
      if (a === "export_prometheus") {
        const args = [
          "export-prometheus",
          p.dir!,
          ...(p.ref ? ["--ref", p.ref] : []),
          ...(p.store ? ["--store", p.store] : []),
        ];
        const { stderr } = await run(args);
        return { content: [{ type: "text", text: stderr.trim() || "done" }] };
      }
      if (a === "scrape_init") {
        const args = ["scrape-init", "--ref", p.ref!, ...(p.out ? ["--dir", p.out] : [])];
        const { stderr } = await run(args);
        return { content: [{ type: "text", text: stderr.trim() || "done" }] };
      }
      if (a === "narrate_prompt") {
        await run(["narrate", p.dir!, "--print-prompt"]);
        const prompt = await Bun.file(join(p.dir!, "prompt.md")).text();
        return {
          content: [
            {
              type: "text",
              text:
                "Grounded executive-summary prompt below. Write the summary per its rules, " +
                "then call sbperf(action:'narrate_import', dir, summary:<your markdown>).\n\n" +
                prompt,
            },
          ],
        };
      }
      // narrate_import
      if (!p.summary?.trim())
        return { content: [{ type: "text", text: "error: summary markdown is required" }] };
      const { stderr } = await run(["narrate", p.dir!, "--import", "-"], p.summary);
      return {
        content: [
          {
            type: "text",
            text: `${stderr.trim()}\n> render: sbperf(action:'report', dir, narrative:true)`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `sbperf failed: ${err instanceof Error ? err.message : err}` },
        ],
      };
    }
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(sbperfTool);
}
