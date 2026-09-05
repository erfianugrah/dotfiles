# software-architecture: persistence, observability, errors, async

Supporting reference for the `software-architecture` skill. The runtime-side defaults: Postgres + sqlc/goose with optional Valkey, the three observability pillars, Go and TypeScript error handling, and the three async escalation levels.

## Persistence - Postgres primary, Valkey optional

### Default: Postgres + sqlc

- **One Postgres per service** (in the compose stack pattern from `infrastructure-stack`). No shared databases across services - that's how you get coupling without realising.
- **sqlc** (Go) or **drizzle** (TS) for **type-safe query generation**. Hand-rolled string SQL is the wrong default - type errors at runtime instead of compile time.
- **Migrations** via `goose` (Go) or `drizzle-kit` (TS) - embedded via `//go:embed` (Go) or bundled at build (TS), applied at process startup. **Forward-only in production.** Backward migrations exist for tests / local dev only.
- **One table per aggregate root**. State machines stored as `state` columns + `state_blob jsonb` for the snapshot. Don't normalise the aggregate into 17 child tables - premature normalisation prevents efficient reads and complicates state transitions.
- **Composite PKs where they enforce business invariants**: e.g. `daily_attempts (player_id, puzzle_date)` - DB enforces "one daily run per player per day" without app code.

### Optional: Valkey for hot paths

When you need:

- **Rate limiting**: `SET NX PX <ms>` for atomic windowed limiters. ~50ms window for anti-bot is the bonkled pattern.
- **Matchmaking queues**: sorted set by score + Lua claim script for atomic pair-pop. Postgres can't do this efficiently at scale.
- **Distributed locks**: same `SET NX PX` pattern.
- **Ephemeral session state**: friend rooms, presence tracking. Don't put this in Postgres - it's churn.

**Always provide in-process fallbacks.** Make Valkey optional via env var (e.g. `BONKLED_VALKEY_URL` in bonkled; `<SVC>_VALKEY_URL` for yours). When unset, use in-memory map with mutex. Single-replica deploys don't need Valkey. Multi-replica deploys mandate it. The same code paths work for both - never have a "Valkey deployment" and a "non-Valkey deployment" branch in business logic.

## Observability

Three pillars, in order of value:

### 1. Structured logs (slog in Go, pino in TS)

- **Always structured JSON, never `fmt.Printf`.** Search/filter is impossible on prose logs.
- **Every log line includes `rid=<request-id>`** when in a request context. Set it via context-aware logger.
- **Levels**: `DEBUG` (chatty, off in prod), `INFO` (state changes, request boundaries), `WARN` (recoverable degradation), `ERROR` (something failed and you should care).
- **Don't log secrets**. Have a redaction wrapper. CR for log statements should check this.

### 2. Metrics (Prometheus exposition at `/metrics`)

Namespace everything: `bonkled_request_duration_seconds`, `bonkled_active_runs_total`. Standard set:

- `<svc>_request_duration_seconds{route, method, status}` histogram - RED method (Rate, Errors, Duration).
- `<svc>_<feature>_total{outcome}` counter for business events.
- `<svc>_active_<resource>` gauge for live counts.

Scrape from your Prometheus. Alert on rate-of-errors and p95 latency.

### 3. Tracing (only if you have multiple services)

OpenTelemetry. Don't bother for a single service - the request-id correlation in structured logs gives you 80% of the value for 5% of the effort. Add tracing when you have 3+ services in a request path.

## Error handling

### Go: explicit error returns, never panic in business logic

- **Return `error` from every fallible function.** No exceptions, no globals.
- **Wrap errors with context**: `fmt.Errorf("loading run %s: %w", id, err)`. The `%w` makes `errors.Is`/`errors.As` work.
- **Define sentinel errors for known failure modes**: `var ErrRunNotFound = errors.New("run not found")`. Tested via `errors.Is(err, ErrRunNotFound)`, not by string matching.
- **HTTP middleware translates errors to status codes** in one place: `ErrNotFound → 404`, `ErrConflict → 409`, `ErrValidation → 400`, default `→ 500`. Business code never knows about HTTP codes.

### TypeScript: Result types or zod-validated errors

- **Don't throw for control flow.** Throw only for "the universe broke" - out of memory, network gone, etc.
- **For expected failures, return `Result<T, E>` or `{ ok: false, error }` discriminated union.** Type-safe handling at the call site.
- **Zod for runtime validation at trust boundaries** (HTTP request bodies, env vars, localStorage reads). Throw inside zod is fine - it's the boundary.

## Async work

Three escalation levels - pick the lowest that meets your needs:

### Level 1: Background goroutine / setTimeout (simplest)

For fire-and-forget work that can fail silently:
- "Send a welcome email after signup"
- "Cleanup old sessions every hour"

Just spawn a goroutine. **Always with panic recovery + logging.** Lost on crash; that's acceptable for this tier.

### Level 2: Persistent queue (Postgres `LISTEN`/`NOTIFY` + jobs table, or Valkey list)

For work that **must** complete eventually:
- "Process uploaded file"
- "Charge subscription"

Use **Postgres `LISTEN/NOTIFY` + a `jobs` table** for ≤100 jobs/sec. The job stays in PG until done; workers `SELECT ... FOR UPDATE SKIP LOCKED` claim atomically.

Don't reach for SQS/RabbitMQ/Kafka here - Postgres handles this scale fine and gives you transactional `enqueue` (job becomes visible only if the parent transaction commits).

### Level 3: Dedicated queue infrastructure

Only when:
- >1000 jobs/sec sustained
- Cross-service fan-out (job triggers work in 5 other services)
- Need delivery guarantees beyond what PG can express

Then: **NATS JetStream** (lightweight, good defaults), or **Postgres + pg_cron** if scheduling is the only complexity.

Avoid Kafka unless you're doing event sourcing or stream processing across many consumers. Kafka's operational cost is real.
