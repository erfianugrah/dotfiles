---
name: software-architecture
description: Use when making system-level design decisions for a backend service or full-stack app - bounded contexts (DDD-lite), module boundaries, API surface design (REST + WS), persistence patterns (Postgres primary), observability, error handling, async work. Fires on 'new backend service', 'refactor module boundaries', 'design the API surface', 'where should this logic live'. NOT for framework choice (supabase), deploy shape (infrastructure-stack) or planning/TDD process (writing-specs, writing-plans).
---

# Software architecture - system shape

The methodology skills (`writing-specs`, `writing-plans`, the TDD rules, review) cover the *process*. `frontend-stack` and `supabase` cover *framework choices*. This skill covers the **system shape** between them: how modules talk, how the API is laid out, how data flows, how you observe failures.

Grounded in the user's established Go pattern (`~/bonkled/`, `~/infra/ergo/caddy-compose/wafctl/`). Reads as opinionated defaults; deviate when justified.

## Bounded contexts (DDD-lite, not enterprise DDD)

Organise `internal/` (Go) or `src/lib/` (TS) by **business concept**, not by technical layer. Each context owns its types, its persistence, its tests.

```
internal/
├── api/           HTTP + WS handlers, route table, middleware
├── identity/      Auth, sessions, principals
├── <domain1>/     Pure logic for the core business concept
│   ├── engine/    Algorithms, no I/O
│   ├── run/       Aggregate roots, state machines, scoring
│   └── service.go Coordinates persistence + business calls
├── <domain2>/     Another business concept
├── ranking/       Rating calc, leaderboards
└── storage/       sqlc-generated PG access, pool helpers, cache adapters
```

### Three rules

1. **One bounded context per business concept.** Not per data model, not per table.
2. **Cross-context dependencies flow through interfaces declared in the consumer** (not the provider). Example: `game/run/` needs to read player ratings → it declares `type RatingsRepo interface { GetRating(playerID) ... }`, and `ranking/` implements that. This lets the consumer test with a fake and lets you swap implementations without touching the provider.
3. **Keep changes within one context per commit when possible.** If a refactor crosses contexts, ask whether the boundary is wrong.

### Anti-pattern: technical layering

```
src/
├── controllers/    ← BAD
├── services/       ← BAD
├── repositories/   ← BAD
└── models/         ← BAD
```

This is Java-2005 thinking. Splits cohesive features across four directories. You end up touching all four to add one feature. Bounded contexts keep a feature in one folder.

## Decision tree - quick lookup

| Question | Answer |
|---|---|
| Should this be a new service or extend existing? | **Same service** unless the new feature has independent scaling, independent failure domain, OR different team ownership. Default to monolith with bounded contexts. |
| REST or GraphQL or gRPC? | **REST** for public APIs, third-party-facing, simple CRUD. **gRPC** for service-to-service when you control both sides. **GraphQL** rarely - only when clients need flexible field selection and you don't control them. |
| One Postgres for everything or one per service? | **One per service.** Sharing a DB across services creates schema coupling. Cross-service reads via the owner's HTTP API. |
| Cache layer (Valkey/Redis)? | **Optional, with in-process fallback.** Default off; turn on when measured contention or specific patterns (rate limit, queue, lock) demand it. |
| Sync vs async work? | **Sync until proven otherwise.** Then escalate Level 1 → 2 → 3 in `runtime-patterns.md`. |
| Throw exceptions or return Results? | **Go: return error.** **TS: discriminated union for expected failures; throw only at boundaries.** |
| Add a new env var or a new file? | **Env var if it differs per environment** (prod URL ≠ dev URL). **Config file if it's stack-wide invariant.** |
| Custom domain logic in middleware? | **No.** Middleware is for cross-cutting concerns (auth, logging, rate limit, CORS). Domain logic in services. |
| Singleton or DI? | **Constructor injection from `main.go`/entry point.** Wire deps explicitly. Singletons are global mutable state. |

## Common pitfalls

- **Splitting too early into "microservices"**: usually wrong. Start as one process with bounded contexts. Split only when you measure a reason (independent scaling, independent failure isolation, team boundary). Splitting a 10k LOC app into 7 services creates 7x the deployment + observability work for negative business value.
- **Ignoring the request-id**: harder to debug after the fact than to add at the start. Middleware in 20 lines; pays back every incident.
- **Returning DB models from API handlers**: couples the API contract to schema. Always have a separate `<Context>Response` type. Cheap discipline now, prevents painful migrations later.
- **`time.Now()` everywhere in business logic**: untestable. Pass a `Clock` interface. Production: `clock.Real{}`. Tests: `clock.Fake{}` that returns deterministic times.
- **Logging then returning the error**: double-logs the same failure once at each layer. **Log OR return, never both.** Convention: only the top of the stack (HTTP middleware) logs.
- **Catching all errors at the boundary and returning `500`**: loses information. Use sentinel errors + a `errorsToHTTPStatus(err) int` mapper.
- **Trusting client-side validation**: every input crossing a trust boundary needs server-side validation. Zod schemas / Go struct tags / sqlc constraints - pick one and apply it religiously at the boundary.
- **Storing JWT in localStorage**: XSS-exposed. Use `httpOnly` cookies. Same trade-offs for CSRF - apply double-submit token or SameSite=Strict.
- **Building "for future scale"**: design for current load × 3, not × 100. Re-architecting at 10× growth is easier than carrying excess complexity from day one.

## Reference files (read when you get there)

- `api-surface.md` - REST route shape, X-Request-ID, idempotency keys, WS envelope + seq replay. Read when designing or reviewing an API.
- `runtime-patterns.md` - Postgres/sqlc/goose + optional Valkey, structured logs/metrics/tracing, error handling in Go and TS, async work levels 1-3. Read when choosing a persistence or async mechanism.
- `layouts.md` - Go service tree, full-stack single-binary layout with embedded web/dist, TS service tree, per-service AGENTS.md outline. Read when creating a repo.

## When NOT to use this skill

- Writing a one-off script or migration tool - full bounded-context skeleton is overkill.
- Pure frontend work - see `frontend-stack`.
- Pure DB design work - see `supabase-postgres-best-practices`.
- Methodology (planning, TDD, review) - see the methodology skills (`writing-specs`, `writing-plans`, `systematic-debugging`).
- Infra deployment shape - see `infrastructure-stack`.

## Related

- **`writing-plans`** - after this skill establishes shape, plans turn shape into ordered steps
- **TDD (global agent rules)** - every implementation tier (the RED-GREEN-REFACTOR rules live in the global agent rules, not a skill)
- **`infrastructure-stack`** - how this service gets deployed
- **`frontend-stack`** - when this service also has a frontend
- **`supabase`** + **`supabase-postgres-best-practices`** - when persistence is Supabase rather than self-hosted Postgres
- **`ci-workflows`** - to wire build + test + deploy
- **User's reference repo**: `~/bonkled/AGENTS.md` - canonical example of these patterns applied
