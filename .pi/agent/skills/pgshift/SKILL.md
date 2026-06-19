---
name: pgshift
description: Drive the user's `pgshift` CLI — a typed Bun/TypeScript orchestrator for near-zero-downtime Postgres→Postgres migration via native logical replication (publication+slot+subscription → watch → reconcile → cutover → teardown). Use for cross-region Supabase moves, Supabase↔self-hosted, self-hosted↔self-hosted, same-region tier changes, or project splits — any PG15+→PG15+ pair where a dump/restore downtime window is unacceptable. Covers the IPv6 direct-vs-pooler trap (`SOURCE_DB_URL` pooler + `SOURCE_REPLICATION_URL` direct host the target's walreceiver dials), what logical replication silently does NOT carry (DDL, roles, extensions, sequences, the Supabase `auth`/`storage` schemas) plus the do-this-FIRST dump/restore pre-step, the `auth.users` cross-schema FK trap, post-cutover sequence-resync collision guard, WAL-bloat/slot-lost/stuck-worker watchdog aborts, the cutover write-stop quiesce gate, chunked checksum reconciliation, the autonomous `run`/`status` CI entry points, and the validation tiers (unit / docker PG pair / scale / live throwaway Supabase pair). Sibling to `supabase`, `fly` (IPv6-capable host to replicate from), and `infrastructure-stack`. Repo at `~/pgshift`; runbook `docs/RUNBOOK.md`, rationale `README.md`. Validated at 10M rows / 8.6 GB locally and end-to-end against a real cross-region Supabase pair.
---

# pgshift — Postgres→Postgres logical-replication migrator

Typed CLI orchestrator for **near-zero-downtime PG→PG migration** built for the
large-database case where a plain dump/restore window is unacceptable. The engine
(`replicate → watch → reconcile → cutover → teardown`) is **generic Postgres**;
when both ends are Supabase it *also* wraps the `supabase` CLI + Management API
for the non-replicated pieces (schema, storage, functions, project config).

It owns the one piece nothing else automates: the **data-replication state
machine + reconciliation + WAL watchdog**.

- **Repo:** `~/pgshift` — Bun runs `src/cli.ts` directly, no build step (`bun start <cmd>`).
- **Full runbook:** `~/pgshift/docs/RUNBOOK.md` (per-phase, with abort/rollback §12).
- **Design + every gotcha:** `~/pgshift/README.md`.
- **Run from the repo:** `cd ~/pgshift && bun start <subcommand>`.

Read the README and RUNBOOK before a real migration — this skill is the router,
not the full procedure.

## When to reach for it

| Want to … | Reach for |
|---|---|
| Move a Supabase project to another region with low downtime | the full pipeline (this skill) |
| Migrate any PG15+ → PG15+ pair (self-hosted, tier change, project split) | the engine commands, skip Supabase wrappers |
| Verify readiness before touching anything | `bun start doctor --source-only` |
| Stand up replication + watch the initial copy | `replicate` → `watch` |
| Prove source == target byte-for-byte | `reconcile` (chunked checksum) |
| Flip over with sequence resync + lag drain | `cutover` (write-stop gate) |
| Run the whole thing non-interactively in CI/Lambda | `run --through <phase> --json` |
| One-shot health snapshot for a scheduled watcher | `status --json` / `--require-synced` |
| Copy Auth/Realtime/etc. project config (Supabase) | `config-sync --dry-run` then apply |
| Manage the managed platform itself (projects, keys, RLS) | `supabase` skill |
| Find an IPv6-capable host to run replication from | `fly` skill (VM in target region) |

## The pipeline (decision tree)

```
doctor      readiness checklist (pooler-vs-direct, IPv6, wal_level, replica
            identity, subscribe grant, schema loaded, extension diff, auth.users
            FK trap). --source-only when target not created yet. Fail-closed.
  ↓
[ pre-step, NOT automated — do this FIRST, see below ]
  ↓
preflight   read-only gate: versions, wal_level=logical, CREATE SUBSCRIPTION
            grant, every published table has a replica identity. Fails closed.
  ↓
replicate   empty publication + ADD TABLE (never FOR ALL TABLES — needs
            superuser) + slot + subscription (copy_data=true → consistent
            initial copy). Re-run issues ALTER SUBSCRIPTION … REFRESH PUBLICATION
            to pick up a newly-added table.
  ↓
watch       polls pg_subscription_rel until all tables srsubstate='r'; aborts on
            WAL-bloat > watchdog.maxRetainedWalMb, slot wal_status='lost'
            (unrecoverable), or rising apply/sync error counts / no running
            worker. Tolerates ≤5 consecutive transient poll errors. Shows live %.
  ↓
reconcile   chunked checksum (256 buckets default): one scan/side, bucket by PK
            hash, drill only mismatched buckets → names missing_on_target /
            extra_on_target / hash_diff rows. Authoritative AFTER cutover (lag=0).
            Generated columns excluded from the hash.
  ↓
cutover     ⚠ STOP source app writes first. Samples WAL LSN twice + counts
            write-shaped backends → warns loudly if WAL still advancing. Drains
            lag to 0, setval()s every sequence OWNED BY a replicated column on
            the target (serial + IDENTITY; no-op for uuid PKs), drops subscription.
  ↓
teardown    disable → SET (slot_name = NONE) → drop subscription → drop slot →
            drop publication (this order, or it hangs).
```

