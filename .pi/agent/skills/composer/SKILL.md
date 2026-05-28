---
name: composer
description: "Manage Docker Compose stacks on the user's self-hosted Composer platform (repo at `~/composer/`, instance at `composer.erfi.io`). Fires on deploying / updating / restarting / removing a stack via API; on designing, scheduling, debugging, or replacing cron containers with a Composer pipeline (multi-step shell_command / docker_exec / http_request flows); on querying or scripting against the Composer REST API; on touching `composerd` source or the Astro frontend; on the release workflow. Covers ~109 endpoints under /api/v1, auth (API keys / cookies / first-admin bootstrap), pipeline step footguns (env-var passing, jq+curl inside shell_command, GITEA_TOKEN handling), and the hard 'NEVER run composerd on the dev box — startup hook AES-encrypts ~/.ssh' safety rule."
---

# composer skill

Self-hosted compose-mgmt platform. Go + Astro. REST API only — no end-user CLI. Repo: `/home/erfi/composer`. Daemon: single Go binary `composerd`. Frontend: Astro 6 + React 19 + Tailwind 4 + shadcn (embedded via `static.go`).

## When this skill does NOT apply

Composer manages a single set of stacks on the **servarr** host. It does NOT see:
- Local dev compose stacks (`~/llm-compose/`, `~/composer/deploy/`, `~/knot-fly/`, any compose file the user is editing on the dev box).
- Stacks on other servers the user hasn't onboarded.
- Anything reached via plain `docker ...` on the dev machine.

For local stacks, use `docker compose -f <path> {logs,ps,restart}` directly. Don't reach for the composer API just because the word "compose" appears — verify the target host first (`docker context show`, or check whether the container name appears in `curl $COMPOSER/api/v1/services | jq -r '.[].name'`).

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

When the API spec matters, the **live source of truth** is the daemon itself. Both JSON and YAML are served publicly:

```bash
curl -s $COMPOSER/openapi.json | jq '.paths | keys'   # endpoint list
curl -s $COMPOSER/openapi.json | jq '.paths."/api/v1/stacks/{name}".put'
curl -s $COMPOSER/openapi.yaml | yq '.paths'           # YAML view
# interactive: open $COMPOSER/docs in browser
# Set COMPOSER=https://composer.erfi.io first.
```

## API basics

- Base: `$COMPOSER/api/v1` (prod, your deployed instance). Local dev: `localhost:8080/api/v1`.
- Version constant: `0.14.0` (`version.go`).
- Spec: OpenAPI **3.1.0**. Served at `GET /openapi.json` AND `GET /openapi.yaml`. Interactive docs at `/docs` (Stoplight Elements). All public — no auth.
- Surface: **106 Huma-registered endpoints** under 19 tags + a few raw chi routes (WebSocket terminal/compose, OAuth begin/callback, webhook receiver). Tags: system, auth, users, keys, registries, stacks, git, containers, networks, volumes, images, docker, pipelines, webhooks, jobs, audit, templates, sse, oauth.
- Auth (any of three, all defined in `internal/api/openapi.go`):
  - `cookieAuth` — session cookie `composer_session` via `POST /api/v1/auth/login` (UI flow).
  - `apiKeyAuth` — `X-API-Key: ck_…`. **Preferred for agents.**
  - `bearerAuth` — `Authorization: Bearer ck_…`.
  - Mint via `POST /api/v1/keys` (operator+ role). Shown once — redacted to `****<last4>` after.
- Public endpoints: health, bootstrap, login, templates, openapi spec (JSON+YAML), oauth callbacks, webhook receivers.
- Errors: RFC 9457 Problem Details, content-type `application/problem+json`. 500s include `request_id`. Hand-written client extractor at `web/src/lib/api/errors.ts`.
- Hard limits: Huma 1 MB request body cap. Compose YAML 512 KB. .env 256 KB.

## Auth quick-start (agent driving the API)

The production instance is `composer.erfi.io`. **`COMPOSER_API_KEY` is normally already exported in the user's shell** (sourced from Vaultwarden by the user's zsh init). Check `env | grep COMPOSER` first — only fall back to `bw get` if the env is empty.

