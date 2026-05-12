---
name: supabase-postgres-best-practices
description: Postgres performance optimization and best practices from Supabase. Use this skill when writing, reviewing, or optimizing Postgres queries, schema designs, or database configurations.
license: MIT
metadata:
  author: supabase
  version: "1.3.0"
  organization: Supabase
  date: November 2026
  abstract: Postgres performance optimization guide. Rules across 8 categories prioritized by impact. Includes correct/incorrect SQL examples, query plan analysis, performance metrics, index-type selection matrix.
---

# Postgres Best Practices

Performance optimization guide for Postgres. Rules across 8 categories, prioritized by impact.

## When to Apply

- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing DB performance issues
- Configuring connection pooling/scaling
- Optimizing Postgres-specific features
- Working with RLS

## Rule Categories

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Query Performance | CRITICAL | `query-` |
| 2 | Connection Management | CRITICAL | `conn-` |
| 3 | Security & RLS | CRITICAL | `security-` |
| 4 | Schema Design | HIGH | `schema-` |
| 5 | Concurrency & Locking | MEDIUM-HIGH | `lock-` |
| 6 | Data Access Patterns | MEDIUM | `data-` |
| 7 | Monitoring & Diagnostics | LOW-MEDIUM | `monitor-` |
| 8 | Advanced Features | LOW | `advanced-` |

## Key Rules

### Query Performance (CRITICAL)
- Index FKs + columns in WHERE/JOIN/ORDER BY
- Partial indexes for filtered queries (`WHERE deleted_at IS NULL`)
- Covering indexes (`INCLUDE (col1, col2)`) enable `Index Only Scan` — skip the heap fetch entirely
- No `SELECT *` — select needed columns only. Extra cost when rows have large TOASTed columns (`jsonb`, big `text`) — TOAST fetch is a separate read.
- `EXPLAIN (ANALYZE, BUFFERS)` for slow queries. Big mismatch between estimated and actual rows → run `ANALYZE table_name;` to refresh planner stats.
- `auto_explain` extension + `auto_explain.log_min_duration = '500ms'` logs slow query plans automatically in production.
- `EXISTS` over `COUNT` for existence checks
- No fns on indexed columns in WHERE (prevents index use). Workaround: expression index, e.g. `CREATE INDEX ON users (lower(email));`
- **Cap string inputs that feed `tsvector` / GIN indexes.** Unbounded `text` columns indexed by GIN bloat the index quickly. Enforce limits at the app layer (Zod `.max(N)`) and/or with a CHECK constraint.

### Index type selection (pick the right access method)

| Pattern | Index type |
|---|---|
| `=`, `<`, `>`, `BETWEEN`, prefix `LIKE 'foo%'`, sort | **B-tree** (default) |
| `WHERE tags @> ARRAY['x']`, array containment/overlap | **GIN** |
| `WHERE doc @> '{"k":"v"}'::jsonb`, JSON path lookups | **GIN** (`jsonb_path_ops` op class) |
| `WHERE search @@ to_tsquery(...)` full-text search | **GIN** on the `tsvector` column |
| `WHERE name ILIKE '%mid%'`, fuzzy match | **GIN** with `pg_trgm` ops |
| `ORDER BY embedding <-> '[...]'::vector LIMIT k` | **HNSW** (pgvector) — beats ivfflat on recall + build time |
| Spatial / geometric / range types | **GiST** |
| Huge append-only time-series table | **BRIN** on the timestamp + range partitioning |
| Non-overlapping partitions (IPs, quadtree points) | **SP-GiST** |

A trailing `pg_trgm` GIN index makes `ILIKE '%foo%'` index-driven instead of seq-scanning.

