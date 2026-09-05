---
name: pg-analyser
description: Use when auditing or optimizing a Postgres database's performance and producing an HTML/PDF report - Supabase projects via a Personal Access Token, or any Postgres via superuser connstring (no-PAT mode). Fires on 'pg-analyser', 'sbperf', 'database performance report', 'slow queries', 'advisors', 'fleet audit', 'reproduce supabase inspect', 'white-label a report', 'pgbench baseline'. NOT for the tuning rules themselves (supabase-postgres-best-practices) or platform ops (supabase).
---

# pg-analyser - Postgres performance analyzer (formerly sbperf)

Generates a ranked performance-and-security report for a Supabase project or
any Postgres. The **default path needs only a Personal Access Token** - no DB
password, no Grafana screenshots. It collects a superset of the `supabase
inspect` command set (advisors, read-only SQL diagnostics, config, infra
metrics, RLS audit, txid wraparound, edge-function stats) and renders one
self-contained HTML report + Chromium PDF. `summary` adds an optional
plain-language one-pager.

- **Repo:** `~/work/pg-analyser` - `cd ~/work/pg-analyser && bun run src/index.ts <cmd>`,
  or the compiled `./pg-analyser <cmd>` after `bun run build`.
- **Design, architecture, conventions, verified upstream facts:**
  `~/work/pg-analyser/AGENTS.md` (sections "Architecture (bounded contexts)",
  "Conventions", "Verified upstream facts"). This skill does not repeat them;
  read AGENTS.md before changing code or attributing a finding to the
  platform.
- **Rules behind the findings:** the `supabase-postgres-best-practices` skill.
- **Current flags:** `bun run src/index.ts --help` is authoritative; the
  tables below were checked against it but the help wins.

## Three ways to reach a database

1. **PAT read-only runner** (default): `SUPABASE_ACCESS_TOKEN`, or `supabase
   login` (the CLI token at `~/.supabase/access-token` is read when the env
   var is unset). Runs as `supabase_read_only_user`; no password.
2. **Superuser tier** (`--db-url` / `PG_ANALYSER_DB_URL`): full access, all
   schemas, `pg_stat_statements_reset()` windowing, non-Supabase DBs.
   Augments the PAT (API planes + metrics still use it). `--db-url` is
   repeatable; `--db-config <file>` (gitignored JSON `[{name?,ref?,dbUrl}]`)
   is the list form; env fallback is `PG_ANALYSER_DB_URL` plus numbered
   `PG_ANALYSER_DB_URL_2`, `_3`, ... The ref is derived from each connstring.
   The connstring is a secret and is never written to `analysis.json`.
3. **No-PAT mode**: no token resolvable (or `--no-pat` /
   `PG_ANALYSER_NO_PAT=1`) plus a superuser `--db-url`: Management-API planes
   are skipped with one summary note, advisors come from the vendored
   splinter lints, trends from Grafana if configured, and the report carries a
   banner naming what was not collected. This is the customer-audit path.
   `--all` still needs a PAT.

**Profile** (`--profile <file>.json`): one gitignored JSON for the whole
customer-audit config - `{ noPat, trendDays, grafana: { hostTemplate,
datasourceUid, matcher, regions: { <region>: { cookie, uid?, host? } } },
databases: [...] }`. Trends resolve per project by the region derived from
each connstring (each regional Grafana is a separate ALB, so a per-region
cookie). Profiles are **chainable**: `--profile a.json b.json` (or repeat the
flag) combines them into one index, each DB keeping its own mode, Grafana and
trend window. `"noPat": false` keeps the PAT planes alongside the profile's
Grafana + superuser SQL. `--amcheck` is honoured on profile sweeps.

**Branding + overlay** (presentation-only, gitignored, keep `.example`):
`--brand <file>` white-labels (precedence `--brand` > `PG_ANALYSER_BRAND` >
`./pg-analyser.brand.json` > default). `--overlay <file>` is a ref-keyed
review overlay - hide drill sections, append markdown notes at render time,
never touching `analysis.json` (precedence `--overlay` > `PG_ANALYSER_OVERLAY`
> `./pg-analyser.overlays/<ref>.json` > `~/.pg-analyser/overlays/<ref>.json`).

## When to reach for it

