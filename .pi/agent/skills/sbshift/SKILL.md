---
name: sbshift
description: "Use when planning or running a near-zero-downtime Postgres-to-Postgres migration via logical replication (Supabase cross-region or tier change, self-hosted, Azure Flexible Server, project split), rehearsing a PG major upgrade with pg_upgrade, or a guided MySQL/SQL Server to Postgres move. Fires on 'sbshift', 'logical replication', 'database cutover', 'sequence resync', 'pg_upgrade rehearsal', 'move this Postgres with no downtime'. NOT for platform ops (supabase) or perf reports (pg-analyser)."
---

# sbshift - Postgres-to-Postgres logical-replication migrator

Typed CLI orchestrator for **near-zero-downtime PG-to-PG migration**, built for
the large-database case where a dump/restore window is unacceptable. The engine
(`bootstrap -> replicate -> watch -> reconcile -> cutover -> teardown`) is
**generic Postgres 15+**; when both ends are Supabase it also wraps the
`supabase` CLI + Management API for the non-replicated pieces (schema, storage,
functions, project config). Two further command groups ride on the same
reconcile engine: a **PG major-version upgrade rehearsal** (`upgrade`) and a
**guided heterogeneous path** (MySQL / SQL Server source via Debezium:
`translate`, `guide`, `kb`).

- **Repo:** `~/work/sbshift` - Bun runs `src/cli.ts` directly, no build step (`bun start <cmd>`).
- **Runbook:** `~/work/sbshift/docs/RUNBOOK.md` (per-phase, abort/rollback in section 12).
- **Design + gotchas:** `~/work/sbshift/README.md`; heterogeneous design in
  `docs/HETEROGENEOUS.md` and `docs/GUIDED-MIGRATION.md` (their status headers
  lag the CLI - the commands exist).
- **Current commands and flags:** `bun start --help` and `bun start <cmd> --help`
  are authoritative; this skill is the router, not the procedure.
- **Secrets:** loaded from `.env` (or `--env-file <path>`), AUTHORITATIVE over
  inherited shell vars - sbshift warns when it overrides a conflicting one, so
  a stale exported `SOURCE_DB_URL` cannot silently point a run at the wrong DB.
  `--no-env-file` uses the shell env as-is. Presence check without printing:
  `[ -n "${SOURCE_DB_URL+x}" ] && echo set`.

Read the README and RUNBOOK before a real migration.

## When to reach for it

| Want to ... | Reach for |
|---|---|
| Move a Supabase project to another region with low downtime | the full pipeline below |
| Migrate any PG15+ pair (self-hosted, tier change, project split) | the engine commands, skip the Supabase wrappers |
| Verify readiness before touching anything | `bun start doctor --source-only` |
| Prepare the target (extensions, roles, schema, optional auth rows) | `bootstrap` (preview) then `bootstrap --confirm` |
| Stand up replication + watch the initial copy | `replicate` -> `watch` |
| Prove source == target byte-for-byte | `reconcile` (chunked checksum) |
| Flip over with sequence resync + lag drain | `cutover` (write-stop gate) |
| Run the whole thing non-interactively in CI/Lambda | `run --through <phase> --json` |
| Rehearse hands-on against a throwaway Supabase pair | `sandbox up --org <id>` -> drive -> `sandbox down` |
| One-shot health snapshot for a scheduled watcher | `status --json` / `--require-synced` |
| Copy Auth/Realtime/etc. project config (Supabase) | `config-sync --dry-run` then apply |
| Move Edge Functions / storage objects (Supabase) | `functions`, `storage <localDir>` (wrap the `supabase` CLI) |
| Rehearse a PG major upgrade on production-like data | `upgrade doctor -> upgrade capture -> upgrade lab -> upgrade verify` (alias `pgupgrade`) |
| Migrate from MySQL / SQL Server (or prep a managed-PG source) | `guide <target>` (rds-postgres, aurora-postgres, planetscale-postgres, neon, azure-postgres, mysql, sqlserver), `translate`, then the pipeline; `kb` maintains the provider hints |
| Manage the managed platform itself (projects, keys, RLS) | `supabase` skill |
| Find an IPv6-capable host to run replication from | `fly` skill (VM in target region) |

