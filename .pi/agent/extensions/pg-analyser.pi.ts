/**
 * pg-analyser pi extension - drive the pg-analyser CLI from pi as a single tool.
 *
 * This repo file is the source of truth; sync it into your pi env after edits:
 *   cp ~/work/pg-analyser/extensions/pg-analyser.pi.ts ~/.pi/agent/extensions/pg-analyser.pi.ts
 *   # (or symlink it). Restart pi. The `pg-analyser` tool then appears.
 *
 * The validation, argv-building, binary resolution and the copy-paste narrate
 * round-trip now live in ./lib/pg-analyser-core.ts (shared with the Claude Code
 * MCP toolkit); this file is the thin pi adapter. Binary resolution (first that
 * works): $PG_ANALYSER_BIN -> `pg-analyser` on PATH -> `bun run
 * $PG_ANALYSER_REPO/src/index.ts`.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPgAnalyser, type PgAction, type PgParams } from "./lib/pg-analyser-core.ts";

const pgAnalyserTool = defineTool({
  name: "pg-analyser",
  label: "pg-analyser",
  description:
    "Run the pg-analyser Postgres performance analyzer (pg-analyser, formerly sbperf). Actions: analyze/full (collect + render a project - PAT, or no-PAT via db_url/profile), snapshot (append to the trend history store), report/pdf/summary (re-render a dir), import_trends/export_prometheus/scrape_init (trend plumbing), narrate_prompt (get the grounded executive-summary prompt so YOU can write it in-session), narrate_import (embed a summary you wrote back). Then report with narrative=true. bench (pgbench with methodology guardrails against one db_url -> run history), bench_list/bench_show/bench_compare (read the stored runs; compare shows the perf delta + pg_settings diff).",
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("analyze"),
        Type.Literal("bench"),
        Type.Literal("bench_list"),
        Type.Literal("bench_show"),
        Type.Literal("bench_compare"),
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
          "full: path to a --profile JSON (forces no-PAT + region-mapped Grafana + target DBs -> per-DB sweep).",
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
          "History SQLite file (snapshot/export_prometheus; default ~/.pg-analyser/history.db).",
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
    scripts: Type.Optional(
      Type.Array(Type.String(), {
        description: "bench: custom pgbench script file(s) (-f). Omit for the builtin.",
      }),
    ),
    builtin: Type.Optional(
      Type.String({ description: "bench: builtin script: tpcb-like|simple-update|select-only" }),
    ),
    scale: Type.Optional(Type.Number({ description: "bench: scale factor (default 1)" })),
    init: Type.Optional(
      Type.Boolean({
        description: "bench: run pgbench -i first (DROPS pgbench_* tables; needs yes:true)",
      }),
    ),
    clients: Type.Optional(Type.Number({ description: "bench: connections (default 4)" })),
    threads: Type.Optional(
      Type.Number({ description: "bench: worker threads (default min(cores, clients))" }),
    ),
    timeS: Type.Optional(Type.Number({ description: "bench: seconds per run (default 60)" })),
    warmup: Type.Optional(Type.Number({ description: "bench: warmup seconds (default 10)" })),
    runs: Type.Optional(Type.Number({ description: "bench: measured repetitions (default 3)" })),
    protocol: Type.Optional(
      Type.String({ description: "bench: simple|extended|prepared (default extended)" }),
    ),
    rate: Type.Optional(
      Type.Number({ description: "bench: target TPS instead of max speed (pgbench -R)" }),
    ),
    resetStats: Type.Optional(
      Type.Boolean({ description: "bench: pg_stat_statements_reset() first (superuser)" }),
    ),
    name: Type.Optional(Type.String({ description: "bench: label stored with the run" })),
    yes: Type.Optional(
      Type.Boolean({ description: "bench: skip confirmations (init drop warning, busy client)" }),
    ),
    showId: Type.Optional(Type.Number({ description: "bench_show: stored run id" })),
    compareIds: Type.Optional(
      Type.Array(Type.Number(), { description: "bench_compare: [idA, idB]" }),
    ),
  }),

  async execute(_id, p) {
    const { action, ...rest } = p;
    const { text, details, isError } = await runPgAnalyser(action as PgAction, rest as PgParams);
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(pgAnalyserTool);
}
