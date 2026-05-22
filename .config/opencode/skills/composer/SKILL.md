---
name: composer
description: Drive the user's self-hosted Docker Compose management platform (`composer` at /home/erfi/composer, deployed at composer.erfi.io). Use when the user mentions composer, composerd, stack deployment via API, GitOps pipelines, or wants to drive Docker Compose stacks programmatically rather than via direct `docker compose` commands. Covers the REST API (106 endpoints under /api/v1), auth (API keys / cookies), release workflow, pipeline footguns, and the hard "don't run composerd on dev" rule.
---

# composer skill

Self-hosted compose-mgmt platform. Go + Astro. REST API only — no end-user CLI. Repo: `/home/erfi/composer`. Daemon: single Go binary `composerd`. Frontend: Astro 6 + React 19 + Tailwind 4 + shadcn (embedded via `static.go`).

## Hard safety rules

- **NEVER run `./composerd` or `go run ./cmd/composerd/` on the dev machine.** Startup hook AES-256-GCM encrypts every key under `$HOME/.ssh` using a key stored in `COMPOSER_DATA_DIR`. Default `COMPOSER_DATA_DIR=/tmp` → reboot loses the key → SSH keys unrecoverable. Use `go test`, `make test-unit`, or `docker compose -f deploy/compose.yaml up` (isolated `/home/composer/.ssh`). `cmd/decryptssh/` exists for emergency recovery.
- **CGO must be 0** — pure-Go SQLite (modernc.org/sqlite). The Makefile bakes `CGO_ENABLED=0`. Don't override.

## Canonical references (read these instead of guessing)

| Doc | When |
|---|---|
| `/home/erfi/composer/AGENTS.md` | Agent guide — Safety, Build, Testing, Release, Architecture |
| `/home/erfi/composer/docs/api-reference.md` | The 106-endpoint canonical ref |
| `/home/erfi/composer/docs/configuration.md` | All `COMPOSER_*` env vars |
| `/home/erfi/composer/docs/architecture.md` | DDD layer diagram |
| `/home/erfi/composer/docs/design.md` | Full design spec with domain models |
| `/home/erfi/composer/docs/security.md` | Docker socket, RBAC, encryption, hardening |
| `/home/erfi/composer/docs/deployment.md` | Docker / Unraid / TrueNAS / Podman / bare metal |

When the API spec matters, the **live source of truth** is the daemon itself:

```bash
curl -s composer.erfi.io/openapi.json | jq '.paths | keys'   # endpoint list
curl -s composer.erfi.io/openapi.json | jq '.paths."/api/v1/stacks/{name}".put'
# interactive: open composer.erfi.io/docs in browser
```

## API basics

- Base: `composer.erfi.io/api/v1` (prod). Local dev: `localhost:8080/api/v1`.
- Spec: `GET /openapi.json` or `/openapi.yaml`. Interactive docs at `/docs` (Stoplight Elements). All three are public — no auth.
- Auth (any one of):
  - Session cookie via `POST /api/v1/auth/login` (UI flow).
  - API key as `Authorization: Bearer ck_…` OR `X-API-Key: ck_…`. **Preferred for agents.** Mint via `POST /api/v1/keys` (operator+ role). Shown once — redacted to `****<last4>` after.
- Public endpoints: health, bootstrap, login, templates, openapi spec, oauth callbacks, webhook receivers.
- Errors: RFC 9457 Problem Details. 500s include `request_id`.
- Hard limits: Huma 1 MB request body cap. Compose YAML 512 KB. .env 256 KB.

## Auth quick-start (agent driving the API)

```bash
export COMPOSER_API_KEY=ck_…           # from /api/v1/keys POST
export BASE=https://composer.erfi.io/api/v1

# list stacks
curl -s -H "X-API-Key: $COMPOSER_API_KEY" "$BASE/stacks" | jq

# deploy a stack
curl -s -X POST -H "X-API-Key: $COMPOSER_API_KEY" \
  "$BASE/stacks/my-stack/up?async=true" | jq .job_id
```

For async ops, poll `GET /api/v1/jobs/{id}`. Jobs auto-cleanup after 1h. Max 100 listed.

## Roles