Supabase-only commands layered on top: `config-sync` (Management-API config copy,
**secrets stripped**), `functions` / `storage` (wrap the `supabase` CLI).

## High-value traps (the reason this skill exists)

**IPv6 / direct-vs-pooler — the #1 topology trap.**
Logical replication needs a **direct** connection (`db.<ref>.supabase.co:5432`);
the **pooler cannot stream WAL**. Supabase direct hosts are **IPv6-only** (unless
the IPv4 add-on is enabled). If pgshift runs from a non-IPv6 box: point
`SOURCE_DB_URL`/`TARGET_DB_URL` at the **IPv4 session pooler** (port 5432) for
admin/seed/reconcile, and set **`SOURCE_REPLICATION_URL`** to the source *direct*
host — the subscription's CONNECTION is dialed by the **target's walreceiver over
Supabase's internal network**, not from your box. `CREATE SUBSCRIPTION` itself
succeeds through the session pooler (doctor's warning there is conservative).
*Verified live end-to-end from a non-IPv6 box against a real cross-region pair.*
`doctor` classifies each URL and tells you which case you're in.

**What logical replication does NOT carry → do this FIRST.**
It moves row data for the listed tables and *nothing else*: no DDL, roles,
sequences-as-DDL, extensions, or the Supabase-managed `auth`/`storage` schemas.
Restore those onto the target **before** `replicate` or the initial copy is
FK-rejected row-by-row. Supabase path:
```bash
supabase db dump --db-url "$SOURCE_DB_URL" -f roles.sql  --role-only
supabase db dump --db-url "$SOURCE_DB_URL" -f schema.sql
supabase db dump --db-url "$SOURCE_DB_URL" -f auth.sql --data-only --schema auth
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file auth.sql --dbname "$TARGET_DB_URL"
```
Plus enable non-default extensions on the target first (`doctor` diffs and lists
the missing ones). Non-Supabase: use ordinary `pg_dump`/`pg_dumpall` instead.

**The `auth.users` cross-schema FK trap.** `public.<table>.user_id → auth.users`,
and `auth` is not replicated — its data must exist on the target before the copy.
`doctor` flags any such cross-schema FK.

**Sequences don't replicate → post-cutover PK collision.** A serial/IDENTITY
sequence on the target stays at its post-schema-load value; the next insert
collides with a replicated row. `cutover` resyncs every owned sequence from the
(write-stopped) source. No-op for uuid/text PKs.

**Generated columns** (e.g. a STORED `tsvector`) are recomputed on the subscriber
and **excluded from the reconcile hash** (hashing them = false mismatch). They are
*not* free during copy — a heavy STORED gen-column is the CPU bottleneck
(~7× slower copy measured in a large-scale rehearsal). `watch` shows live copy %.

**Cross-region hash stability.** Row hashes render `row::text`, which depends on
`TimeZone`/`DateStyle`/`IntervalStyle`/`extra_float_digits`/`bytea_output`. Every
connection in both pools pins those GUCs identically + `statement_timeout=0`.

**Watchdog aborts that matter:** WAL retained > threshold (the #1 outage), slot
`wal_status='lost'` (permanently dead — throws immediately), stuck tablesync/apply
worker (rising error counts or null pid).

**Cutover safety + point-of-no-return.** `cutover` warns if source WAL is still
advancing (autovacuum can move it too — strong signal, not a hard stop; stop your
app's writes). **Never re-enable source writes after cutover** (split-brain).
Lossless rollback is free *before* you repoint the app (RUNBOOK §9e); after that,
rolling back loses every write the target took. RUNBOOK §12 has the per-phase tree
+ optional reverse-replication escape hatch.

**Supabase identity churn.** A new project = new JWT secret + API keys → existing
user sessions invalidate and the app's `SUPABASE_URL` + anon/service keys change.
`config-sync` copies settings but **never secrets** — re-enter SMTP/OAuth/JWT by
hand. Always `config-sync --dry-run` first.

**Wrong-tool condition:** a **paused** source (especially > 90 days, no longer
restorable via Studio) can't stream WAL — use Supabase's offline backup-download +
restore path instead. Not an in-flight hazard, a precondition.

## Using it for non-Supabase migrations

Engine is plain Postgres (the integration tier runs against vanilla `postgres:16`).
- **Use:** `doctor`, `preflight`, `replicate`, `watch`, `reconcile`, `cutover`, `teardown`, `status`, `run`.
- **Skip:** `config-sync` (no-ops without `SUPABASE_ACCESS_TOKEN`), `functions` (`functions.enabled: false`), `storage` (`storage.buckets: []`).
- Use `pg_dump`/`pg_dumpall` for the roles/schema/extension pre-steps instead of the `supabase db dump` snippets.
- `doctor`'s Supabase heuristics degrade to no-ops; the wal_level / replica-identity / version / grant / schema / extension checks still run.

## Config + secrets

- `migrate.config.yaml` — non-secret, commit-safe: source/target refs, `replication.{tables,slot,publication,subscription}` (generic names, set per env), `reconcile.tables`, `watchdog.{maxRetainedWalMb,pollIntervalSec,syncTimeoutMin}`. Example: `migrate.config.example.yaml`.
- `.env` — secrets only (gitignored): `SOURCE_DB_URL`, `TARGET_DB_URL`, optional `SOURCE_REPLICATION_URL` (the IPv6 split), `SUPABASE_ACCESS_TOKEN`. Example: `.env.example`.

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
bun test                  # unit — pure logic, no DB, always on in CI (zod, SQL-injection guards, bucket-diff, conn-string, config-sync stripping)
bun run typecheck         # tsc --noEmit
bun run check             # biome format + lint
bun run test:integration  # docker PG pair on ONE compose network; real replication + fault injection
bun run test:scale        # docker, ROWS=N (default 1M); annoying 4-table schema, per-phase timing
bun run test:live <org>   # real throwaway Supabase pair, full pipeline + sequence-collision check, auto-deletes projects (costs money)
```

**Scale harness** (`test/scale.harness.ts`): annoying schema (STORED gen-column,
IDENTITY + composite + no-PK tables, inter-table FKs, GUC-sensitive types,
unicode/NULLs). Override `ROWS` (validated to 10M / 8.6 GB) and `PAYLOAD_CHARS`.

**Live harness** (`test/live.harness.ts <org-id> [rows]`): needs
`SUPABASE_ACCESS_TOKEN` (sbp_…); creates cross-region src+tgt projects
(`SRC_REGION`/`TGT_REGION` env, default eu-central-1 → eu-west-1), runs
doctor→…→cutover, asserts the resynced sequence prevents an id collision, then
deletes both in a `finally`. Org id via
`curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/organizations`.

The integration tier deliberately uses a shared compose network (not two bare
`docker run`s) because `replicate` reuses one connection string for both its own
libpq connection and the subscription CONNECTION the *target* walreceiver dials —
`localhost` would resolve to the target itself. Service-DNS `source:5432` resolves
identically from runner and target.

## Layout

```
src/cli.ts            commander entry, one subcommand per step
src/config.ts         zod schema (YAML) + env secrets schema
src/db.ts             source/target pg clients; qi() identifier quoting; conn-string builder
src/mgmt.ts           Supabase Management API client
src/steps/            doctor preflight replicate watch reconcile cutover teardown status run config-sync cli-wrappers checks
src/rehearsal/        seed.ts (size-targeted seeding) + writer.ts (continuous write load + id ledger)
test/                 *.test.ts (unit) + integration.test.ts + scale/live harnesses + annoying-schema.ts
docs/RUNBOOK.md       the step-by-step runbook; §9 cutover, §12 rollback
```

## Siblings

- **`supabase`** — the managed platform pgshift wraps (auth, storage, config, RLS, the Management API).
- **`fly`** — spin up an IPv6-capable VM in the target region to run replication from when your box has no IPv6.
- **`infrastructure-stack`** — broader self-hosted compose/topology context.
- **`software-architecture`** — pgshift follows the user's typed-step + fail-closed-gate Go/TS service pattern.
