# software-architecture: repo layouts and AGENTS.md

Supporting reference for the `software-architecture` skill. Directory trees for a Go service, the full-stack single-binary Go + embedded frontend shape, a TypeScript service, and the required per-service AGENTS.md outline.

## Module / file layout

### Go service

```
service-name/
├── cmd/<binary>/main.go    Entry point, wires deps, starts server
├── internal/               All business code (Go convention: unimportable from outside)
│   ├── api/                HTTP/WS handlers
│   ├── <context1>/         Bounded context
│   ├── <context2>/
│   └── storage/            sqlc generated + pool helpers
├── migrations/             Goose SQL files, embedded via //go:embed at process startup
├── deploy/                 docker-compose.yml, k8s manifests, Caddyfile snippet
├── docs/
│   ├── DEVELOPING.md       Build/run/test for humans
│   └── ADRs/               Architecture Decision Records
├── AGENTS.md               For coding agents - see template below
├── README.md               For users
├── go.mod / go.sum
└── Makefile                make build/test/run/lint
```

### Full-stack Go (single binary, embedded frontend) - user's signature pattern

When the frontend is co-shipped with the backend (one repo, one deployable, no
separate web service), prefer the **flat single-binary** layout over a monorepo
split. The frontend builds into `web/dist/` and is `//go:embed`ed by the Go
binary, which serves both API and static assets from a single port. This is the
shape the user defaults to for full-stack Go projects (see `~/bonkled/AGENTS.md`
for the canonical example).

```
project-name/
├── cmd/<binary>/main.go    Entry point
├── internal/               Business code, bounded contexts
│   ├── api/                HTTP/WS handlers
│   ├── <context>/
│   └── storage/
├── migrations/             goose SQL files
├── web/                    Astro/React frontend (its own package.json + bun.lock)
│   ├── src/
│   ├── dist/               build output (gitignored, populated by `bun run build`)
│   └── package.json
├── static.go               //go:embed all:web/dist - wires web/dist into http.FileServer
├── deploy/                 compose.yaml, Caddy snippet
├── Makefile                web-build → go build → docker (canonical chain)
└── ...
```

When to deviate from flat:
- Frontend and backend deploy independently (different SLAs, scale-out paths) → monorepo with `apps/web/` + `services/<svc>/`.
- Frontend is in a different language stack (e.g. SvelteKit + Rust backend) where shared bun.lock makes no sense → monorepo.
- Multiple frontends share a backend (web + mobile + desktop) → monorepo or split repos.
- Otherwise, prefer flat. One container, one port, one TLS cert, one deploy step. The container image is smaller because there's no nginx layer, and ops-side debugging is easier because there's only one process to look at.

`make web-build` runs `bun run build` in `web/`, then `go build` picks up the
refreshed `web/dist/` via `//go:embed`. Pre-commit gate should run both.

### TypeScript service (Astro/Next/Hono backend)

```
service-name/
├── src/
│   ├── routes/             Astro pages / Next route handlers / Hono routes
│   ├── lib/                Business logic, organised by bounded context
│   │   ├── auth/
│   │   ├── billing/
│   │   ├── db/             drizzle schema + queries
│   │   └── observability/
│   └── middleware.ts
├── drizzle/                Generated SQL migrations
├── AGENTS.md
├── biome.json
├── package.json
└── tsconfig.json
```

## AGENTS.md per service - required

Every backend service repo has a top-level `AGENTS.md` documenting:

1. **Project overview** - what is this, who uses it (1 paragraph)
2. **Build / run / test commands** - `make build`, `make test`, single-test invocation
3. **Bounded contexts** - `internal/` tree with one-line purpose per directory
4. **Persistence** - DB schemas, migration strategy, optional caches
5. **API surface** - route table, WS envelope format
6. **Common gotchas** - concrete pitfalls discovered the hard way
7. **Observability** - log format, metrics namespace, correlation ID convention
8. **Deployment** - local dev vs prod, deploy procedure

Read `~/bonkled/AGENTS.md` for the canonical example.
