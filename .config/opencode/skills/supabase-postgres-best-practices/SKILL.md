---
name: supabase-postgres-best-practices
description: Postgres performance optimization and best practices from Supabase. Use this skill when writing, reviewing, or optimizing Postgres queries, schema designs, or database configurations.
license: MIT
metadata:
  author: supabase
  version: "1.2.0"
  organization: Supabase
  date: May 2026
  abstract: Postgres performance optimization guide. Rules across 8 categories prioritized by impact. Includes correct/incorrect SQL examples, query plan analysis, performance metrics.
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
- No `SELECT *` — select needed columns only
- `EXPLAIN (ANALYZE, BUFFERS)` for slow queries
- `EXISTS` over `COUNT` for existence checks
- No fns on indexed columns in WHERE (prevents index use)
- **Cap string inputs that feed `tsvector` / GIN indexes.** Unbounded `text` columns indexed by GIN bloat the index quickly. Enforce limits at the app layer (Zod `.max(N)`) and/or with a CHECK constraint.

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
- `GENERATED ALWAYS AS IDENTITY` over `SERIAL`
- Normalize to 3NF unless denormalization justified by perf
- Check constraints for business rules at DB level
- **`NOT NULL DEFAULT gen_random_uuid()`** for any secret-token column. Combine with an inverted app-side guard (`if (!storedToken || storedToken !== ownerToken)`) so a future schema drift can't be exploited as defense-in-depth.
- **Triggers should use `WHEN (OLD.col IS DISTINCT FROM NEW.col)`** for value-change detection, not `UPDATE OF col`. The latter fires on column presence in the SET clause, which means `upsert()` (which sends all columns) triggers on every read-count increment. `IS DISTINCT FROM` is NULL-safe (unlike `<>`) and only fires on actual value change.

### Concurrency & Locking (MEDIUM-HIGH)
- `SELECT ... FOR UPDATE SKIP LOCKED` for queue patterns
- **`SELECT ... FOR UPDATE`** (without SKIP LOCKED) for atomic counter-increments and burn-after-reading patterns — exactly-once read semantics:
  ```sql
  -- Inside a SECURITY DEFINER function:
  SELECT * INTO row FROM paste WHERE id = paste_id FOR UPDATE;
  -- check, increment read_count, optional DELETE — all under the row lock
  ```
- No long transactions holding locks
- Advisory locks for app-level mutual exclusion
- `INSERT ... ON CONFLICT DO UPDATE` (upsert) over separate SELECT + INSERT
- **Catch unique-violation `23505` in the app layer**, translate to typed HTTP 409. Pre-check-then-insert is a TOCTOU race; the second writer hits the constraint and the raw Postgres error message ("duplicate key value violates unique constraint…") propagates as 500 unless you intercept it.

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
- `pg_stat_user_tables` for high sequential scan tables
- `pg_stat_bgwriter` for checkpoint tuning
- `auto_explain` for automatic slow query plan logging
- **pg-cron job health**: `cron.job_run_details` has every run's exit status. Add an external uptime ping or scheduled query that alerts on `status != 'succeeded'` rows in the last hour — pg-cron failures are silent otherwise.

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
- `LISTEN` / `NOTIFY` for cross-connection signalling — but PostgREST schema cache reload via `NOTIFY pgrst, 'reload schema'` is the only commonly-used case.
- `pg_vector` for embedding storage; HNSW index for cosine/inner-product search at scale.
- `pg_graphql` for GraphQL-over-Postgres exposed via PostgREST — gated by RLS automatically.
- Generated columns (`STORED`) for derived tsvector / hash / etc. — keeps the derived value consistent with source columns without app-side coordination.

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
- `docs_read(path="/docs/postgres/...")` — full Postgres reference via docs-ssh