| Want to ... | Reach for |
|---|---|
| Full perf/security report for one project | `full --ref <ref>` (analyze + report + pdf) |
| Just the data, no render | `analyze --ref <ref>` -> `analysis.json` |
| Re-render HTML from existing `analysis.json` | `report <dir>` |
| Did a migration/index/tuning change help? | `diff <oldDir> <newDir>` or `diff --ref <ref>` (last 2 store snapshots) |
| Prove it under concurrency | `bench --db-url <c> -f q.sql --name before` -> change one GUC -> `--name after` -> `bench --compare <idA> <idB>` (perf delta + pg_settings diff). Guardrails: client-saturation check, warmup + N runs, exact p50/p95/p99. Guide: `~/work/pg-analyser/docs/pgbench.md` |
| Gate CI on findings | `check <dir> --fail-on high\|med\|low` (+ `--category`, `--new-since <baselineDir>`); exits 1 on breach |
| Plain-language one-pager | `summary <dir>` (standalone; not emitted by `full`/`report`/`pdf`) |
| Merge external CSV/JSON trend series | `import-trends <dir> <file...>` |
| PDF of an existing report | `pdf <dir>` (needs Chromium on PATH or `PG_ANALYSER_CHROME`) |
| Audit a subset of projects (PAT) | `full --ref a,b,c` / `full --ref-file refs.txt\|.csv` -> combined `index.html` |
| Audit every project in the account/org | `full --all [--org <slug>]` |
| Maximal-coverage fleet audit (PAT + superuser) | `full --all --db-config <json>` - projects whose ref matches a connstring are upgraded to the superuser SQL tier; add `--amcheck` |
| Data-integrity check | `--amcheck` (bt_index_check) or `--amcheck heap` (+ verify_heapam, heavy). Superuser + amcheck installed only; never CREATEs it. On Supabase only `supabase_admin` can `CREATE EXTENSION amcheck` |
| Audit a customer project with NO PAT | `--db-url <connstr> --no-pat` |
| Audit a fleet of customer DBs | `full --profile <file>.json [more.json]` |
| Accumulate infra trends, no Prom/Grafana | `snapshot --ref <ref>` on a schedule (below) |
| Trends from an existing Prometheus/Grafana | `--prometheus <url>` (+ `--prometheus-token`/`-cookie`/`-matcher`) |
| Trend query window | `--trend-days <n>` (default 30; `profile.trendDays` wins) |
| Contention/incident scan window | `--incident-scan-days <n>` (default 7, capped by retention) |
| Feed the corpus to Grafana retroactively | `export-prometheus <dir>` -> OpenMetrics -> promtool backfill |
| Stand up the optional scraper stack / alert rules | `scrape-init --ref <ref>` / `alerts-init [--ref <ref>] [--dir <d>]` |
| Analytics timeframe (API/function stats) | `--interval <15min..7day>` (max ~7d; nothing else is windowed) |
| Reproduce `supabase inspect` without a password | any of the above on the PAT runner |
| Tuning guidance behind a finding | `supabase-postgres-best-practices` skill |
| Manage the platform itself | `supabase` skill |

Repo scripts: `bun run check` (biome write), `bun run typecheck`, `bun test`,
drift checks `check:api` (Management API endpoints vs live spec),
`check:inspect` (CLI inspect SQL), `check:lints` (splinter lints vs
`src/lints.ts`), `check:alerts` (alert-rule pack), `check:schemas`,
`check:docurls` (doc links in findings), `check:pgversions`, and `bun run
test:live` (acceptance against a real project - costs API calls). `bun run
build` compiles the binary.

**Report shape**: verdict + executive summary (deterministic, or the LLM
narrative when run) -> resource snapshot (sparklines from the store) -> what's
looking good -> findings, each as *What's happening / Why it matters / What to
do (+ SQL) / How to verify* with a doc link -> evidence drill-down. Findings
are deterministic (`heuristics.ts` catalog + `lints.ts` per-lint fixes); the
LLM only writes summary prose and is forbidden from inventing.

**LLM routes** (all optional): auto (`PG_ANALYSER_LLM_BASE_URL` + `_MODEL`),
copy-paste (`narrate --print-prompt` -> any chat LLM -> `narrate --import`),
or skip. The pi tool wrapper is `extensions/pg-analyser.pi.ts` in the repo;
the live `~/.pi/agent/extensions/pg-analyser.pi.ts` symlink points at the
dotfiles copy `~/dotfiles/.pi/agent/extensions/pg-analyser.pi.ts`, not at the
repo - update the dotfiles copy when the repo one changes. Its
`narrate_prompt`/`narrate_import` actions make pi the LLM for the round-trip.

## Infra trends: pg-analyser is its own collector

No Supabase API returns multi-day infra history: the metrics endpoint is a
point-in-time scrape and the analytics endpoints cap at ~7 days. Time series
must be accumulated going forward; pg-analyser does this itself.

```bash
# schedule this (hourly cron / systemd timer):
pg-analyser snapshot --ref <ref>
#   -> full collect, appends to ~/.pg-analyser/history.db (SQLite, keyed by ref),
#      prunes snapshots older than --retention-days (default 90; 0 = keep all)
pg-analyser report <dir>      # draws trends from accumulated history
```