```bash
# 1. is the key already in pi's inherited env?
env | grep -i ^COMPOSER_API_KEY | sed 's/=.*/=<set>/'

# 2. only if missing: pull from Vaultwarden (vault.erfi.io)
bw status | jq -r .status        # 'unlocked' | 'locked' | 'unauthenticated'
bw unlock                        # if locked; pi cannot consume BW_SESSION exported in YOUR
                                 # interactive shell after pi started — see "env propagation" below
export COMPOSER_API_KEY=$(bw get password composer-api-key)

export BASE=https://composer.erfi.io/api/v1

# 3. verify (response is {stacks: [...]} — NOT a bare array)
curl -sf -H "X-API-Key: $COMPOSER_API_KEY" "$BASE/stacks" | jq -r '.stacks[].name' | head

# 4. deploy a stack
curl -sf -X POST -H "X-API-Key: $COMPOSER_API_KEY" \
  "$BASE/stacks/my-stack/up?async=true" | jq .job_id
```

### Response shape — list endpoints wrap in an envelope

`GET /api/v1/stacks` returns `{$schema, stacks: [...]}`, NOT a bare array. Same pattern on most list endpoints. The agent's reflex `jq '.[].name'` fails with "Cannot index string with string" or "Cannot iterate over object". Always check shape first: `jq 'type, keys?'`. The single-resource `GET /api/v1/stacks/{name}` returns the resource object directly (no envelope).

### Env propagation gotcha

Pi's `bash` tool spawns a fresh subshell from pi's parent process — it does NOT see env vars exported in the user's tmux/terminal AFTER pi started. If the user runs `bw unlock` interactively post-pi-launch, pi never sees the resulting `BW_SESSION`. Two workarounds: (a) the user pastes the `export ...` line into pi as a bash command, (b) the user restarts pi after unlocking. Memory-of-fact: **`COMPOSER_API_KEY` is exported by the user's shell init**, so it normally IS in pi's env from launch — verify with `env | grep ^COMPOSER` before assuming it isn't.

### Failure modes

- Empty `$COMPOSER_API_KEY` — curl sends `X-API-Key:` (no value), server returns 401. The 401 body is JSON, downstream `jq '.[]'` blows up. Use `curl -sf` and inspect before piping.
- Wrong host — `composer.erfi.dev` does not exist; correct host is `composer.erfi.io`.
- Vault locked — `bw get` returns nothing, key stays empty.

For async ops, poll `GET /api/v1/jobs/{id}`. Jobs auto-cleanup after 1h. Max 100 listed. **`bg_wait` does NOT work on composer job_ids** — bg_wait is for pi-spawned tmux sessions only. Poll `/jobs/{id}` directly.

## WAF on composer.erfi.io — mutating requests with credential-shaped bodies are blocked

Caddy WAF in front of composer.erfi.io has a credential-detection rule that returns 403 (HTML page) on PUT/POST bodies containing token-like or password-like strings. **The request never reaches composerd.** This bites on:

- `PUT /api/v1/stacks/{name}/env` with any `.env` containing real tokens (Discord bot token, Spotify client secret, anything matching the rule's heuristics)
- `POST /api/v1/stacks/git` with credentialed `repo_url`
- `POST /api/v1/keys` rotation

**Reliable workaround**: bypass the public WAF by reaching composer over the internal docker network from servarr itself.

```bash
# composer's internal IP on its bridge network
COMPOSER_IP=$(ssh servarr 'docker inspect composer --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"')

# proxy the mutating request through ssh
ssh servarr "curl -sf -X PUT \
  -H 'X-API-Key: $COMPOSER_API_KEY' \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  http://$COMPOSER_IP:8080/api/v1/stacks/<name>/env" <<< "$PAYLOAD"
```

GETs work fine through the public WAF. Only PUT/POST/DELETE with credential-like bodies trip it. There's a separate, looser WAF rule that adding `User-Agent: Mozilla/5.0` + `Origin: https://composer.erfi.io` headers bypasses — use that first; only fall through to the internal-network workaround when the credential-detection rule fires.

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

### Stack location on disk — host vs container view

Two paths, easy to confuse:

| Path | What it is |
|---|---|
| `/mnt/user/composer/stacks/<name>/` | **Host source-of-truth** on servarr (Unraid user share). Where composer clones git repos, writes the materialized `.env`, and where you `rsync` runtime data. SSH'd file ops use this path. |
| `/opt/stacks/<name>/` | **In-container view** — composer's container bind-mounts `/mnt/user/composer/stacks` to `/opt/stacks` (`COMPOSER_STACKS_DIR=/opt/stacks` inside). The API's stack-object `path` field reports this in-container path. |
| `/mnt/user/appdata/<name>/` | **NOT used.** That's a generic Unraid template-app convention; composer doesn't write here. Don't go looking. |

Verify the bind-mount on a given deployment: `ssh servarr 'docker inspect composer --format "{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}"'`.

### Creating a git-backed stack

Most stacks here are git-backed. The pattern (verified end-to-end against discord-wipe deployment):

```bash
# 1. POST /stacks/git — composer clones into /mnt/user/composer/stacks/<name>/
curl -sf -X POST -H "X-API-Key: $COMPOSER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "<name>",
    "repo_url": "git@github.com:<owner>/<repo>.git",
    "branch": "main",
    "compose_path": "compose.yaml",   # or "deploy/compose.yaml" if nested
    "env_path": ".env",
    "auth_method": "none"               # or "ssh" with key_id
  }' \
  "$BASE/stacks/git"

# 2. (optional) rsync runtime data into a gitignored subdir before bringing up
rsync -a ./local-data/ servarr:/mnt/user/composer/stacks/<name>/runtime-data/

# 3. PUT /stacks/{name}/env  — .env is stored in composer's encrypted DB,
#    materialized next to compose.yaml on every reconcile.
#    See the WAF section above — if env contains tokens, use the internal-network
#    workaround.
PAYLOAD=$(jq -nc --arg env "FOO=bar\nTOKEN=...\n" '{env: $env}')
curl -sf -X PUT -H "X-API-Key: $COMPOSER_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD" \
  "$BASE/stacks/<name>/env"

# 4. up
curl -sf -X POST -H "X-API-Key: $COMPOSER_API_KEY" \
  "$BASE/stacks/<name>/up?async=true" | jq .job_id
```

The `.env` is **gitignored in the repo by design** — it lives in composer's encrypted DB and is materialized to disk only at reconcile time. Don't try to commit it; don't try to scp it next to compose.yaml.

### `rg` not on servarr

Unraid's stock environment ships `grep` / `awk` / `sed` but **not ripgrep**. Don't pipe `ssh servarr 'rg ...'` — it returns `rg: command not found`. Use `grep -E` / `grep -P` over SSH; ripgrep is fine on the dev box.

Webhook delivery (incoming): `POST /api/v1/hooks/{id}` (public, HMAC-validated). Supports GitHub (`X-Hub-Signature-256`), GitLab (`X-Gitlab-Token`), Gitea (`X-Gitea-Signature`), Generic.

Webhook CRUD: `GET/POST /webhooks`, `GET/PUT/DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries`. Secret returned plaintext **once** on POST, redacted to `****<last4>` after.

## Real-time streams

- SSE: `/sse/events` (global), `/sse/containers/{id}/{logs,stats}`, `/sse/stacks/{name}/logs`, `/sse/pipelines/{id}/runs/{runId}`
- WebSocket terminal: `/api/v1/ws/terminal/{containerId}?shell=/bin/sh&cols=80&rows=24` — operator+. Raw chi handler (not Huma).
- WebSocket compose actions: `/api/v1/ws/stacks/{name}/action` — operator+. PTY-streamed progress for `compose pull` / `compose up` (added in `internal/api/ws/compose.go`). Raw chi handler. Use for live deploy progress in scripts/UI instead of polling `/jobs/{id}`.

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
make generate           # OpenAPI JSON + YAML + TS client
make generate-lint      # generate + redocly spectral lint (web/redocly.yaml)
make docker             # docker build -f deploy/Dockerfile -t composer:local .
```

Integration tests **must run with `-p 1`** (sequential, Docker testcontainers).

### `make generate` — what it actually does

Emits **three** artifacts (was two before May 2026):

1. `web/src/lib/api/openapi.json` — from `go run ./cmd/dumpopenapi`
2. `web/src/lib/api/openapi.yaml` — from `go run ./cmd/dumpopenapi -yaml` (NEW)
3. `web/src/lib/api/types.ts` — from `bunx openapi-typescript`

All three are diff-checked in CI (`make generate` then `git diff --exit-code` on all three). Stale spec OR stale YAML OR stale types.ts breaks lint.

`scripts/generate-client.sh` is an alternate entry point but emits only JSON + types.ts (no YAML) — use `make generate` to stay CI-compatible.

`make generate-lint` is a new target that runs `make generate` then `bunx @redocly/cli lint src/lib/api/openapi.json --config redocly.yaml`. CI runs this as a separate "Lint OpenAPI spec" step after the diff check.

Do NOT hand-edit `web/src/lib/api/openapi.{json,yaml}` or `types.ts` — always regenerate from the Go code. The Huma config that drives the spec lives in `internal/api/openapi.go` (`HumaConfig`, `RegisterHumaHandlers`, `DocumentRawRoutes`) and is shared by the runtime server AND `cmd/dumpopenapi`. Update there, then `make generate`.

## Release workflow — order matters

1. Bump `version.go` (`const Version`)
2. `make generate` — re-generates `web/src/lib/api/{openapi.json,openapi.yaml,types.ts}` from Go code
3. `make generate-lint` — redocly spectral lint on the spec (catches schema bugs before CI)
4. `make build-frontend` — produces `web/dist/` for `static.go` to embed
5. `make lint && make test-unit` — green required
6. `git add -A && git commit` — stage and commit ALL changes including generated artifacts
7. `git tag v<N> && git push && git push --tags`

**Why order matters:**
- CI lint runs `make generate` then `git diff --exit-code` on **all three** generated files (json, yaml, types.ts). Any stale artifact breaks lint.
- CI also runs `make generate-lint` (redocly) as a separate step — schema errors fail the build.
- `go vet` reads `static.go` which embeds `web/dist`. No dist → vet fails.
- `release.yml` on `v*` tag builds + pushes multi-arch image to `ghcr.io/erfianugrah/composer:<tag>`.

## Repo layout (one-line each)

```
cmd/composerd/        daemon entrypoint  ← DO NOT run on dev machine
cmd/dumpopenapi/      dumps OpenAPI spec to stdout. Flag: -yaml emits YAML (default JSON).
cmd/decryptssh/       SSH key recovery tool (you hope you never need this)
internal/domain/      pure business logic, zero deps (auth/container/event/pipeline/registry/stack)
internal/app/         services: stack, git, pipeline (+ executor + cron scheduler), auth, jobs, etc.
internal/api/         Huma wiring + raw chi routes. Layout:
  api/openapi.go        HumaConfig, RegisterHumaHandlers, DocumentRawRoutes (shared by server + dumpopenapi)
  api/server.go         HTTP server entrypoint
  api/static.go         embeds web/dist
  api/handler/          20+ files — stack, pipeline, sse, webhook, docker_exec… (was a single dir before)
  api/dto/              request/response shapes
  api/middleware/       auth, CSRF, rate-limit, audit, problem-details
  api/ws/               raw WebSocket handlers: terminal.go, compose.go (NEW)
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
version.go            const Version — currently 0.14.0; bump first on release
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

1. Source-of-truth spec → `curl $COMPOSER/openapi.json | jq` (or `localhost:8080` in dev). Do NOT guess endpoint shapes.
2. Architecture / design → `read /home/erfi/composer/docs/architecture.md` or `docs/design.md`.
3. Endpoint reference → `read /home/erfi/composer/docs/api-reference.md`.
4. Code spelunking → `grep` / `lsp` on `internal/{domain,app,api,infra}/`. Use `lsp` for symbol navigation (Go LSP is accurate).
5. NEVER bash-run `./composerd`. NEVER `go run ./cmd/composerd/`.