- **Admin** — everything. Required for: user/key/system mgmt, `shell_command` + `docker_exec` pipeline steps, `POST /docker/exec`.
- **Operator** — stack CRUD, deploy, terminal, pipelines, webhooks, registries.
- **Viewer** — read-only.

## Stack lifecycle

CRUD: `GET/POST /stacks`, `POST /stacks/git` (clone repo), `POST /stacks/import` (Dockge dir), `GET/PUT/DELETE /stacks/{name}`, `PUT /stacks/{name}/env`.

Lifecycle: `POST /stacks/{name}/{up|build|down|restart|pull}` — all support `?async=true` returning `{job_id}`. Sync mode blocks until done (subject to 1 MB resp cap on logs).

Other: `POST /validate`, `POST /exec` (run `docker compose <cmd>`), `POST /convert/{git,local}` (toggle git-backed ↔ local), `GET /diff` (disk vs running config), `GET/PUT /credentials` (per-stack registry).

Name pattern: `^[A-Za-z0-9_-]+$`. Status enum on `StackSummary.Status`. Per-stack locks prevent concurrent lifecycle ops.

## Pipelines — footguns

Schedules use 5-field cron only. **Macros (`@daily`, `@hourly`, `@every 5m`) silently never fire.** Use `0 0 * * *` etc.

Trigger types:
- `manual` — explicit run via `POST /pipelines/{id}/run`
- `webhook` — fires in PARALLEL to GitOps sync. Race-prone for post-deploy work; use `event` instead.
- `schedule` — 5-field cron, scheduler ticks every minute, no overlap (skips if previous still pending/running)
- `event` — subscribes to in-process bus: `stack.{created,deployed,stopped,updated,deleted,error}`. **Use this for post-deploy hooks**, not `webhook`.

Step types (9):
- `compose_{up,down,pull,restart}` — only honours `{"stack": "name"}`. Older fields (`services`, `force_recreate`, `build`) ignored silently, not rejected.
- `shell_command` — admin role required. Env scrubbed to `PATH/HOME=/tmp/HISTFILE=/dev/null/TERM=xterm`. Stdout+stderr capped at 1 MB.
- `docker_exec` — admin role required. Same 1 MB cap.
- `http_request` — **GET only**, 30s fixed timeout, SSRF-protected, body NOT captured (only status code). No headers/method/retries.
- `wait` — sleep step.
- `notify` — **stub. Logs only. Does not deliver.** Don't promise users notifications.

Live run output: SSE at `GET /sse/pipelines/{id}/runs/{runId}`.

## GitOps

Stack-side endpoints: `POST /stacks/{name}/sync` (pull + clear dirty flag), `GET /stacks/{name}/git/{log,status,diff}`, `POST /stacks/{name}/rollback` (checkout SHA).

Webhook delivery (incoming): `POST /api/v1/hooks/{id}` (public, HMAC-validated). Supports GitHub (`X-Hub-Signature-256`), GitLab (`X-Gitlab-Token`), Gitea (`X-Gitea-Signature`), Generic.

Webhook CRUD: `GET/POST /webhooks`, `GET/PUT/DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries`. Secret returned plaintext **once** on POST, redacted to `****<last4>` after.

## Real-time streams

- SSE: `/sse/events` (global), `/sse/containers/{id}/{logs,stats}`, `/sse/stacks/{name}/logs`, `/sse/pipelines/{id}/runs/{runId}`
- WebSocket: `/api/v1/ws/terminal/{containerId}?shell=/bin/sh&cols=80&rows=24` — operator+. Raw chi handler (not Huma).

## Common make targets

```bash
make build              # generate → build-frontend → build-backend
make build-frontend     # cd web && bun install --frozen-lockfile && bun run build
make build-backend      # CGO_ENABLED=0 go build -ldflags="-s -w" -o composerd ./cmd/composerd/
make test               # = test-unit
make test-unit          # go test on domain/ + app/ + infra/{eventbus,crypto,sops,cache,notify}/
make test-integration   # -tags=integration -p 1 -timeout=5m (needs Docker)
make test-e2e           # -tags=e2e ./e2e/...  (needs Docker daemon)
make test-frontend      # cd web && bun run build && bun run test  (Playwright)
make lint               # go vet ./...
make generate           # OpenAPI spec + TS client (web/src/lib/api/{openapi.json,types.ts})
make docker             # docker build -f deploy/Dockerfile -t composer:local .
```

