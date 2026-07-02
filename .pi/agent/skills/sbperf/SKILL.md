---
name: sbperf
description: Drive the user's `sbperf` CLI - a PAT-only Supabase performance analyzer (Bun/TypeScript) that fetches advisors, read-only SQL diagnostics, config, and infra metrics for a project and renders a self-contained HTML + PDF report, with optional 30-day trends accumulated to SQLite. Use when auditing/optimizing a Supabase project's performance without a DB password, generating a perf report for a project (or every project in an org), reproducing `supabase inspect` findings via the Management API instead of a `--db-url`, wiring 30-day infra trends without standing up Prometheus/Grafana, or debugging the tool's zod-at-the-boundary / API-drift-check / metrics-allowlist internals. Sibling to `supabase`, `supabase-postgres-best-practices`, `pgshift`, `fly`. Repo `~/sbperf`; runs on Bun, no build step.
---

# sbperf - PAT-only Supabase performance analyzer

Generates a ranked performance-and-security report for a Supabase project using
**only a Personal Access Token** - no superuser `--db-url`, no manual Grafana
screenshots. It collects a **superset of the entire `supabase inspect` command
set** (advisors, read-only SQL diagnostics, config, infra metrics, RLS audit,
txid wraparound, edge-function stats) and renders a self-contained HTML report +
Chromium PDF + a non-technical C-suite summary.

- **Repo:** `~/sbperf` - Bun runs `src/index.ts` directly, no build step.
- **Run from the repo:** `cd ~/sbperf && bun run src/index.ts <cmd>`, or the
  compiled binary `./sbperf <cmd>` after `bun run build`.
- **Design + every gotcha:** `~/sbperf/AGENTS.md` and `~/sbperf/README.md`.
- **Perf query source of truth:** the `supabase-postgres-best-practices` skill.

The one thing it deliberately refuses: a DB password. Everything is the
Management API + the read-only SQL runner, so it can audit a project you only
have PAT access to. That trades a small upstream-tracking burden (covered by the
CI API-drift check) for password-free operation.

## When to reach for it

