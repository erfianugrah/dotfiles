---
name: sbperf
description: Drive the user's `sbperf` CLI - a Supabase performance analyzer (Bun/TypeScript) that fetches advisors, SQL diagnostics, config, and infra metrics for a project and renders a self-contained HTML + PDF report, with optional configurable-window trends accumulated to SQLite or pulled from Grafana. PAT-first (audit a project with only a Personal Access Token, no DB password) but ALSO has a no-PAT customer-audit mode (superuser --db-url + self-hosted splinter advisors + Grafana trends, driven by a single --profile JSON). Use when auditing/optimizing a Supabase project's performance, generating a perf report for a project (or every project in an org, or a fleet of customer databases), reproducing `supabase inspect` findings via the Management API OR a superuser connstring, wiring infra trends without standing up Prometheus/Grafana, white-labeling (--brand) or review-annotating (--overlay) a report, or debugging the tool's zod-at-the-boundary / API-drift-check / metrics-allowlist internals. Sibling to `supabase`, `supabase-postgres-best-practices`, `sbshift`, `fly`. Repo `~/sbperf`; runs on Bun, no build step.
---

# sbperf - Supabase performance analyzer (PAT-first, no-PAT capable)

Generates a ranked performance-and-security report for a Supabase project. The
**default path needs only a Personal Access Token** - no DB password, no manual
Grafana screenshots. It collects a **superset of the entire `supabase inspect`
command set** (advisors, read-only SQL diagnostics, config, infra metrics, RLS
audit, txid wraparound, edge-function stats) and renders one self-contained HTML
report + Chromium PDF (a technical + business audit pyramid). An optional
standalone plain-language one-pager is available via the `summary` command.

There is also a **no-PAT customer-audit mode** (see below): given a superuser
`--db-url` (and no resolvable PAT), sbperf runs transport-free - SQL diagnostics
direct over the connstring, advisors from the self-hosted splinter lints, trends
from Grafana - so you can audit a customer project you only have a connstring
for. A single `--profile <file>.json` bundles that whole config.

- **Repo:** `~/sbperf` - Bun runs `src/index.ts` directly, no build step.
- **Run from the repo:** `cd ~/sbperf && bun run src/index.ts <cmd>`, or the
  compiled binary `./sbperf <cmd>` after `bun run build`.
- **Design + every gotcha:** `~/sbperf/AGENTS.md` and `~/sbperf/README.md`.
- **Perf query source of truth:** the `supabase-postgres-best-practices` skill.

Two SQL tiers behind one interface (`sqlrunner.ts`): the **PAT read-only runner**
(`supabase_read_only_user`, default - audits a customer project with no password,
just a PAT) and an opt-in **superuser tier** via `--db-url`/`SBPERF_DB_URL`
(`DirectSqlRunner` over `Bun.SQL`) for your own projects or any Postgres - full
access, all schemas, multiple/non-Supabase DBs, and `pg_stat_statements_reset()`
windowing. `--db-url` augments the PAT (API planes + metrics still use the PAT);
the connstring is a secret and is never written to `analysis.json` (only
`meta.sqlSource`). PAT-only stays the default so password-free audit still works.

**Multiple DBs** (`dbtargets.ts`): `--db-url` is repeatable and there's a
gitignored `--db-config <file>` (JSON `[{name?,ref?,dbUrl}]`). The Supabase ref
is auto-derived from each connstring (pooler `role.ref` username or
`db.<ref>.supabase.co` host), so a bare list needs no `--ref`. `full` sweeps
targets into per-DB report dirs + an `index.html`; `snapshot` records each into
the store. Env `SBPERF_DB_URL` is the single-DB fallback (ignored when --db-url/
--db-config are given). Per-DB failures degrade gracefully (SQL notes) rather
than aborting the sweep.

**No-PAT mode** (`collect(ref, null, ...)`): with NO PAT resolvable but a
superuser `--db-url` (or `SBPERF_DB_URL` / `sbperf.databases.json`), sbperf runs
transport-free - every Management-API plane is skipped (returns its fallback +
one summary note, not per-plane 401 spam), advisors come from the vendored
splinter lints (BOTH performance and security), SQL from the `--db-url`, trends
from Grafana if configured. `meta.managementApi=false` drives a report banner
stating what was NOT collected (provisioning/backups/pooler/metrics/analytics).
This is the **customer-audit path**: a connstring + optional Grafana cookie, no
PAT. Force it with `--no-pat` / `SBPERF_NO_PAT=1` even when a token exists.
`--all` still needs a PAT (it enumerates projects via the API).