Integration tests **must run with `-p 1`** (sequential, Docker testcontainers).

## Release workflow — order matters

1. Bump `version.go` (`const Version`)
2. `make generate` — re-generates `web/src/lib/api/{openapi.json,types.ts}` from Go code
3. `make build-frontend` — produces `web/dist/` for `static.go` to embed
4. `make lint && make test-unit` — green required
5. `git add -A && git commit` — stage and commit ALL changes including generated artifacts
6. `git tag v<N> && git push && git push --tags`

**Why order matters:**
- CI lint runs `make generate` then `git diff --exit-code` on generated files. Stale spec → CI fails.
- `go vet` reads `static.go` which embeds `web/dist`. No dist → vet fails.
- `release.yml` on `v*` tag builds + pushes multi-arch image to `ghcr.io/erfianugrah/composer:<tag>`.

## Repo layout (one-line each)

```
cmd/composerd/        daemon entrypoint  ← DO NOT run on dev machine
cmd/dumpopenapi/      dumps OpenAPI spec to stdout (used by make generate)
cmd/decryptssh/       SSH key recovery tool (you hope you never need this)
internal/domain/      pure business logic, zero deps (auth/container/event/pipeline/registry/stack)
internal/app/         services: stack, git, pipeline (+ executor + cron scheduler), auth, jobs, etc.
internal/api/         Huma wiring, 24 handlers, middleware, ws/terminal, dto
internal/infra/       docker, store, crypto, eventbus, fs, git, notify, registry, sops, cache
web/                  Astro 6 + React 19 frontend. src/lib/api/* are GENERATED — never edit by hand.
e2e/                  Go E2E smoke tests (-tags=e2e)
deploy/               Dockerfile, compose.yaml, entrypoint.sh (PUID/PGID + DOCKER_GID magic)
docs/                 Canonical user/agent documentation
static.go             embeds web/dist at compile time
version.go            const Version — bump first on release
```

## Key env vars (subset — full list in docs/configuration.md)

| Var | Notes |
|---|---|
| `COMPOSER_PORT` | default 8080 |
| `COMPOSER_DB_URL` | empty = SQLite (default), or `postgres://…` |
| `COMPOSER_VALKEY_URL` | optional cache |
| `COMPOSER_STACKS_DIR` | default `/opt/stacks` |
| `COMPOSER_DATA_DIR` | default `/opt/composer`. **Never leave at /tmp.** SSH encryption key lives here. |
| `COMPOSER_DOCKER_HOST` | auto-detected |
| `COMPOSER_ENCRYPTION_KEY` | for credentials at rest |
| `COMPOSER_TRUSTED_PROXIES` | comma-separated CIDRs |
| `COMPOSER_SOPS_AGE_KEY` | for SOPS-encrypted .env files |
| `COMPOSER_REGISTRY_AUTHS[_FILE,_OVERWRITE]` | seed registry creds |
| `COMPOSER_OAUTH_CALLBACK_URL`, `COMPOSER_{GITHUB,GOOGLE}_CLIENT_{ID,SECRET}` | OAuth |
| `PUID` / `PGID` / `DOCKER_GID` | container user mapping |

## When the LLM should ask vs proceed

- **Proceed:** API queries (curl GET), stack listing, pipeline status checks, reading config/docs, planning changes.
- **Ask first:** any `DELETE`, `POST /stacks/.../down`, pipeline `cancel`, `POST /docker/exec` (raw docker on host), webhook deletion, role changes, `make docker` build. These are mutating + recoverability is limited.

## Tool-routing for composer questions

1. Source-of-truth spec → `curl composer.erfi.io/openapi.json | jq` (or `localhost:8080` in dev). Do NOT guess endpoint shapes.
2. Architecture / design → `read /home/erfi/composer/docs/architecture.md` or `docs/design.md`.
3. Endpoint reference → `read /home/erfi/composer/docs/api-reference.md`.
4. Code spelunking → `grep` / `lsp` on `internal/{domain,app,api,infra}/`. Use `lsp` for symbol navigation (Go LSP is accurate).
5. NEVER bash-run `./composerd`. NEVER `go run ./cmd/composerd/`.