### Connection Management (CRITICAL)
- Use connection pooling (PgBouncer/Supabase pooler) — no unbounded connections
- `pool_mode`: `transaction` for stateless APIs, `session` for prepared statements
- Keep connections short-lived; no holding across slow I/O
- Set `statement_timeout` + `lock_timeout`
- **Skip the pooler entirely for stateless Workers/Edge.** When the runtime is request-scoped and ephemeral (CF Workers, Vercel Functions), a persistent Postgres wire connection is wasted. Use the PostgREST REST API via supabase-js instead — eliminates the entire class of Supavisor/PgBouncer connection bugs (`prepare: false`, pipelining deadlocks, IPv4 add-on cost). Trade-off: no prepared statements, slightly higher per-query overhead.

### Security & RLS (CRITICAL)
- RLS on all tables in exposed schemas
- `auth.uid()` for user-scoped policies, `auth.jwt() -> 'app_metadata'` for role-based
- Never `raw_user_meta_data` for auth — user-editable
- Views bypass RLS by default — `security_invoker = true` (Postgres 15+)
- `security definer` fns → unexposed schemas only
- **Use `(SELECT auth.uid())` not bare `auth.uid()`** in RLS policy predicates. The subquery emits an `initPlan` so the value is computed once per statement instead of once per row. Supabase benchmarks: **94–99% latency improvement** at scale. Same pattern for `auth.role()`, `auth.jwt()`, etc.
- **`SECURITY DEFINER` functions** for complex join-based policies — the function bypasses RLS on the joined table, eliminating recursive RLS evaluation. Always pair with `SET search_path = ''` and `REVOKE EXECUTE FROM PUBLIC` + explicit `GRANT EXECUTE TO …`.
- **Minimize joins in RLS policies** — each joined table also evaluates its own RLS recursively. Push complex predicates into a `SECURITY DEFINER` function returning a SETOF or BOOLEAN.

### Schema Design (HIGH)
- Types: `uuid` for IDs, `timestamptz` over `timestamp`, `text` over `varchar(n)`
- Prefer `NOT NULL`
- `GENERATED ALWAYS AS IDENTITY` over `SERIAL` — the database owns the value; manual inserts rejected unless explicitly overridden. `SERIAL` lets app code corrupt the sequence by inserting an explicit ID.
- Normalize to 3NF unless denormalization justified by perf
- Check constraints for business rules at DB level
- **JSONB column with huge documents → TOAST.** Any row whose values exceed ~2 KB triggers compression + out-of-line storage in `pg_toast.pg_toast_<oid>`. Fine, but: (a) `SELECT *` on rows with TOASTed columns is more expensive than expected — name the columns you actually need; (b) GIN-indexed JSONB churn bloats both the TOAST table and the GIN index fast — cap row size with `CHECK (octet_length(doc) < 1_000_000)`; (c) when only a few JSON paths are queried, a partial / expression GIN on those paths is leaner than indexing the whole column.
- **`NOT NULL DEFAULT gen_random_uuid()`** for any secret-token column. Combine with an inverted app-side guard (`if (!storedToken || storedToken !== ownerToken)`) so a future schema drift can't be exploited as defense-in-depth.
- **Triggers should use `WHEN (OLD.col IS DISTINCT FROM NEW.col)`** for value-change detection, not `UPDATE OF col`. The latter fires on column presence in the SET clause, which means `upsert()` (which sends all columns) triggers on every read-count increment. `IS DISTINCT FROM` is NULL-safe (unlike `<>`) and only fires on actual value change.
- **Sequences don't reset on `DELETE`.** If you `DELETE FROM users` and re-insert, IDs continue from where they left off (next free `nextval`). Reset explicitly when needed: `ALTER SEQUENCE users_id_seq RESTART WITH 1;`. Almost never desired in production — old IDs may still be referenced in logs, FKs, external systems.

### Concurrency & Locking (MEDIUM-HIGH)
- `SELECT ... FOR UPDATE SKIP LOCKED` for queue patterns — drop-in in-DB replacement for Redis-Streams / RabbitMQ for moderate-throughput job queues. No deadlocks, no waiting; each worker grabs the next available row.
- **`SELECT ... FOR UPDATE`** (without SKIP LOCKED) for atomic counter-increments and burn-after-reading patterns — exactly-once read semantics:
  ```sql
  -- Inside a SECURITY DEFINER function:
  SELECT * INTO row FROM paste WHERE id = paste_id FOR UPDATE;
  -- check, increment read_count, optional DELETE — all under the row lock
  ```