## The pipeline (decision tree)

```
doctor      readiness checklist (pooler-vs-direct, IPv6, wal_level, replica
            identity, subscribe grant, schema loaded, extension diff, auth.users
            FK trap, custom pg_db_role_setting GUC overrides config-sync can't
            carry). --source-only when target not created yet. Fail-closed.
  |
bootstrap   prepare the TARGET: enable extensions + restore roles + schema
            dumped from source (into --out-dir, default ledger/). Preview by
            default; --confirm mutates. A Supabase source skips auth/storage/
            etc. (already on the target) unless --all-schemas. --with-auth-data
            also dumps+restores auth-schema ROW data with FK triggers deferred
            (the auth.users FK pre-step).
  |
preflight   read-only gate: versions, wal_level=logical, CREATE SUBSCRIPTION
            grant, every published table has a replica identity. Fails closed.
  |
replicate   empty publication + ADD TABLE (never FOR ALL TABLES - needs
            superuser) + slot + subscription (copy_data=true -> consistent
            initial copy). Re-run issues ALTER SUBSCRIPTION ... REFRESH PUBLICATION
            to pick up a newly-added table.
  |
watch       polls pg_subscription_rel until all tables srsubstate='r'; aborts on
            WAL-bloat > watchdog.maxRetainedWalMb, slot wal_status='lost'
            (unrecoverable), or rising apply/sync error counts / no running
            worker. Tolerates <= 5 consecutive transient poll errors. Live %.
  |
reconcile   chunked checksum (256 buckets default): one scan/side, bucket by PK
            hash, drill only mismatched buckets -> names missing_on_target /
            extra_on_target / hash_diff rows. Authoritative AFTER cutover (lag=0).
            Generated columns excluded from the hash.
  |
cutover     STOP source app writes first. Samples WAL LSN twice + counts
            write-shaped backends -> warns loudly if WAL still advancing. Drains
            lag to 0, setval()s every sequence OWNED BY a replicated column on
            the target (serial + IDENTITY; no-op for uuid PKs), drops subscription.
  |
teardown    disable -> SET (slot_name = NONE) -> drop subscription -> drop slot ->
            drop publication (this order, or it hangs).
```

Supabase-only commands layered on top: `config-sync` (Management-API config
copy, **secrets stripped**), `functions` / `storage` (wrap the `supabase`
CLI), `verify`, `provision`, `claim` (below).

## High-value traps (the reason this skill exists)

