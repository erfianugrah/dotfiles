---
name: supabase-postgres-best-practices
description: Postgres performance optimization and best practices from Supabase. Use this skill when writing, reviewing, or optimizing Postgres queries, schema designs, or database configurations.
license: MIT
metadata:
  author: supabase
  version: "1.1.1"
  organization: Supabase
  date: January 2026
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

### Connection Management (CRITICAL)
- Use connection pooling (PgBouncer/Supabase pooler) — no unbounded connections
- `pool_mode`: `transaction` for stateless APIs, `session` for prepared statements
- Keep connections short-lived; no holding across slow I/O
- Set `statement_timeout` + `lock_timeout`

### Security & RLS (CRITICAL)
- RLS on all tables in exposed schemas
- `auth.uid()` for user-scoped policies, `auth.jwt() -> 'app_metadata'` for role-based
- Never `raw_user_meta_data` for auth — user-editable
- Views bypass RLS by default — `security_invoker = true` (Postgres 15+)
- `security definer` fns → unexposed schemas only

### Schema Design (HIGH)
- Types: `uuid` for IDs, `timestamptz` over `timestamp`, `text` over `varchar(n)`
- Prefer `NOT NULL`
- `GENERATED ALWAYS AS IDENTITY` over `SERIAL`
- Normalize to 3NF unless denormalization justified by perf
- Check constraints for business rules at DB level

### Concurrency & Locking (MEDIUM-HIGH)
- `SELECT ... FOR UPDATE SKIP LOCKED` for queue patterns
- No long transactions holding locks
- Advisory locks for app-level mutual exclusion
- `INSERT ... ON CONFLICT DO UPDATE` (upsert) over separate SELECT + INSERT

### Data Access Patterns (MEDIUM)
- Batch inserts: `COPY` or multi-row `INSERT` over individual inserts
- Cursor-based pagination (`WHERE id > $last_id`) over `OFFSET` for large datasets
- Materialized views for expensive aggregations, refresh on schedule
- Partition large tables by time/range when >~50M rows

### Monitoring & Diagnostics (LOW-MEDIUM)
- `pg_stat_statements` for slow query analysis
- `pg_stat_user_tables` for high sequential scan tables
- `pg_stat_bgwriter` for checkpoint tuning
- `auto_explain` for automatic slow query plan logging

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