- Gauges plot directly; counters (`node_cpu_*`, `node_disk_*`,
  `node_network_*` `_total`) become rates and need >= 2 snapshots. The whole
  scrape (~321 families) is stored; `curate()` in `metrics.ts` is a
  display-only filter for the HTML table. Never gate storage behind it.
- `--prometheus <url>` takes precedence over the store when both exist.
- `export-prometheus <dir>` renders the store as OpenMetrics and prints the
  promtool backfill runbook for the `scrape-init` stack.
- **Trend gotcha**: snapshots closer together than the node_exporter scrape
  interval see identical counters -> zero rates, and CPU utilisation is
  correctly omitted rather than spiking. Hourly snapshots straddle real
  scrape intervals; do not "fix" a zero rate by lowering the interval.

## Conventions that bite

- **Every external response has a zod schema in `schemas.ts`.** Never
  `.default([])` over a shape mismatch; `.refine()` to fail loud. The
  per-source `safe()` wrapper in `collect.ts` records a failure as a
  collection note instead of aborting.
- **Generated reports contain live query text and a live scraper
  credential.** `reports/`, scraper dirs, `pg-analyser.profile.json`,
  `pg-analyser.databases.json` and the `sbperf.<ref>.profile.json` files in
  the repo root are gitignored (`git check-ignore -v` on one shows the
  `.gitignore` rule). Confirm with `check-ignore` before creating any new
  file that holds a ref, cookie or connstring - the remote is public.
- **Never run the compiled binary blindly to "test"**: `bun test` or a
  targeted `bun run src/index.ts`. Live runs hit real projects (read-only,
  but real API calls).
- **Rebuild before attributing a finding.** `~/.local/bin/pg-analyser` is
  whatever was last built; a report's footer and `meta.sbperfVersion` name the
  version that produced it. Compare with `package.json` and `git log
  v<that>..HEAD` first - a stale binary reports rules that main has already
  fixed. `bun run build` before re-running.
- **`check:pgversions` warns; `PG_ANALYSER_PGVER_UPDATE=1` only prints** the
  refreshed table. Apply it to `src/pgversions.ts` by hand and bump
  `PG_VERSIONS_AS_OF`. Postgres ships minors at least quarterly.

## Reviewing a report for overreach

Findings are deterministic, so a report never invents data - a bad finding is
a rule turning an ambiguous signal into a causal claim. Review in this order:

1. **Version first.** `meta.sbperfVersion` in `analysis.json` vs
   `package.json`, then `git log v<that>..HEAD`. Attribute stale-binary issues
   separately.
2. **Trace every disputed number.** Each title's numbers come from a row in
   `analysis.json` (`sql.*`) or a series in `trends[]`. A python one-liner
   over the JSON beats reading the HTML.
3. **Read the rule.** The inference lives in `src/findings.ts`; the prose in
   `src/heuristics.ts`. Ask: what other state produces this same signal?
   Known past overreaches: "counters were reset" from 0 live rows alone (an
   emptied queue table looks the same), "infinite recursion" from any
   self-referencing policy (only SELECT/ALL shapes, or write-only with a
   subquery-bearing SELECT policy, recurse), "footprint can't be explained"
   from total bytes (TOAST + ANN index explained it), "never vacuumed" inside
   a 10-day stats window.
4. **Settle Postgres semantics empirically, in-session.** `docker run -d
   postgres:17-alpine`, reproduce the exact shape, and read the docs page for
   the claim before encoding it; confident answers about RLS recursion,
   `reltuples` vs vacuum timestamps, and `pg_relation_size` vs
   `pg_table_size` have all been wrong. Tear the container down afterwards.
5. **Date the stats window.** pg_stat_statements age, checkpointer
   `stats_reset` and a null pg_stat_database reset marker agreeing = an
   unclean restart wiped everything then. Every counter-derived finding is
   "since then"; `statsWindowDays()` in findings.ts is the helper.
6. **Fix the rule, not the report.** Add the discriminating column to the SQL,
   gate on it, add a regression test with the real shape (anonymise customer
   object names), and record the measured fact in AGENTS.md "Verified
   upstream facts".

Customer identifiers (project refs, table and policy names, bucket names, node
addresses) live in `reports/` and the gitignored profiles and must not travel
into tests, docs or commit messages - the repo remote is public.

## See also

- `~/work/pg-analyser/AGENTS.md` - authoritative conventions + verified-facts log.
- `supabase` skill - API/CLI/auth reference for the platform itself.
- `supabase-postgres-best-practices` skill - the rules behind the findings.
- `sbshift` skill - the migration sibling; also a PAT + Management API tool.
- `design-utilitarian` skill - the report's visual ethos.