**Profile** (`--profile <file>.json`, `profile.ts`): the whole customer-audit
config in ONE gitignored JSON - `{ noPat, trendDays, grafana: { hostTemplate,
datasourceUid, matcher, regions: { <region>: { cookie, uid?, host? } } },
databases: [...] }`. `full --profile <f>` forces no-PAT, makes `databases[]` the
sweep targets, and resolves trends **per project**: the region is derived from
each connstring, mapped to that region's Grafana host/uid/cookie (each regional
Grafana is a separate ALB, so a per-region session cookie). A region absent from
the map -> that project's trends are skipped (SQL/advisors still run). Nothing
internal is baked into the repo - hosts, UIDs, cookies, connstrings all live in
the gitignored profile (`sbperf.profile.json`; keep `.example`).

**Branding + overlay** (presentation-only, both gitignored, keep `.example`):
`--brand <file>` white-labels the report (logo, favicon, accent/link colours;
precedence `--brand` > `SBPERF_BRAND` > `./sbperf.brand.json` > Supabase
default). `--overlay <file>` is a ref-keyed **review overlay** - hide drill
sections + append markdown notes at render time via the `drill()` choke-point,
never touching `analysis.json` (precedence `--overlay` > `SBPERF_OVERLAY` >
`./sbperf.overlays/<ref>.json` > `~/.sbperf/overlays/<ref>.json`).

## When to reach for it

