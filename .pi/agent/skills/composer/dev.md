# composer: developer reference

Supporting reference for the `composer` skill - the make targets, `make generate` artefacts, release order, repo layout and env-var table. Read when building, releasing or navigating the composerd source; `~/infra/composer/AGENTS.md` is the repo's own copy of the same rules and wins on conflict.

## Common make targets

```bash
make build              # generate -> build-frontend -> build-backend
make build-frontend     # cd web && bun install --frozen-lockfile && bun run build
make build-backend      # CGO_ENABLED=0 go build -ldflags="-s -w" -o composerd ./cmd/composerd/
make test               # = test-unit
make test-unit          # go test on domain/ + app/ + infra/{eventbus,crypto,sops,cache,notify}/
make test-integration   # -tags=integration -p 1 -timeout=5m (needs Docker)
make test-e2e           # -tags=e2e ./e2e/...  (needs Docker daemon)
make test-frontend      # cd web && bun run build && bun run test  (Playwright)
make lint               # go vet ./...
make generate           # OpenAPI JSON + YAML + TS client
make generate-lint      # generate + redocly spectral lint (web/redocly.yaml)
make docker             # docker build -f deploy/Dockerfile -t composer:local .
```

Integration tests **must run with `-p 1`** (sequential, Docker testcontainers).

### `make generate` - what it actually does

Emits **three** artifacts:

1. `web/src/lib/api/openapi.json` - from `go run ./cmd/dumpopenapi`
2. `web/src/lib/api/openapi.yaml` - from `go run ./cmd/dumpopenapi -yaml` (NEW)
3. `web/src/lib/api/types.ts` - from `bunx openapi-typescript`

All three are diff-checked in CI (`make generate` then `git diff --exit-code` on all three). Stale spec OR stale YAML OR stale types.ts breaks lint.

`scripts/generate-client.sh` is an alternate entry point but emits only JSON + types.ts (no YAML) - use `make generate` to stay CI-compatible.

`make generate-lint` runs `make generate` then `bunx @redocly/cli lint src/lib/api/openapi.json --config redocly.yaml`. CI runs this as a separate "Lint OpenAPI spec" step after the diff check.

Do NOT hand-edit `web/src/lib/api/openapi.{json,yaml}` or `types.ts` - always regenerate from the Go code. The Huma config that drives the spec lives in `internal/api/openapi.go` (`HumaConfig`, `RegisterHumaHandlers`, `DocumentRawRoutes`) and is shared by the runtime server AND `cmd/dumpopenapi`. Update there, then `make generate`.

## Release workflow - order matters

1. Bump `version.go` (`const Version`)
2. `make generate` - re-generates `web/src/lib/api/{openapi.json,openapi.yaml,types.ts}` from Go code
3. `make generate-lint` - redocly spectral lint on the spec (catches schema bugs before CI)
4. `make build-frontend` - produces `web/dist/` for `static.go` to embed
5. `make lint && make test-unit` - green required
6. `git add -A && git commit` - stage and commit ALL changes including generated artifacts
7. `git tag v<N> && git push && git push --tags`

**Why order matters:**
- CI lint runs `make generate` then `git diff --exit-code` on **all three** generated files (json, yaml, types.ts). Any stale artifact breaks lint.
- CI also runs `make generate-lint` (redocly) as a separate step - schema errors fail the build.
- `go vet` reads `static.go` which embeds `web/dist`. No dist -> vet fails.
- `release.yml` on `v*` tag builds + pushes multi-arch image to `ghcr.io/erfianugrah/composer:<tag>`.

## Repo layout (one-line each)

```
cmd/composerd/        daemon entrypoint  ? DO NOT run on dev machine
cmd/dumpopenapi/      dumps OpenAPI spec to stdout. Flag: -yaml emits YAML (default JSON).
cmd/decryptssh/       SSH key recovery tool (you hope you never need this)
internal/domain/      pure business logic, zero deps (auth/container/event/pipeline/registry/stack)
internal/app/         services: stack, git, pipeline (+ executor + cron scheduler), auth, jobs, etc.
internal/api/         Huma wiring + raw chi routes. Layout:
  api/openapi.go        HumaConfig, RegisterHumaHandlers, DocumentRawRoutes (shared by server + dumpopenapi)
  api/server.go         HTTP server entrypoint
  api/static.go         embeds web/dist
  api/handler/          one file per resource - stack, pipeline, sse, webhook, docker_exec...
  api/dto/              request/response shapes
  api/middleware/       auth, CSRF, rate-limit, audit, problem-details
  api/ws/               raw WebSocket handlers: terminal.go, compose.go
internal/infra/       docker, store, crypto, eventbus, fs, git, notify, registry, sops, cache
web/                  Astro 6 + React 19 frontend
  web/src/lib/api/
    openapi.json        GENERATED (make generate). Do not edit.
    openapi.yaml        GENERATED (make generate). Do not edit.
    types.ts            GENERATED (openapi-typescript). Do not edit.
    errors.ts           Hand-written. RFC 9457 detail/title extractor for fetch responses.
  web/redocly.yaml      Redocly lint config (extends recommended; allows relative \$schema URIs)
e2e/                  Go E2E smoke tests (-tags=e2e)
deploy/               Dockerfile, compose.yaml, entrypoint.sh (PUID/PGID + DOCKER_GID magic)
docs/                 Canonical user/agent documentation
version.go            const Version - bump first on release
```

## Key env vars (subset - full list in docs/configuration.md)

| Var | Notes |
|---|---|
| `COMPOSER_PORT` | default 8080 |
| `COMPOSER_DB_URL` | empty = SQLite (default), or `postgres://...` |
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