| Want to ... | Reach for |
|---|---|
| Full perf/security report for one project | `full --ref <ref>` (analyze + report + summary + pdf) |
| Just the data, no render | `analyze --ref <ref>` -> `analysis.json` |
| Re-render HTML from existing `analysis.json` | `report <dir>` |
| Non-technical summary for leadership | `summary <dir>` (or it's produced by `full`) |
| PDF of an existing report | `pdf <dir>` (needs Chromium on PATH) |
| Audit every project in the account/org | `full --all [--org <slug>]` -> `index.html` |
| Accumulate 30-day infra trends, no Prom/Grafana | `snapshot --ref <ref>` on a schedule (see below) |
| Trends from an existing Prometheus instead | `--prometheus <url>` (alternate source) |
| Stand up the (optional) scraper stack | `scrape-init --ref <ref>` |
| Reproduce `supabase inspect` without a password | any of the above - sbperf is PAT-only |
| Postgres tuning guidance behind the findings | `supabase-postgres-best-practices` skill |
| Manage the platform itself (projects, keys, RLS) | `supabase` skill |

## Commands

```
sbperf analyze  --ref <ref> [--out <dir>]   fetch all planes -> analysis.json
sbperf report   <dir> [--store <db>]        analysis.json -> report.html + summary.html
sbperf summary  <dir>                        -> summary.html (non-technical)
sbperf pdf      <dir>                        -> report.pdf + summary.pdf (needs Chromium)
sbperf full     --ref <ref>                  analyze + report + summary + pdf
sbperf full     --all [--org <slug>]         audit every project + index.html
sbperf snapshot --ref <ref> [--store <db>]   collect + append to the history store
sbperf scrape-init --ref <ref>               write the (alternate) Prometheus+Grafana stack
```

Repo scripts: `bun run check` (biome write), `bun run typecheck`, `bun test`,
`bun run check:api` (endpoints-still-exist drift check), `bun run build`.

## Auth

Set `SUPABASE_ACCESS_TOKEN` (a PAT), **or** run `supabase login` - sbperf reads
`~/.supabase/access-token` automatically when the env var is unset (resolution
order: env var first, then CLI token; prints a one-line notice when the CLI
token is used). The per-project `service_role` key for the metrics endpoint is
auto-fetched via the Management API per run and never written to disk.

## Architecture (bounded contexts)

```
config.ts      zod env -> Config (access token, source)
transport.ts   Transport interface + DirectTransport (auth + retry); the
               interface exists mainly so tests inject a fake
management.ts  typed, zod-parsed Management API wrapper
sql.ts         the perf query set (superset of `supabase inspect db`)
metrics.ts     Prometheus text parser + DISPLAY-only allowlist (curate())
collect.ts     orchestrate all planes -> validated Analysis; captures the
               COMPLETE metrics corpus (all ~321 families, no curation)
store.ts       SQLite history store (bun:sqlite) for the snapshot/trends path
trends.ts      pure computeTrends: gauges + counter-derived rates
report/render  Analysis -> self-contained HTML (utilitarian, print CSS)
report/pdf     HTML -> PDF via headless Chromium (--print-to-pdf)
scraper.ts     generate the alternate Prometheus+Grafana stack
index.ts       CLI
```

## 30-day trends: sbperf is its own collector

**No Supabase API returns 30 days of infra history** (verified 2026-07): the
metrics endpoint takes no time param (point-in-time scrape), and the analytics
endpoints cap ~24h (`interval=1day` -> 24 hourly buckets). Time series **must**
be accumulated going forward. sbperf does this itself - no Prometheus/Grafana.

```bash
# schedule this (hourly cron / systemd timer):
sbperf snapshot --ref <ref>
#   -> full collect, appends to ~/.sbperf/history.db (SQLite, keyed by ref),
#      prunes snapshots older than --retention-days (default 90; 0 = keep all)

# any report then draws trends from accumulated history:
sbperf report <dir>
```

- **Store**: single SQLite file at `~/.sbperf/history.db` (override `--store`),
  keyed by ref so one store holds every project. Retains the full `Analysis`
  JSON per snapshot **plus** denormalized `metric_samples`/`sql_scalars` for
  cheap trend queries; deletes cascade on prune.
- **Gauges** (load, free memory/disk, DB size, cache-hit) plot directly - one
  point per snapshot.
- **Counters** (`node_cpu_*`, `node_disk_*`, `node_network_*` `_total`) become
  CPU utilization %, disk IOPS, and throughput - **rates need >=2 snapshots**.
  All counter families are captured (see completeness note below), so any of
  them is trendable even if the current report doesn't chart it yet.
- **`--prometheus <url>` takes precedence** over the store when both exist
  (report only fills trends from the store if no scraper trends are baked in).

### Trend gotcha

Snapshots taken closer together than Supabase's node_exporter scrape interval
see **identical counter values** -> zero deltas -> 0 rates, and CPU utilization
is correctly *omitted* (can't divide 0/0) rather than spiking. This is expected;
hourly cron snapshots straddle real scrape intervals and produce real rates.
Don't "fix" a zero-rate trend by lowering the snapshot interval.

## Completeness: the corpus is the product

`collect` captures the **entire** metrics scrape - ~321 families / ~850 samples
on a real project (node_exporter + postgres_exporter + pgbouncer + supavisor +
gotrue + realtime + postgREST + db_sql + physical-replication lag). **Nothing is
dropped at collection.** `curate()` in `metrics.ts` is a DISPLAY-only filter used
solely by the HTML report's metrics table (shows ~70 key point-in-time metrics
and notes "of N captured"); the full corpus is in `analysis.json` and the SQLite
store. Never gate storage behind that allowlist. Design intent (2026-07):
collect the whole corpus now; analysis/report/PDF becomes an LLM pass over the
corpus later. The endpoint is essentially node_exporter + a postgres_exporter
with some Supabase extras - it makes the project's internal Grafana unnecessary.

## Verified upstream facts (Supabase, 2026-07)

- Advisors REST `/v1/projects/:ref/advisors/{performance,security}` returns
  `{ lints: [...] }` (richer than the CLI - includes INFO lints). The zod schema
  accepts `lints` **or** `results` but fails loud if neither is present.
- Read-only SQL: `POST /v1/projects/:ref/database/query/read-only` runs as
  `supabase_read_only_user`; reaches `extensions.pg_stat_statements`, `pg_statio`,
  catalogs. No DB password needed.
- Metrics endpoint is a point-in-time scrape target, not a TSDB - see the trends
  section for why 30-day history must be accumulated.
- Per-function stats: `GET .../analytics/endpoints/functions.combined-stats?
  interval=<15min|1hr|3hr|1day>&function_id=<id>` - needs the function `id`
  (not the slug); collect.ts aggregates the per-time-bucket rows per function.
- `supabase inspect report` requires a `--db-url`/`--linked` (a password) and
  emits raw CSV, no findings. sbperf is PAT-only + ranked findings and adds
  advisors, metrics, RLS audit, txid wraparound, and edge-function stats the CLI
  lacks. Parity was checked against the CLI's **actual query source**
  (`github.com/supabase/cli apps/cli-go/internal/inspect/*/*.sql`), not its help.

## Conventions & gotchas

- **Every external response has a zod schema in `schemas.ts`.** Never
  `.default([])` to paper over a shape mismatch - it silently masks upstream
  changes. Use `.refine()` to fail loud; `collect.ts`'s per-source `safe()`
  wrapper records the failure as a collection note without aborting the run.
- **API-drift check** (`scripts/check-api-drift.ts`, run in CI): PRIMARY layer
  pass/fails against the LIVE served spec (`api.supabase.com/api/v1-json`);
  CROSS-CHECK advisory-diffs the live spec against the version-controlled docs
  copy. When you add/rename a Management API call in `management.ts`, update the
  manifest in that script.
- **Metrics display-allowlist rot**: the metrics endpoint is NOT in the OpenAPI
  spec, so the drift check can't catch renamed exporter families (e.g.
  `pgbouncer_pools_cl_*` -> `_client_*`). This no longer affects *capture*
  (everything is stored regardless), only the HTML display slice.
  `test/metrics.test.ts` guards a representative slice - keep the `ALLOW` list in
  `metrics.ts` matched to a real scrape so the display table stays useful.
- **Generated reports contain live query text + a live scraper credential** -
  `reports/` and scraper dirs are gitignored. Don't commit them.
- **PDF** needs a system Chrome/Chromium on PATH (`chromium`, `google-chrome`,
  ...) or `SBPERF_CHROME=/path/to/chrome`. `analyze`/`report` need no browser.
- **Never run the compiled binary blindly** to "test" - prefer `bun test` /
  targeted `bun run src/index.ts`. Live runs hit real projects (read-only, but
  still real API calls); use a real `--ref` from `supabase projects list`.

## See also

- `~/sbperf/AGENTS.md` - authoritative conventions + verified-facts log.
- `supabase` skill - API/CLI/auth reference for the platform itself.
- `supabase-postgres-best-practices` skill - source of the perf queries.
- `pgshift` skill - the migration sibling; also a PAT + Management API tool.
- `design-utilitarian` skill - the report's visual ethos.