**IPv6 / direct-vs-pooler - the #1 topology trap.**
Logical replication needs a **direct** connection (`db.<ref>.supabase.co:5432`);
the **pooler cannot stream WAL**. Supabase direct hosts are **IPv6-only** (unless
the IPv4 add-on is enabled). If sbshift runs from a non-IPv6 box: point
`SOURCE_DB_URL`/`TARGET_DB_URL` at the **IPv4 session pooler** (port 5432) for
admin/seed/reconcile, and set **`SOURCE_REPLICATION_URL`** to the source *direct*
host - the subscription's CONNECTION is dialed by the **target's walreceiver over
Supabase's internal network**, not from your box. `CREATE SUBSCRIPTION` itself
succeeds through the session pooler (doctor's warning there is conservative).
Verified live end-to-end from a non-IPv6 box against a real cross-region pair.
`doctor` classifies each URL and tells you which case you're in.

**What logical replication does NOT carry: roles, DDL, extensions, sequences
as DDL, the Supabase-managed `auth`/`storage` schemas.** Without them on the
target the initial copy is FK-rejected row by row. `bootstrap` restores
extensions, roles and schema (and, with `--with-auth-data`, the auth rows) -
run it in preview, read the ledger, then `--confirm`. For a non-Supabase source
the same shape by hand is: dump roles, dump schema, restore both with
`psql --single-transaction --variable ON_ERROR_STOP=1`, then restore any
cross-schema reference data under `SET session_replication_role = replica`
(`pg_dump`/`pg_dumpall` in place of `supabase db dump`). `doctor` diffs
extensions and lists the missing ones either way.

**The `auth.users` cross-schema FK trap.** `public.<table>.user_id -> auth.users`,
and `auth` is not replicated - its data must exist on the target before the copy.
`doctor` flags any such cross-schema FK; `bootstrap --with-auth-data` fills it.

**Sequences don't replicate -> post-cutover PK collision.** A serial/IDENTITY
sequence on the target stays at its post-schema-load value; the next insert
collides with a replicated row. `cutover` resyncs every owned sequence from the
(write-stopped) source. No-op for uuid/text PKs.

**Generated columns** (e.g. a STORED `tsvector`) are recomputed on the subscriber
and **excluded from the reconcile hash** (hashing them = false mismatch). They are
*not* free during copy - a heavy STORED gen-column is the CPU bottleneck
(~7x slower copy measured in a large-scale rehearsal). `watch` shows live copy %.

**Cross-region hash stability.** Row hashes render `row::text`, which depends on
`TimeZone`/`DateStyle`/`IntervalStyle`/`extra_float_digits`/`bytea_output`. Every
connection in both pools pins those GUCs identically + `statement_timeout=0`.

**Watchdog aborts that matter:** WAL retained > threshold (the #1 outage), slot
`wal_status='lost'` (permanently dead - throws immediately), stuck tablesync/apply
worker (rising error counts or null pid).

**Cutover safety + point-of-no-return.** `cutover` warns if source WAL is still
advancing (autovacuum can move it too - strong signal, not a hard stop; stop your
app's writes). **Never re-enable source writes after cutover** (split-brain).
Lossless rollback is free *before* you repoint the app (RUNBOOK 9e); after that,
rolling back loses every write the target took. RUNBOOK section 12 has the
per-phase tree + optional reverse-replication escape hatch.

**Supabase identity churn.** A new project = new JWT secret + API keys -> existing
user sessions invalidate and the app's `SUPABASE_URL` + publishable/secret keys
change. `config-sync` copies settings; secrets are stripped by default. Auth
integration creds (SMTP/OAuth/SMS/hooks) + Edge-Function secrets are opt-in
(`configSync.secrets` / `configSync.projectSecrets`); the JWT signing secret + API
keys are **never** copied (not on any synced endpoint). Optional opt-in sections:
`sslEnforcement`, `networkRestrictions`, `thirdPartyAuth` (external JWT
integrations) and `ssoProviders` (SAML - additive, needs SAML 2.0 on the target
plan); the last two are the auth sub-resources the `/config/auth` blob does NOT
carry. Org settings + members/roles are read-only in the API -> not migratable
(re-invite by hand). Always `config-sync --dry-run` first.

**"Invisible" custom Postgres config.** config-sync's `dbPostgres` only carries the
GUCs Supabase exposes on `/config/database/postgres`. `ALTER ROLE/DATABASE ... SET`
overrides (statement_timeout, auto_explain.*, pg_stat_statements.*, pgaudit.*, ...)
live in `pg_db_role_setting` and config-sync can't see them. `doctor` reads it on
both ends and warns about source overrides missing/differing on target;
compute-tuned ones (shared_buffers, work_mem, max_connections) are flagged
`[compute-tuned]` - review, don't blindly copy. Re-apply by hand (or via
`supabase postgres-config` for CLI-only system params).

**Sibling Management-API commands:** `verify` (post-migration advisor health gate;
`--fail-on error|warn|info`; fails closed if advisors unreachable), `provision
[--confirm]` (copy billable infra: compute size / PITR / IPv4 / disk / backup
schedule; preview-by-default, adds/upgrades to match source but never strips),
and `claim <org-slug> <token> [--confirm]` (move a project into another org via
claim token; preview-gates by default, warns on plan downgrade).

**Can't be migrated (no write path / by design):** JWT signing secret + API keys
(new project = new keys), org settings + members/roles + entitlements (read-only
API), custom domain / vanity subdomain (DNS-coupled), pgsodium root key
(decrypt-everything footgun), read replicas (no enumerate API - recreate
post-cutover), CLI-only system GUCs (`shared_buffers` via `supabase
postgres-config`).

**Wrong-tool condition:** a **paused** source (especially > 90 days, no longer
restorable via Studio) can't stream WAL - use Supabase's offline backup-download +
restore path instead. Not an in-flight hazard, a precondition.

## Upgrade rehearsal (PG major version)

`upgrade doctor` audits the source read-only (extensions, blockers, downtime
estimate); `upgrade capture` dumps roles + schema + data to a local dir;
`upgrade lab` times a real `pg_upgrade --link` N times in Docker on that
capture (or `--seed-gib` fixture data); `upgrade verify` proves the upgraded
cluster is data-identical with the same chunked-checksum reconcile
(`SOURCE_DB_URL` = pre-upgrade copy, `TARGET_DB_URL` = upgraded cluster). Use it
to put a measured number on the downtime window before the real upgrade.

## Using it for non-Supabase migrations

Engine is plain Postgres 15+ (the integration tier runs against vanilla `postgres:16`).
- **Use:** `doctor`, `bootstrap`, `preflight`, `replicate`, `watch`, `reconcile`, `cutover`, `teardown`, `status`, `run`.
- **Skip:** `config-sync` (no-ops without `SUPABASE_ACCESS_TOKEN`), `functions` (`functions.enabled: false`), `storage` (`storage.buckets: []`).
- `doctor`'s Supabase heuristics degrade to no-ops; the wal_level / replica-identity / version / grant / schema / extension checks still run.

**Azure Database for PostgreSQL (Flexible Server)** on PG15+ works as source or
target with no code change (the tool floor is PG15+ regardless of what Azure
offers). Azure gotchas (`doctor`/`preflight` warn where checkable): subscriber
`max_worker_processes >= 16` (low Azure default -> `out of background worker
slots`), `wal_level=logical` via portal server-param + restart, replication
role needs `ALTER ROLE x WITH REPLICATION` + `GRANT azure_pg_admin TO x`, Azure
auto-drops idle slots at >=95% storage (flips read-only), and pre-PG17 HA
failover doesn't preserve logical slots. **Not** Azure SQL Database/Managed
Instance - that is SQL Server (T-SQL): the heterogeneous path (`guide
sqlserver`), not this one.

## Config + secrets

- `migrate.config.yaml` - non-secret, commit-safe: source/target refs, `replication.{tables,slot,publication,subscription}` (generic names, set per env), `reconcile.tables`, `watchdog.{maxRetainedWalMb,pollIntervalSec,syncTimeoutMin}`. Example: `migrate.config.example.yaml`.
- `.env` - secrets only (gitignored): `SOURCE_DB_URL`, `TARGET_DB_URL`, optional `SOURCE_REPLICATION_URL` (the IPv6 split), `SUPABASE_ACCESS_TOKEN`. Example: `.env.example`. Handling rules: the `secret-handling` skill.

## Autonomous (CI / cron)

```bash
bun start run --through reconcile --json          # exit 0 iff preflight+replicate+watch+reconcile pass
bun start run --through cutover --confirm-writes-stopped   # cutover REFUSED without this assertion
bun start status --json
bun start status --require-synced                 # exits non-zero until ready (wait loop)
```
With `--json`, `run` emits NDJSON on stdout (`phase_start`/`phase_end`/`summary`),
human logs to stderr. The runner must reach the **direct** hosts (IPv6 / IPv4 add-on).

## Validation tiers

```bash
bun test                  # unit - pure logic, no DB, always on in CI (zod, SQL-injection guards, bucket-diff, conn-string, config-sync stripping)
bun run typecheck         # tsc --noEmit
bun run check             # biome format + lint
bun run check:api         # Management API endpoint drift vs the live spec
bun run verify:claims     # scripts/verify-claims.sh - re-checks the documented claims
bun run test:integration  # == `bun start rehearse integration`; docker PG pair on ONE compose network; real replication + fault injection
bun run test:scale        # docker, ROWS=N (default 1M); annoying 4-table schema, per-phase timing
bun run test:live <org>   # real throwaway Supabase pair, full pipeline + sequence-collision check, auto-deletes projects (costs money)
bun start sandbox up --org <id>   # hands-on: throwaway Supabase pair you drive yourself (sandbox status / sandbox down)
```

**Scale harness** (`test/scale.harness.ts`): annoying schema (STORED gen-column,
IDENTITY + composite + no-PK tables, inter-table FKs, GUC-sensitive types,
unicode/NULLs). Size with `ROWS` (validated to 10M / 8.6 GB). Three modes via env
flag, each exits non-zero if its gate does NOT fire (so they're CI assertions too):
`WRITE_LOAD=1` (concurrent INSERT/UPDATE/DELETE on documents + no-PK FULL-identity
churn on audit through the copy/stream; reconcile after cutover at lag=0 + ledger
inflight-loss check), `WATCHDOG_FIRE=1` (negative: freeze apply + bloat WAL ->
`watch` must abort on the watchdog), `WRITE_THROUGH_CUTOVER=1` (negative: write
through cutover -> `cutover` must fail "lag did not drain"). The two negatives are
the at-scale complement to the `rehearse chaos` faults. See RUNBOOK section 3.

**Live harness** (`test/live.harness.ts <org-id> [rows]`): needs
`SUPABASE_ACCESS_TOKEN` (sbp_...); creates cross-region src+tgt projects
(`SRC_REGION`/`TGT_REGION` env, default eu-central-1 -> eu-west-1), runs
doctor -> ... -> cutover, asserts the resynced sequence prevents an id collision,
then deletes both in a `finally`. Org id via
`curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/organizations`.

The integration tier deliberately uses a shared compose network (not two bare
`docker run`s) because `replicate` reuses one connection string for both its own
libpq connection and the subscription CONNECTION the *target* walreceiver dials -
`localhost` would resolve to the target itself. Service-DNS `source:5432` resolves
identically from runner and target.

## Layout

```
src/cli.ts            commander entry, one subcommand per step
src/config.ts         zod schema (YAML) + env secrets schema
src/db.ts             source/target pg clients; qi() identifier quoting; conn-string builder
src/mgmt.ts           Supabase Management API client
src/steps/            bootstrap doctor preflight replicate watch reconcile cutover teardown
                      status run config-sync claim provision verify sandbox translate
                      cli-wrappers checks
src/engine/           replication engine interface (native PG + the Debezium heterogeneous plane)
src/kb/               provider hints knowledge base behind `guide` / `kb`
src/upgrade/          `upgrade doctor|capture|lab|verify`
src/rehearsal/        schema.sql (sandbox/rehearse-run fixture) + seed.ts + writer.ts (write load + id ledger) + integration.ts (docker tier)
test/                 *.test.ts (unit) + integration.test.ts + scale/live harnesses + annoying-schema.ts
docs/RUNBOOK.md       the step-by-step runbook; section 9 cutover, section 12 rollback
docs/HETEROGENEOUS.md, docs/GUIDED-MIGRATION.md   heterogeneous + guided-migration design
```

## Siblings

- **`supabase`** - the managed platform sbshift wraps (auth, storage, config, RLS, the Management API).
- **`pg-analyser`** - performance report before and after a move (`diff` proves the change helped).
- **`fly`** - spin up an IPv6-capable VM in the target region to run replication from when your box has no IPv6.
- **`infrastructure-stack`** - broader self-hosted compose/topology context.
- **`software-architecture`** - sbshift follows the user's typed-step + fail-closed-gate Go/TS service pattern.