- **No long transactions holding locks.** They also block autovacuum from reclaiming dead tuples newer than the oldest live snapshot — long idle txn = table bloat. Monitor with `pg_stat_activity`; set `idle_in_transaction_session_timeout`.
- Advisory locks for app-level mutual exclusion (`pg_advisory_lock(key)`) — cheap, session-scoped, no schema needed
- `INSERT ... ON CONFLICT DO UPDATE` (upsert) over separate SELECT + INSERT
- `INSERT ... ON CONFLICT DO NOTHING` for idempotent inserts (event ingestion, dedup) — requires a unique/PK constraint on the conflict target
- **Catch unique-violation `23505` in the app layer**, translate to typed HTTP 409. Pre-check-then-insert is a TOCTOU race; the second writer hits the constraint and the raw Postgres error message ("duplicate key value violates unique constraint…") propagates as 500 unless you intercept it.
- **DDL in Postgres is transactional.** Wrap multi-step migrations in `BEGIN…COMMIT`; if the third `ALTER TABLE` fails, the first two roll back. (MySQL does not do this — easy to forget which DB you're targeting.)

### Data Access Patterns (MEDIUM)
- Batch inserts: `COPY` or multi-row `INSERT` over individual inserts
- **Keyset / cursor-based pagination** (`WHERE created_at < $cursor`) over `OFFSET` for large datasets. Cursor is resilient to inserts between page fetches; OFFSET skips rows when a new row lands above the cursor. For composite ordering use `(created_at, id)` tuple cursor to avoid duplicate-timestamp skips.
- Probe-row trick for "has-more" detection without a second roundtrip: `.limit(N + 1)`. If `rows.length > N` there's another page; return the first N and use `rows[N-1].created_at` as `nextCursor`.
- Materialized views for expensive aggregations, refresh on schedule
- Partition large tables by time/range when >~50M rows
- **PostgREST `PGRST116` is "zero rows for .single()"** — not an error. Short-circuit to null in your repository layer; don't log:
  ```ts
  if (error?.code === 'PGRST116') return null;
  ```
- **RLS-blocked DELETE silently succeeds with `count: 0`** — indistinguishable from "no row with that id". Always:
  ```ts
  const { count, error } = await client.from('x').delete({ count: 'exact' }).eq('id', id);
  return !error && (count ?? 0) > 0;
  ```

### Monitoring & Diagnostics (LOW-MEDIUM)
- `pg_stat_statements` for slow query analysis
- `pg_stat_user_tables` for high sequential scan tables (`seq_scan` >> `idx_scan` → missing index)
- `pg_stat_bgwriter` for checkpoint tuning
- `auto_explain` for automatic slow query plan logging — set `log_min_duration = '500ms'`
- `pg_stat_activity` to find long-running txns + locks (filter `state = 'idle in transaction'`)
- **pg-cron job health**: `cron.job_run_details` has every run's exit status. Add an external uptime ping or scheduled query that alerts on `status != 'succeeded'` rows in the last hour — pg-cron failures are silent otherwise.
- **MVCC bloat watch**: `pg_stat_user_tables.n_dead_tup` shows dead tuple count per table. If it climbs faster than autovacuum can clear it, drop the per-table `autovacuum_vacuum_scale_factor` or look for a long-running transaction blocking vacuum.

### pg-cron expiry / cleanup jobs (HIGH operational impact)

Unbounded `DELETE FROM x WHERE expires_at < now()` is a foot-gun. A spike of 50k+ rows expiring in a single window holds row locks across the entire matching set; concurrent reads/writes on overlapping rows stall behind the lock until the DELETE completes.

```sql
-- WRONG: unbounded, locks the whole expired set
SELECT cron.schedule('cleanup', '*/5 * * * *',
  $$ DELETE FROM public.things WHERE expires_at < now() $$);

-- RIGHT: batched, lock-hold bounded by LIMIT
SELECT cron.schedule('cleanup', '*/5 * * * *', $$
  DELETE FROM public.things
  WHERE id IN (
    SELECT id FROM public.things
    WHERE expires_at < now()
    LIMIT 1000
  )
$$);
```

pg-cron picks up the rest on the next cycle. Rows past `expires_at` are not user-visible (every read path should filter `expires_at > now()`) so spreading cleanup across cycles is invisible.

### Realtime / triggers (HIGH operational impact)

- **Verify the subscriber exists end-to-end before installing a Realtime trigger.** A trigger that calls `realtime.send(...)` on every insert with no consumer burns the Realtime message quota (Free: 2M/mo) for nothing. Two ways this happens:
  1. Trigger installed; frontend never wires up `.channel(…).subscribe(…)`.
  2. Frontend CSP `connect-src 'self'` physically blocks WebSocket to `wss://<ref>.supabase.co`. Verify the CSP allows the WebSocket origin before designing for browser-side Realtime.
- **Prefer Broadcast over `postgres_changes`** for production push feeds — `postgres_changes` runs RLS per-row per-subscriber and doesn't scale. Broadcast lets a trigger build a curated payload and emit once per event.
- **`AFTER INSERT`** fires on actual INSERT only, not on `INSERT ... ON CONFLICT DO UPDATE` that resolved to UPDATE. Use this property to keep "newly-created" feeds clean of read-count upserts.
- **3-layer defence-in-depth** when broadcasting from a trigger: filter at the trigger (`IF NEW.visibility = 'public' THEN ...`), curate the payload (whitelist safe fields, never `content`/`delete_token`/`user_id`), and RLS on `realtime.messages` to restrict subscribers to the exact topic. Even if the trigger or schema later regresses, the RLS layer holds.

### Advanced Features (LOW)
- `LISTEN` / `NOTIFY` for cross-connection signalling — payload ≤8000 bytes, not durable (lost if no listener), delivered post-COMMIT. PostgREST schema cache reload via `NOTIFY pgrst, 'reload schema'` is the canonical use; Supabase Realtime Broadcast also rides this rail. Don't use it as a durable queue.
- `pg_vector` for embedding storage; **HNSW index** for cosine/inner-product/L2 search at scale — better speed-recall tradeoff than ivfflat (at the cost of slower build + more memory). Op classes: `vector_cosine_ops` / `vector_l2_ops` / `vector_ip_ops` / `vector_l1_ops`; `halfvec_*` variants for half-precision; `bit_hamming_ops` / `bit_jaccard_ops` for bit vectors. Tune `hnsw.ef_search` (default 40) at query time for recall vs latency.
- `pg_graphql` for GraphQL-over-Postgres exposed via PostgREST — gated by RLS automatically.
- Generated columns (`STORED`) for derived tsvector / hash / etc. — keeps the derived value consistent with source columns without app-side coordination.
- **PostgREST** turns the schema into a REST API automatically. Combined with RLS, deletes ~80% of typical CRUD backend code. Trade-off: complex business logic pushes you toward SQL functions + views, which some teams resist.
- **Foreign Data Wrappers** (`postgres_fdw`, `mysql_fdw`, `file_fdw`, …) mount external sources as tables for federated queries. Good for read-only joins across systems and gradual migrations; watch `EXPLAIN` to confirm WHERE/JOIN pushdown to the remote side.
- **BRIN + declarative partitioning** for time-series at scale. Partition `events` by month; BRIN index on `created_at` is tiny and skips entire blocks during range scans. Far cheaper than B-tree on multi-billion-row append-only tables.
- **Materialized views + `REFRESH MATERIALIZED VIEW CONCURRENTLY`** for expensive dashboard aggregations. Requires a unique index on the view to enable the concurrent refresh (otherwise readers are blocked during refresh).

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
- `docs_read(path="/docs/postgres/...")` — full Postgres reference via docs-ssh
