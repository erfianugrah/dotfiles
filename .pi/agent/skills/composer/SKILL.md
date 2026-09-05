---
name: composer
description: "Use when deploying, updating, restarting, or removing a Docker Compose stack via the user's Composer REST API; designing or debugging a Composer pipeline (steps replacing cron containers); scripting against the API; or touching composerd source or its Astro frontend. Fires on 'composer', 'composerd', 'deploy the stack', 'composer pipeline', 'composer.erfi.io'. NEVER run composerd on the dev box (it encrypts ~/.ssh at startup). NOT for authoring compose files (infrastructure-stack) or drawbridge."
---

# composer skill

Self-hosted compose-mgmt platform. Go + Astro. REST API only - no end-user CLI. Repo: `/home/erfi/infra/composer`. Daemon: single Go binary `composerd`. Frontend: Astro 6 + React 19 + Tailwind 4 + shadcn (embedded via `static.go`).

## When this skill does NOT apply

Composer (on the **MS-01 NixOS router**, ssh alias `router`, public URL `https://composer.erfi.io`) manages stacks across TWO docker daemons: the MS-01 local socket AND servarr's daemon via the drawbridge mTLS proxy (see the multi-host section). It does NOT see:
- Local dev compose stacks (`~/infra/ai/llm-compose/`, `~/infra/composer/deploy/`, `~/infra/knotea/`, any compose file the user is editing on the dev box).
- Stacks on other servers not registered in the docker-hosts registry.
- Anything reached via plain `docker ...` on the dev machine.
- drawbridge itself - deliberately NOT composer-managed (composer reaches servarr's docker THROUGH drawbridge; composer managing it would be a self-dependency loop). See the drawbridge skill.

For local stacks, use `docker compose -f <path> {logs,ps,restart}` directly. Don't reach for the composer API just because the word "compose" appears -- verify the target host first (`docker context show`, or check whether the container name appears in `curl $COMPOSER/api/v1/services | jq -r '.[].name'`).

**Response shapes differ per endpoint**: `/stacks` returns an OBJECT wrapping
`.stacks[]`, while `/services` returns a bare ARRAY (`.[]`). Copying one
endpoint's filter to the other yields an empty result that reads like "the
thing isn't there" when the filter is simply wrong. When unsure:
`curl ... | jq 'type, keys'` first, one call.

**Conversely, when a stack IS composer-managed (servarr, router-local): NEVER `ssh servarr 'docker compose ...'` or `ssh router 'docker compose ...'`. Use the composer API.** The compose file checkout lives on the ROUTER, not on the target host -- `ssh servarr 'docker compose -f /opt/stacks/...'` fails with "no such file" even though the stack deploys fine through the API. For lifecycle ops (up/down/restart) use the dedicated endpoints (`POST /stacks/{name}/{up,down,restart}?async=true`). For ad-hoc compose commands (force-recreate, exec, logs with custom flags) use `POST /stacks/{name}/exec` with body `{"command": "up -d --force-recreate <svc>"}`. The API routes compose operations to the correct docker daemon (router-local or servarr via drawbridge) and handles SOPS decryption -- raw SSH bypasses both.

## Hard safety rules

- **NEVER run `./composerd` or `go run ./cmd/composerd/` on the dev machine.** Startup hook AES-256-GCM encrypts every key under `$HOME/.ssh` using a key stored in `COMPOSER_DATA_DIR`. Default `COMPOSER_DATA_DIR=/tmp` -> reboot loses the key -> SSH keys unrecoverable. Use `go test`, `make test-unit`, or `docker compose -f deploy/compose.yaml up` (isolated `/home/composer/.ssh`). `cmd/decryptssh/` exists for emergency recovery.
- **CGO must be 0** - pure-Go SQLite (modernc.org/sqlite). The Makefile bakes `CGO_ENABLED=0`. Don't override.

## Canonical references (read these instead of guessing)

| Doc | When |
|---|---|
| `/home/erfi/infra/composer/AGENTS.md` | Agent guide - Safety, Build, Testing, Release, Architecture |
| `/home/erfi/infra/composer/docs/api-reference.md` | Endpoint reference (hand-maintained; `/openapi.json` is the live truth when they disagree) |
| `/home/erfi/infra/composer/docs/configuration.md` | All `COMPOSER_*` env vars |
| `/home/erfi/infra/composer/docs/architecture.md` | DDD layer diagram |
| `/home/erfi/infra/composer/docs/design.md` | Full design spec with domain models |
| `/home/erfi/infra/composer/docs/security.md` | Docker socket, RBAC, encryption, hardening |
| `/home/erfi/infra/composer/docs/deployment.md` | Deployment options per platform |

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
- Version: `const Version` in `version.go` - read it, do not recall it.
- Spec: OpenAPI **3.1.0**. Served at `GET /openapi.json` AND `GET /openapi.yaml`. Interactive docs at `/docs` (Stoplight Elements). All public - no auth.
- Surface: Huma-registered endpoints grouped by tag (count them from `/openapi.json`, the number drifts every release) + a few raw chi routes (WebSocket terminal/compose, OAuth begin/callback, webhook receiver). Tags: system, auth, users, keys, registries, hosts, stacks, git, containers, networks, volumes, images, docker, pipelines, webhooks, jobs, audit, templates, sse, oauth.
- Auth (any of three, all defined in `internal/api/openapi.go`):
  - `cookieAuth` - session cookie `composer_session` via `POST /api/v1/auth/login` (UI flow).
  - `apiKeyAuth` - `X-API-Key: ck_...`. **Preferred for agents.**
  - `bearerAuth` - `Authorization: Bearer ck_...`.
  - Mint via `POST /api/v1/keys` (operator+ role). Shown once - redacted to `****<last4>` after.
- Public endpoints: health, bootstrap, login, templates, openapi spec (JSON+YAML), oauth callbacks, webhook receivers.
- Errors: RFC 9457 Problem Details, content-type `application/problem+json`. 500s include `request_id`. Hand-written client extractor at `web/src/lib/api/errors.ts`.
- Hard limits: Huma 1 MB request body cap. Compose YAML 512 KB. .env 256 KB.

## Multi-host docker daemons (v0.17.0+/v0.18.0+)

One composerd now manages stacks across MULTIPLE docker daemons. The servarr remote endpoint is **drawbridge**, the mTLS+allowlist+audit proxy in front of servarr's `/var/run/docker.sock` (see the drawbridge skill). Hosts register under Settings -> Docker Hosts (name + endpoint + optional mTLS certs).

TLS plumbing internals (do not regress):
- Per-host SDK clients use `TLSConfig{CertDir}` -> `dockerclient.WithTLSClientConfig(ca, cert, key)` with docker-CLI file naming. `FromEnv` BEFORE `WithHost(host)` in `internal/infra/docker/client.go` is load-bearing (the moby SDK does not apply env TLS implicitly; explicit host still wins).
- `docker compose` CLI children get explicit per-host env via `NewComposeTLS` (`internal/infra/docker/compose.go`): DOCKER_TLS_VERIFY=1 + DOCKER_CERT_PATH=<cert_dir>. Relying on composerd's process env is wrong for non-default hosts.
- Client certs can be uploaded via UI/API since v0.25.0: they are AES-256-GCM encrypted in `docker_host_certs` (migration 009) and materialized to `<dataDir>/certs/<host_id>/` on demand - DB certs then WIN over the mounted `cert_dir`. The `/certs:ro` mount remains the legacy fallback and is still required (see upgrade policy below).

Key model:

- `GET/POST /api/v1/hosts`, `GET/PUT/DELETE /api/v1/hosts/{id}` - docker hosts registry. Body: `{name, endpoint, cert_dir}`. Endpoint schemes: `tcp://host:2376` (mTLS), `tcp://host:2375` (plain), `unix:///path.sock`. `cert_dir` holds `ca.pem`/`cert.pem`/`key.pem` (docker CLI convention); empty = no TLS.
- `PUT/GET/DELETE /api/v1/hosts/{id}/certs` (v0.25.0+) - upload/remove mTLS cert material as PEM text `{ca_cert, cert, key}`. Upload validates (PEM parse, cert-key match, chain verify to CA) -> 422 on garbage. GET is metadata-only (`has_certs`, sha256 fingerprint, `not_after`) - key material is never readable. DB certs take precedence over `cert_dir`.
- `POST /api/v1/hosts/{id}/test` (v0.25.0+) - throwaway client + 3s Ping against the CURRENT material; `{ok, error, latency_ms}`. Use this after any cert/host change before trusting deploys.
- `Factory` (internal/infra/docker) caches docker clients + compose per host; `HostService.Update`/`Delete` invalidate that host via `SetCacheInvalidator` - host edits take effect without a restart since v0.25.0 (they required one before).
- The DEFAULT host (composerd's own `COMPOSER_DOCKER_HOST`/socket) is IMPLICIT - no row, API name `"local"`, `stacks.host_id NULL`. `"local"` is a reserved name.
- API references hosts by NAME; DB stores id. Create-stack payloads accept `host: "<name>"`; unknown name = 422. Stack detail responses carry a `host` field.
- ~30 resource endpoints (containers, networks, volumes, images, docker prune/events/builder, SSE logs/stats) take a `?host=<name>` query param; absent = default host.
- Webhook redeploys route to the stack's host. Event listeners fan in one per host (domain events gain `HostName`, empty = default).
- Self-upgrade stays pinned to the default host (helper hardcodes `/var/run/docker.sock`).
- UI: host badge on stack list/detail, host management is a Settings card, docker-host selector on networks/images/volumes pages.

### Deploying to a remote-host stack

- **Push to `main` auto-deploys.** Both servarr-host app stacks have GitHub webhooks with `auto_redeploy=true` (check `GET /api/v1/webhooks`); composer runs sync+up within ~1 min of a push. Manual `POST /api/v1/stacks/<name>/deploy?async=true` (full GitOps pipeline: git pull -> decrypt -> compose pull -> compose up -d -> re-encrypt). Use `up` only to recreate containers for reasons git can't see -- a new `:latest` image ID, or a manual container kill.
- **`up` does NOT build.** A stack service with a `build:` context (e.g. memledger's `ui`) fails `up` with `No such image: <name>:latest` until `POST /api/v1/stacks/<name>/build` has run. Deploy order for such a stack is sync -> build -> up. The webhook sync+up path has the same gap - a git-backed stack with an in-repo `build:` needs the build triggered too.
- **Force-pushes are fine.** Composer's git sync is fetch + hard-reset to origin/branch, so amended/force-pushed commits are pulled correctly.
- **The git checkout lives on the ROUTER** (`/var/lib/composer/stacks/<name>`, container view `/opt/stacks/<name>`), even for servarr-host stacks. There is NO checkout on servarr; compose ops run against servarr's daemon through drawbridge. Bind-mount sources resolve ON THE DAEMON HOST - any host path in a servarr-host stack's compose/.env must be a servarr path on the right tier (`/appdata/<svc>/...` or `/tank/appdata/<svc>/...`; `zfs-storage` skill), e.g. research's `SEARXNG_CONFIG_DIR` override.
- **Images are not built by the webhook.** Hub-pushed images: `make build && make push` BEFORE the git push, else the webhook's up keeps the old `:latest` (`pull_policy: missing` never re-pulls a present tag). Already pushed? `ssh servarr 'docker pull <img>:latest'` then `POST .../up` - compose recreates on image-ID change. LAN-loaded images (`pull_policy: never`, e.g. gumshoe gateway): build on servarr from the dev-box tree (`rsync gateway/ servarr:/tmp/gw/ && ssh servarr 'docker build -t erfianugrah/research-gateway:latest /tmp/gw'`), then `POST .../up`.
- **SOPS `.env`** in a checkout is ciphertext between deploys; composerd decrypts on every up/sync regardless of host. Never run compose directly against any checkout (local `make build`/`up` included) without decrypting first - expect `invalid spec: ENC[AES256_GCM,...]: too many colons`. Restore the committed ciphertext after with `git checkout -- .env`.

## Self-upgrade (v0.16.0+)

Composer can upgrade ITSELF: a `_system` sentinel stack + release webhook trigger pulls the new `ghcr.io/erfianugrah/composer` image and restarts via a helper container (lazy reconciliation - never kills a running helper). Settings-page card in the UI. Web UI also streams all stack actions through a PTY terminal now.

## Instance - on the MS-01 edge router

The production composer instance runs on the MS-01 NixOS router (ssh alias `router`): `https://composer.erfi.io`, key in `COMPOSER_API_KEY` (shell-init exported). Stacks are split between the router-local daemon and the servarr daemon; the `host` field of `GET /stacks` is the live list (counts drift, do not memorise them).

Composer originally ran on servarr; that instance, `composer.servarr.erfi.io`, its Caddyfile entry and DNS are gone, as is the `COMPOSER_EDGE_API_KEY` / `composer.edge.erfi.io` setup. Treat any note mentioning them as historical.

### Upgrade policy (NixOS-pinned, NOT self-upgrade)

The image tag lives in `~/infra/router/configuration.nix` (the flake control plane since 2026-08-01 - the old two-copy router.nix dance is dead). **Before touching it run `git -C ~/infra/router status --short`: if configuration.nix (or anything) is already modified, STOP and ask - someone else's half-done edit is in that tree** (a bump commit once swept 70 unrelated uncommitted lines into itself and `make deploy` shipped them live). Commit the bump with ONLY the tag hunk (`git add -p` or a fresh branch), message `chore: bump composer to vX.Y.Z`, then `make deploy` (push -> router fast-forwards -> rebuild -> eaves doctor). NEVER edit /etc/nixos on the box - the next deploy silently reverts to the repo-pinned tag, which has downgraded a live instance and dropped its `/certs` mount before. Also `sed -i` with no match is a silent no-op - grep-verify after every sed. Self-upgrade via the `_system` stack does NOT apply here (oci-containers unit races the helper; rebuilds revert to the pinned tag).

**Router-local access**: API also at `localhost:8080` on the router:

```bash
ssh router "curl -s -H \"X-API-Key: $COMPOSER_API_KEY\" localhost:8080/api/v1/stacks" | jq -r '.stacks[].name'
# deploy the knotea stack (edge builds from the monorepo checkout):
ssh router "curl -s -X POST -H \"X-API-Key: $COMPOSER_API_KEY\" 'localhost:8080/api/v1/stacks/knotea/up?async=true'"
```

If the key 401s, it was rotated - ASK the user for the current key; do NOT improvise manual git surgery as a first resort. Known-good manual fallback when no key is available (used for the v1.1.5/v1.1.6 edge deploys before the key was at hand): generate a throwaway ed25519 keypair inside the stack checkout, `gh repo deploy-key add` it read-only, `git -c core.sshCommand="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" pull --ff-only`, `docker compose up -d --build` from the checkout, then delete the GH deploy key + `shred -u` the keypair. Why this is needed at all: composerd's startup hook **AES-encrypts every key under its ssh dir at rest** (`/var/lib/composer/ssh/id_github*`), so interactive git/ssh with those keys fails with "invalid format" - only composerd can decrypt and use them. The API is the intended path.

## SOPS decryption and secret rotation

Composer decrypts SOPS-encrypted `.env` files before every `up` or `sync`
operation and re-encrypts them after. The cycle is:

```
decryptSopsSecrets -> docker compose up -> reEncryptSopsSecrets
```

This means `.env` MUST be plaintext during the `docker compose up` call.
Docker compose reads `${POSTGRES_PASSWORD}` and similar directly from the
file -- ciphertext passed as an env-var value is a literal string
(`POSTGRES_DB=ENC[AES256_GCM,data:GBxlkrs=...]`), not a decrypted secret.

### Self-healing (v0.26.10+)

- Re-encrypt no longer runs under the request context. A cancelled/aborted
  WS action (or a stop/restart/pull cleanup) used to skip
  `reEncryptSopsSecrets` and leave `.env` plaintext on disk forever. The
  deferred cleanup now resolves the env file with `context.Background()`.
- A `.env` ALREADY plaintext is re-encrypted in place during the decrypt
  phase (best-effort, only when an age key is available). One
  `up`/`sync`/`restart` therefore repairs files left bare by older versions.

Verify ciphertext with `grep -q sops_version <checkout>/.env` (marker only
present in the encrypted form). Do NOT use `head -c 3 | grep 'ENC\|sops'`:
an encrypted dotenv's first line is the first key name, so that check gives
false "plaintext" positives on every properly encrypted stack.

### Age key resolution order

`LoadGlobalAgeKey` in `internal/infra/sops/agekey.go` resolves the age
private key from (highest priority first):

1. `/opt/composer/age.key` (UI-saved key, non-empty wins over all env vars)
2. `COMPOSER_SOPS_AGE_KEY` env var
3. `SOPS_AGE_KEY` env var
4. `SOPS_AGE_KEYS` env var (multi-line, unescapes `\n`)
5. `COMPOSER_SOPS_AGE_KEY_FILE` env var
6. `SOPS_AGE_KEY_FILE` env var
7. `~/.config/sops/age/keys.txt` (standard SOPS location)

On the router, the composer container has both the `age.key` file AND
`COMPOSER_SOPS_AGE_KEY` set -- the file wins. Both hold the same key
(public key `age132gmayefg7mq9t7fdfh9ppczn009uqyql49yje89fcjcp74v84aq36gu87`).
`$HOME` inside the container is `/root`, so `~/.config/sops/age/keys.txt`
resolves to `/root/.config/sops/age/keys.txt`, **not**
`/home/composer/.config/sops/age/keys.txt`.

### Secret rotation (e.g. POSTGRES_PASSWORD)

Let composerd own the plaintext window; never run compose by hand against a
checkout (that is the skill's first rule, and a hand-run `up` with ciphertext
in `.env` hands postgres `POSTGRES_DB=ENC[AES256_GCM,...]` - healthcheck
fails with `pg_isready: error: invalid connection option`).

1. Rotate the value in the stack's SOPS-encrypted `.env` in its repo
   (`sops .env` on the dev box; generate and hand the value with `secretctl`,
   `secret-handling` skill - never echo it), commit, push. A stack whose
   `.env` lives in composer's DB instead takes `PUT /stacks/{name}/env`.
2. `ALTER ROLE` on the running database FIRST so the live container keeps
   working: `docker exec <pg> psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c
   "ALTER USER ... WITH PASSWORD '...'"` on the daemon host (forgejo's compose
   defaults `POSTGRES_USER`/`POSTGRES_DB` to `forgejo`), via `secretctl exec`
   or `POST /docker/exec` (admin).
3. `POST /stacks/<name>/deploy?async=true` (git-backed: sync + decrypt +
   pull + up + re-encrypt) or `POST /stacks/<name>/up?async=true`; poll
   `/jobs/{id}`.
4. Verify the checkout is ciphertext again: `grep -q sops_version
   /var/lib/composer/stacks/<name>/.env` on the router.

Why the API path is safe: composerd writes plaintext to `.env`, keeps the
original as `.env.sops`, runs compose, then restores from the backup in a
deferred cleanup - a failed `up` still re-encrypts.

## Auth quick-start (agent driving the API)

The production instance is `https://composer.erfi.io` (on the router). **`COMPOSER_API_KEY` is normally already exported in the user's shell init**, so it is in the harness's inherited env. Check with `[ -n "${COMPOSER_API_KEY+x}" ] && echo set` first; if it is unset, get it into the process with `secretctl exec` (`secret-handling` skill) - never print or paste the value.

```bash
# 1. is the key in the inherited env?
[ -n "${COMPOSER_API_KEY+x}" ] && echo set || echo unset

export BASE=https://composer.erfi.io/api/v1

# 3. verify (response is {stacks: [...]} - NOT a bare array)
curl -sf -H "X-API-Key: $COMPOSER_API_KEY" "$BASE/stacks" | jq -r '.stacks[].name' | head

# 4. deploy a stack
curl -sf -X POST -H "X-API-Key: $COMPOSER_API_KEY" \
  "$BASE/stacks/my-stack/up?async=true" | jq .job_id
```

### Response shape - list endpoints wrap in an envelope

`GET /api/v1/stacks` returns `{$schema, stacks: [...]}`, NOT a bare array. Same pattern on most list endpoints. The agent's reflex `jq '.[].name'` fails with "Cannot index string with string" or "Cannot iterate over object". Always check shape first: `jq 'type, keys?'`. The single-resource `GET /api/v1/stacks/{name}` returns the resource object directly (no envelope).

### Env propagation gotcha

The harness's shell tool inherits the environment of the harness PROCESS, not of the terminal you export things in afterwards. A var exported interactively after launch is invisible until the harness is restarted (or the export is re-run inside the tool). `COMPOSER_API_KEY` comes from shell init, so it normally IS present from launch - verify before assuming it isn't.

### Failure modes

- Empty `$COMPOSER_API_KEY` - curl sends `X-API-Key:` (no value), server returns 401. The 401 body is JSON, downstream `jq '.[]'` blows up. Use `curl -sf` and inspect before piping.
- Wrong host - `composer.erfi.dev` does not exist and `composer.servarr.erfi.io` no longer resolves; the host is `composer.erfi.io`.

For async ops, poll `GET /api/v1/jobs/{id}`. Jobs auto-cleanup after 1h. Max 100 listed. A harness's background-process waiter knows nothing about composer job ids - poll `/jobs/{id}` directly.

## WAF in front of composer - mutating requests with credential-shaped bodies can be blocked

The edge Caddy/WAF fronting `composer.erfi.io` has a credential-detection rule that returns 403 (an HTML page, not `application/problem+json`) on PUT/POST bodies containing token-like or password-like strings. **The request never reaches composerd.** It does not fire on every such body - a 2026-09-05 probe with a password + `ghp_` token JSON body got composerd's own 401 - so treat a 403 HTML page as the tell, not a certainty. It has bitten on:

- `PUT /api/v1/stacks/{name}/env` with any `.env` containing real tokens (Discord bot token, Spotify client secret, anything matching the rule's heuristics)
- `POST /api/v1/stacks/git` with credentialed `repo_url`
- `POST /api/v1/keys` rotation

**Reliable workaround**: bypass the public WAF by hitting composerd directly on the router:

```bash
# router-local access, no WAF in the path
ssh router "curl -sf -X PUT \
  -H 'X-API-Key: $COMPOSER_API_KEY' \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  http://localhost:8080/api/v1/stacks/<name>/env" <<< "$PAYLOAD"
```

servarr-host stacks are managed the same way - composerd on the router talks to servarr's daemon over drawbridge, so `ssh router` + `localhost:8080` covers every stack.

GETs work fine through the public WAF. Only PUT/POST/DELETE with credential-like bodies trip it.

**Incoming webhook deliveries hit the WAF too.** GitHub push/ping deliveries to `POST /api/v1/hooks/{id}` are subject to the same Caddy WAF (ddos-mitigator rate rule). Under a burst (e.g. registering + test-pinging many hooks at once) some return `403` and **never reach composerd** - the tell is `GET /webhooks/{id}/deliveries` showing `deliveries: []` while GitHub's `last_response.code` is `403`. It is NOT per-repo config and NOT payload content (the same payload flips 403->200 on retry). Real single pushes usually land (GitHub retries with backoff), but the durable fix is a Caddy path exemption for `/api/v1/hooks/*` (see caddy skill's `@public path /api/* /webhooks/*` pattern). GitHub can't send the `Mozilla`+`Origin` bypass headers, so path-exemption is the only option for inbound hooks.

## Roles

- **Admin** - everything. Required for: user/key/system mgmt, `shell_command` + `docker_exec` pipeline steps, `POST /docker/exec`.
- **Operator** - stack CRUD, deploy, terminal, pipelines, webhooks, registries.
- **Viewer** - read-only.

## Stack lifecycle

CRUD: `GET/POST /stacks`, `POST /stacks/git` (clone repo), `POST /stacks/import` (Dockge dir), `GET/PUT/DELETE /stacks/{name}`, `PUT /stacks/{name}/env`.

Lifecycle: `POST /stacks/{name}/{up|build|down|restart|pull|deploy}` -- all support `?async=true` returning `{job_id}`. Sync mode blocks until done (subject to 1 MB resp cap on logs). `up` = `compose up -d` only. `deploy` = full GitOps pipeline (git pull -> decrypt -> `compose pull` -> `compose up -d` -> re-encrypt).

Other: `POST /validate`, `POST /exec` (run `docker compose <cmd>`), `POST /convert/{git,local}` (toggle git-backed <-> local), `GET /diff` (disk vs running config), `GET/PUT /credentials` (per-stack registry).

Name pattern: `^[A-Za-z0-9_-]+$`. Status enum on `StackSummary.Status`. Per-stack locks prevent concurrent lifecycle ops.

## Pipelines - footguns

Schedules use 5-field cron only. **Macros (`@daily`, `@hourly`, `@every 5m`) silently never fire.** Use `0 0 * * *` etc.

Trigger types:
- `manual` - explicit run via `POST /pipelines/{id}/run`
- `webhook` - fires in PARALLEL to GitOps sync. Race-prone for post-deploy work; use `event` instead.
- `schedule` - 5-field cron, scheduler ticks every minute, no overlap (skips if previous still pending/running)
- `event` - subscribes to in-process bus: `stack.{created,deployed,stopped,updated,deleted,error}`. **Use this for post-deploy hooks**, not `webhook`.

Step types (9):
- `compose_{up,down,pull,restart}` - only honours `{"stack": "name"}`. Older fields (`services`, `force_recreate`, `build`) ignored silently, not rejected.
- `shell_command` - admin role required. Env scrubbed to `PATH/HOME=/tmp/HISTFILE=/dev/null/TERM=xterm`. Stdout+stderr capped at 1 MB.
- `docker_exec` - admin role required. Same 1 MB cap.
- `http_request` - **GET only**, 30s fixed timeout, SSRF-protected, body NOT captured (only status code). No headers/method/retries.
- `wait` - sleep step.
- `notify` - **stub. Logs only. Does not deliver.** Don't promise users notifications.

Live run output: SSE at `GET /sse/pipelines/{id}/runs/{runId}`.

## GitOps

Stack-side endpoints: `POST /stacks/{name}/sync` (pull + clear dirty flag), `POST /stacks/{name}/deploy` (full pipeline: sync + decrypt + pull + up + re-encrypt), `GET /stacks/{name}/git/{log,status,diff}`, `POST /stacks/{name}/rollback` (checkout SHA).

### Repointing a stack to a DIFFERENT repo URL: convert does NOT clone

`convert/local` then `convert/git` looks like the way to change a stack's repo, but **`ConvertToGit` never clones** - it only writes the git config and falsely marks `sync_status: synced`. The on-disk dir keeps the OLD working-tree files and has no `.git`, so the next `sync` fails `500 "pulling: opening repo: repository does not exist"`. Cloning happens ONLY in the `POST /stacks/git` create path. And you can't hand-clone via `docker exec` either: composer's SSH keys are **AES-encrypted at rest**, usable only in-process by go-git.

The only working repoint is **delete + recreate** (brief downtime; fine for periodic jobs). Preserve the encrypted `.env` across it - `GET /stacks/{name}` returns `env_content` in PLAINTEXT, so capture it first, then restore via the internal-network PUT (token body trips the WAF - see WAF section):

```bash
ENV=$(curl -sf -H "X-API-Key: $KEY" "$BASE/stacks/<name>" | jq -r .env_content)   # real values
curl -sf -X DELETE -H "X-API-Key: $KEY" "$BASE/stacks/<name>"                      # downs + rm dir + DB row
curl -sf -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"<name>","repo_url":"git@github.com:o/NEW.git","branch":"main","compose_path":"compose.yaml","env_path":".env","auth_method":"none"}' \
  "$BASE/stacks/git"                                                               # clones fresh
# restore env via internal net (WAF), then POST /stacks/<name>/up?async=true
```

Delete also drops the stack's webhook - recreate it after (composer `POST /webhooks` + the matching GitHub repo hook).

### Stack location on disk - host vs container view

Two paths, easy to confuse:

| Path | What it is |
|---|---|
| `/var/lib/composer/stacks/<name>/` | **Host layout** - source of truth on the MS-01 router (`ssh router`). |
| `/opt/stacks/<name>/` | **In-container view** - composer's container bind-mounts `/var/lib/composer/stacks` to `/opt/stacks` (`COMPOSER_STACKS_DIR=/opt/stacks` inside). The API's stack-object `path` field reports this in-container path. |

Neither path exists on servarr, and app data dirs (`/appdata/<name>`, `/tank/appdata/<name>`) are the STACK's bind-mounts, not composer's. Verify the bind-mount: `ssh router 'docker inspect composer --format "{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}"'`.

### Creating a git-backed stack

Most stacks here are git-backed. The pattern:

```bash
# 1. POST /stacks/git - composer clones into /var/lib/composer/stacks/<name>/
#    on the router (container view /opt/stacks/<name>/)
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
rsync -a ./local-data/ servarr:/appdata/<name>/runtime-data/   # tier per zfs-storage

# 3. PUT /stacks/{name}/env - .env is stored in composer's encrypted DB,
#    materialized next to compose.yaml on every reconcile.
#    See the WAF section above - if env contains tokens, use the internal-network
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

The `.env` is **gitignored in the repo by design** - it lives in composer's encrypted DB and is materialized to disk only at reconcile time. Don't try to commit it; don't try to scp it next to compose.yaml.

**Exception + footgun:** a stack whose `.env` is NOT in composer's DB (stack created without `env_path` content, so the on-disk `.env` is the ONLY copy) loses that file on EVERY git-sync of the checkout - the push-triggered auto-sync (if `auto_sync=true`) AND manual `pull`/`up` all fast-forward to `origin/main` and git-clean untracked files. The sync also means the checkout is NOT manually-managed: hand edits to `compose.yaml` on disk are silently reverted to `origin/main` on the next sync, so change the repo and push instead. If the `.env` was wiped, `up` fails with `env file /opt/stacks/<name>/.env not found` while the running container keeps working (env baked at create time) - recreate the `.env` (extract from the running container's env, never print it) after every push and always before an `up`.

Webhook delivery (incoming): `POST /api/v1/hooks/{id}` (public, HMAC-validated). Supports GitHub (`X-Hub-Signature-256`), GitLab (`X-Gitlab-Token`), Forgejo (`X-Forgejo-Signature` [unverified]), Generic.

Webhook CRUD: `GET/POST /webhooks`, `GET/PUT/DELETE /webhooks/{id}`, `GET /webhooks/{id}/deliveries`. Secret returned plaintext **once** on POST, redacted to `****<last4>` after.

## Real-time streams

- SSE: `/sse/events` (global), `/sse/containers/{id}/{logs,stats}`, `/sse/stacks/{name}/logs`, `/sse/pipelines/{id}/runs/{runId}`
- WebSocket terminal: `/api/v1/ws/terminal/{containerId}?shell=/bin/sh&cols=80&rows=24` - operator+. Raw chi handler (not Huma).
- WebSocket compose actions: `/api/v1/ws/stacks/{name}/action` - operator+. PTY-streamed progress for `compose pull` / `compose up` (added in `internal/api/ws/compose.go`). Raw chi handler. Use for live deploy progress in scripts/UI instead of polling `/jobs/{id}`.

## Building, releasing, repo layout

`dev.md` - make targets, what `make generate` emits, release order, repo layout, `COMPOSER_*` env-var table. Read when touching composerd source or cutting a release. Quick rules: `CGO_ENABLED=0` always; integration tests run `-p 1`; never hand-edit the generated `web/src/lib/api/{openapi.json,openapi.yaml,types.ts}`.

## When the LLM should ask vs proceed

- **Proceed:** API queries (curl GET), stack listing, pipeline status checks, reading config/docs, planning changes.
- **Ask first:** any `DELETE`, `POST /stacks/.../down`, pipeline `cancel`, `POST /docker/exec` (raw docker on host), webhook deletion, role changes, `make docker` build. These are mutating + recoverability is limited.

## Tool-routing for composer questions

1. Source-of-truth spec -> `curl $COMPOSER/openapi.json | jq` (or `localhost:8080` in dev). Do NOT guess endpoint shapes.
2. Architecture / design -> `read /home/erfi/infra/composer/docs/architecture.md` or `docs/design.md`.
3. Endpoint reference -> `read /home/erfi/infra/composer/docs/api-reference.md`.
4. Code spelunking -> `grep` / `lsp` on `internal/{domain,app,api,infra}/`. Use `lsp` for symbol navigation (Go LSP is accurate).
5. NEVER bash-run `./composerd`. NEVER `go run ./cmd/composerd/`.

## Request-path invariant (v0.25.0+)

Read endpoints never call a docker daemon synchronously. A background
`StatusRefresher` (15s tick, `COMPOSER_STATUS_REFRESH_MS`) fans out to all
hosts concurrently under a 3s per-host timeout and snapshots per-stack
counts + derived status + per-host reachability in memory; GET
/api/v1/stacks serves DB + snapshot only. A dead host shows
`unknown`/stale, it does not stall the response. Regression class to
avoid: a live `factory.ClientFor` / `docker.ListContainers` call re-added
to any GET handler's request path - put the data in the refresher
snapshot instead (v0.25.2 rechecked this exact bug after the handler was
moved to snapshot; the fan-out had moved one layer down into
StackService.List and sensors that grep the handler stayed green).

## Encryption key rotation (v0.26.0+)

The at-rest key (env `COMPOSER_ENCRYPTION_KEY` /
`$COMPOSER_DATA_DIR/encryption.key`) encrypts every stored secret
(AES-256-GCM, `enc:` prefix). Precedence: key file > env > auto-generated -
the UI-settable key file wins. Rotate via Settings -> System -> Encryption
Key Rotation, or `POST /api/v1/system/config/encryption-key/rotate` (admin).
It re-encrypts every `enc:` value + SSH deploy keys + git token in ONE
transaction, then swaps the key; the response returns the new key once
(back it up). NEVER rotate by hand-editing the key file without the
re-encrypt - that bricks every stored secret.