| Want to ... | Reach for |
|---|---|
| Full perf/security report for one project | `full --ref <ref>` (analyze + report + pdf) |
| Just the data, no render | `analyze --ref <ref>` -> `analysis.json` |
| Re-render HTML from existing `analysis.json` | `report <dir>` |
| Optional plain-language one-pager | `summary <dir>` (standalone; NOT emitted by `full`/`report`/`pdf`) |
| Merge external CSV/JSON trend series | `import-trends <dir> <file...>` |
| PDF of an existing report | `pdf <dir>` (needs Chromium on PATH) |
| Audit a subset of projects (PAT-only) | `full --ref a,b,c` / `full --ref-file refs.txt\|.csv` -> combined org/project `index.html` (repeatable + comma/space lists + file; deduped) |
| Audit every project in the account/org | `full --all [--org <slug>]` -> `index.html` |
| Audit a customer project you have NO PAT for | `--db-url <connstr>` with `--no-pat` (SQL + splinter advisors + Grafana) |
| Audit a fleet of customer DBs (work) | `full --profile <file>.json` -> per-DB reports + index, per-region Grafana |
| Accumulate infra trends, no Prom/Grafana | `snapshot --ref <ref>` on a schedule (see below) |
| Trends from an existing Prometheus/Grafana | `--prometheus <url>` (+ `--prometheus-token`/`-cookie`/`-matcher` for auth'd datasources) |
| Pick the trend query window | `--trend-days <n>` (default 30; `profile.trendDays` wins) |
| White-label the report | `--brand <file>` (logo/favicon/colours) |
| Add review notes / hide sections per project | `--overlay <file>` (ref-keyed, presentation-only) |
| Feed the corpus to Grafana retroactively | `export-prometheus <dir>` -> OpenMetrics -> promtool backfill |
| Stand up the (optional) scraper stack | `scrape-init --ref <ref>` |
| Pick a timeframe for analytics (API/function stats) | `--interval <15min..7day>` (max ~7d; nothing else is windowed) |
| Reproduce `supabase inspect` without a password | any of the above - PAT read-only runner (default) |
| Full-access SQL on your own project / any PG | `--db-url <connstr>` or `SBPERF_DB_URL` (superuser tier) |
| Audit multiple superuser DBs in one run | repeatable `--db-url` or `--db-config <file>`; `full` -> per-DB reports + index |
| Postgres tuning guidance behind the findings | `supabase-postgres-best-practices` skill |
| Manage the platform itself (projects, keys, RLS) | `supabase` skill |

## Commands

```
sbperf analyze  --ref <ref> [--out <dir>]   fetch all planes -> analysis.json
sbperf report   <dir> [--store <db>]        analysis.json -> report.html (one combined doc)
sbperf summary  <dir>                        -> summary.html (optional plain-language one-pager)
sbperf pdf      <dir>                        -> report.pdf (needs Chromium)
sbperf narrate  <dir>                        executive summary via LLM (SBPERF_LLM_*)
sbperf narrate  <dir> --print-prompt         -> prompt.md to paste into any chat LLM
sbperf narrate  <dir> --import <file>|-      embed a pasted LLM reply back (no endpoint)
sbperf full     --ref <ref>                  analyze + report + pdf
sbperf full     --ref <r1>,<r2> ...          audit a subset -> combined index (repeatable;
                                             comma/space lists; snapshot loops, analyze rejects)
sbperf full     --ref-file <refs.txt|.csv>   subset refs from a file (ref-shaped tokens only)
sbperf full     --all [--org <slug>]         audit every project + index.html
sbperf full     --profile <file>.json        no-PAT work sweep (per-region Grafana + customer DBs)
sbperf full     --db-url <connstr> [--no-pat] superuser SQL tier (augments PAT, or sole source no-PAT)
sbperf snapshot --ref <ref> [--store <db>]   collect + append to the history store
sbperf import-trends <dir> <file...>         merge external CSV/JSON series into analysis.trends
sbperf export-prometheus <dir> [--ref <ref>] history store -> OpenMetrics for promtool backfill
sbperf scrape-init --ref <ref>               write the (alternate) Prometheus+Grafana stack
```

Repo scripts: `bun run check` (biome write), `bun run typecheck`, `bun test`,
`bun run check:api` (endpoints drift), `bun run check:inspect` (CLI inspect SQL
drift), `bun run check:lints` (splinter lints vs the src/lints.ts fix catalog),
`bun run build`.

**Report shape** (technical + business audit pyramid, one combined `report.html`
/ `report.pdf`): verdict + Executive summary (deterministic hedged synthesis,
or the LLM narrative when run) -> Resource snapshot (30-day sparklines from the
store) -> What's looking good -> Findings worth addressing, each as *What's
happening / Why it matters / What to do (+ copy-pasteable SQL) / How to verify*
with a doc link + Advisor deep-link -> Evidence drill-down. Findings are
deterministic (`heuristics.ts` catalog + `lints.ts` per-splinter-lint fixes);
the LLM only writes the summary prose and is forbidden from inventing.

**LLM routes** (all optional): auto (`SBPERF_LLM_BASE_URL` + `_MODEL`),
copy-paste (`narrate --print-prompt` -> paste into pi.dev/ChatGPT/Claude ->
`narrate --import`), or skip (deterministic summary). A pi tool wrapper lives at
`extensions/sbperf.pi.ts` (symlink into `~/.pi/agent/extensions/`) - its
`narrate_prompt`/`narrate_import` actions make pi itself the LLM for the
round-trip.

## Auth

Set `SUPABASE_ACCESS_TOKEN` (a PAT), **or** run `supabase login` - sbperf reads
`~/.supabase/access-token` automatically when the env var is unset (resolution
order: env var first, then CLI token; prints a one-line notice when the CLI
token is used). The per-project `service_role` key for the metrics endpoint is
auto-fetched via the Management API per run and never written to disk.

**No PAT at all?** Provide a superuser `--db-url` (or `SBPERF_DB_URL` /
`sbperf.databases.json` / a `--profile`) and sbperf runs transport-free - see
no-PAT mode above. `--no-pat` / `SBPERF_NO_PAT=1` forces it even when a token is
resolvable. `--all` is the one path that still requires a PAT.

## Architecture (bounded contexts)

```
config.ts      zod env -> Config (access token, source)
transport.ts   Transport interface + DirectTransport (auth + retry); null in
               no-PAT mode (every Management plane then skipped)
management.ts  typed, zod-parsed Management API wrapper
sqlrunner.ts   SQL tiers behind one interface: ManagementSqlRunner (PAT read-only,
               default) + DirectSqlRunner (superuser --db-url via Bun.SQL)
splinter.ts    self-hosted advisor: runs the vendored splinter.sql over --db-url
               (fallback in PAT mode for the 42601 bug; PRIMARY in no-PAT mode)
dbtargets.ts   multi-DB target parsing + ref/region-from-connstring derivation
profile.ts     --profile: force-no-PAT + region-mapped Grafana + customer DBs
sql.ts         the perf query set (superset of `supabase inspect db`)
rls.ts         isUnwrappedAuth: flags un-wrapped auth.* calls in RLS policies
metrics.ts     Prometheus text parser + DISPLAY-only allowlist (curate())
collect.ts     orchestrate all planes -> validated Analysis; captures the
               COMPLETE metrics corpus (all ~321 families, no curation)
heuristics.ts  evergreen THRESHOLDS + per-finding metadata (why/how/verify/sql)
lints.ts       per-splinter-lint fix catalog (concrete fix, not "go to Advisor")
findings.ts    deriveFindings/derivePositives: the deterministic ranking pass
               (incl. trend-driven capacity suggestions, data-aware)
trendstats.ts  trend primitives (slope/sustained/peak/projection) behind
               sufficient() gating so short series never over-claim
store.ts       SQLite history store (bun:sqlite) for the snapshot/trends path
trends.ts      pure computeTrends: gauges + counter-derived rates, read-time
               downsampling to ~300 pts/panel; --trend-days window, auto-scoped
prometheus.ts  optional trends from an auth'd Prometheus/Grafana datasource
promexport.ts  store -> OpenMetrics (timestamped) for `export-prometheus`;
               promtool backfills a Prometheus TSDB (retroactive Grafana)
narrate.ts     grounded LLM pass over corpus + findings -> narrative.md
brand.ts       report white-labeling (--brand); overlay.ts ref-keyed review overlay
report/render  Analysis -> self-contained HTML (utilitarian, print CSS)
report/pdf     HTML -> PDF via headless Chromium (--print-to-pdf)
scraper.ts     generate the alternate Prometheus+Grafana stack
sync.ts        on-by-default upstream sync check -> report footer
index.ts       CLI
```

## Infra trends: sbperf is its own collector

**No Supabase API returns multi-day infra history** (verified 2026-07): the
metrics endpoint takes no time param (point-in-time scrape), and the analytics
endpoints cap ~7d (`interval=1day` -> 24 hourly buckets). Time series **must**
be accumulated going forward. sbperf does this itself - no Prometheus/Grafana.
The trend query window is `--trend-days <n>` (default 30; `profile.trendDays`
wins for a profile run) and **auto-scopes** to a project's real data span, so a
young project charts its actual history instead of a mostly-empty 30 days.

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
- **Retroactive Grafana**: `export-prometheus <dir> [--ref <ref>]` renders the
  store as OpenMetrics with timestamps (all families TYPE=unknown to dodge OM
  suffix strictness). It prints the verified backfill runbook: `promtool tsdb
  create-blocks-from openmetrics` (two tokens) via the prom/prometheus image
  (`--entrypoint promtool`, `--user 65534` to write the volume) imports into the
  scrape-init stack; restart and Grafana queries history retroactively. Verified
  vs prom/prometheus:v3.1.0. SVG trends remain the zero-infra fallback.

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
- KNOWN BUG (2026-07): the hosted `advisors/performance` endpoint 400s with
  `42601 ... 'storage.buckets'` - splinter's multi-statement storage-buckets
  lint on the prepared-statement path (supabase/cli#4965; fixed in CLI, not the
  hosted endpoint). `advisors/security` still works. FALLBACK: with `--db-url`,
  sbperf runs the vendored `splinter.sql` itself over the simple-query protocol
  (`splinter.ts` + `DirectSqlRunner.runMulti`) and fills `advisors.performance`
  from it - so perf lints survive the hosted bug. Verified live: recovered 7
  unindexed-FK + 3 unused-index lints on a project the API returned 0 for.
- Read-only SQL: `POST /v1/projects/:ref/database/query/read-only` runs as
  `supabase_read_only_user`; reaches `extensions.pg_stat_statements`, `pg_statio`,
  catalogs. No DB password needed.
- Metrics endpoint is a point-in-time scrape target, not a TSDB - see the trends
  section for why 30-day history must be accumulated.
- Per-function stats: `GET .../analytics/endpoints/functions.combined-stats?
  interval=<window>&function_id=<id>` - needs the function `id` (not the slug);
  collect.ts aggregates the per-time-bucket rows per function.
- Timeframe is selectable ONLY for the analytics endpoints (API counts +
  function stats) via `--interval` - enum `15min|30min|1hr|3hr|1day|3day|7day`,
  max reach ~7 days (iso ranges are clamped by the API). Metrics are
  point-in-time; pg_stat_statements is cumulative-since-reset. Longer horizons
  need the snapshot history store.
- `supabase inspect report` requires a `--db-url`/`--linked` (a password) and
  emits raw CSV, no findings. sbperf runs password-free by default (PAT only)
  AND, given a `--db-url` in no-PAT mode, does everything inspect does plus
  ranked findings, splinter advisors, metrics, RLS audit, txid wraparound, and
  edge-function stats the CLI lacks. Parity was checked against the CLI's
  **actual query source**
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
- `sbshift` skill - the migration sibling; also a PAT + Management API tool.
- `design-utilitarian` skill - the report's visual ethos.
