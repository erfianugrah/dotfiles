---
name: supabase-postgres-best-practices
description: Postgres performance optimization and best practices from Supabase. Use this skill when writing, reviewing, or optimizing Postgres queries, schema designs, or database configurations.
license: MIT
metadata:
  author: supabase
  version: "1.1.1"
  organization: Supabase
  date: January 2026
  abstract: Comprehensive Postgres performance optimization guide for developers using Supabase and Postgres. Contains performance rules across 8 categories, prioritized by impact from critical (query performance, connection management) to incremental (advanced features). Each rule includes detailed explanations, incorrect vs. correct SQL examples, query plan analysis, and specific performance metrics to guide automated optimization and code generation.
---

# Supabase Postgres Best Practices

Comprehensive performance optimization guide for Postgres, maintained by Supabase. Contains rules across 8 categories, prioritized by impact to guide automated query optimization and schema design.

## When to Apply

Reference these guidelines when:
- Writing SQL queries or designing schemas
- Implementing indexes or query optimization
- Reviewing database performance issues
- Configuring connection pooling or scaling
- Optimizing for Postgres-specific features
- Working with Row-Level Security (RLS)

## Rule Categories by Priority

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

## Key Rules Summary

### Query Performance (CRITICAL)
- Always index foreign keys and columns used in WHERE, JOIN, and ORDER BY clauses
- Use partial indexes for filtered queries (e.g., `WHERE deleted_at IS NULL`)
- Avoid `SELECT *` — select only the columns you need
- Use `EXPLAIN (ANALYZE, BUFFERS)` to diagnose slow queries
- Prefer `EXISTS` over `COUNT` for existence checks
- Avoid functions on indexed columns in WHERE clauses (prevents index use)

### Connection Management (CRITICAL)
- Use connection pooling (PgBouncer / Supabase pooler) — never open unbounded connections
- Set appropriate `pool_mode`: `transaction` for stateless APIs, `session` for prepared statements
- Keep connections short-lived; avoid holding connections across slow I/O
- Use `statement_timeout` and `lock_timeout` to prevent runaway queries

### Security & RLS (CRITICAL)
- Enable RLS on all tables in exposed schemas
- Use `auth.uid()` for user-scoped policies, `auth.jwt() -> 'app_metadata'` for role-based
- Never rely on `raw_user_meta_data` for authorization — it's user-editable
- Views bypass RLS by default — use `security_invoker = true` (Postgres 15+)
- `security definer` functions run as owner — keep them in unexposed schemas

### Schema Design (HIGH)
- Use appropriate types: `uuid` for IDs, `timestamptz` over `timestamp`, `text` over `varchar(n)`
- Prefer `NOT NULL` constraints where possible
- Use `GENERATED ALWAYS AS IDENTITY` over `SERIAL`
- Normalize to 3NF unless denormalization is justified by performance needs
- Add check constraints to enforce business rules at the DB level

### Concurrency & Locking (MEDIUM-HIGH)
- Use `SELECT ... FOR UPDATE SKIP LOCKED` for queue patterns
- Avoid long transactions that hold locks
- Use advisory locks for application-level mutual exclusion
- Prefer `INSERT ... ON CONFLICT DO UPDATE` (upsert) over separate SELECT + INSERT

### Data Access Patterns (MEDIUM)
- Batch inserts using `COPY` or multi-row `INSERT` over individual row inserts
- Use cursor-based pagination (`WHERE id > $last_id`) over `OFFSET` for large datasets
- Cache expensive aggregations in materialized views and refresh on a schedule
- Partition large tables by time or range when they exceed ~50M rows

### Monitoring & Diagnostics (LOW-MEDIUM)
- Query `pg_stat_statements` for slow query analysis
- Use `pg_stat_user_tables` to identify tables with high sequential scans
- Monitor `pg_stat_bgwriter` for checkpoint tuning
- Use `auto_explain` to log slow query plans automatically

## References

- https://www.postgresql.org/docs/current/
- https://supabase.com/docs
- https://wiki.postgresql.org/wiki/Performance_Optimization
- https://supabase.com/docs/guides/database/overview
- https://supabase.com/docs/guides/auth/row-level-security
