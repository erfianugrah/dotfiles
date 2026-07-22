---
name: docker
description: Use when writing or optimizing a Dockerfile, building or tagging an image for ghcr.io, running buildx (multi-arch, cache mounts, BuildKit secrets or SSH), debugging or inspecting a running container, or managing image layers, storage, and pruning. The container-level work beneath infrastructure-stack (which owns Compose stack authoring) and composer (GitOps deploy) - reach for those instead when the task is a Compose stack rather than an image or container.
---

# docker — Dockerfile + buildx + inspection + registry

Companion to `infrastructure-stack` (Compose patterns) and `composer` (your GitOps platform). This skill is about the *image* + *individual container* layer, not stack composition.

## Where this fits

| Layer | Skill |
|---|---|
| Dockerfile + buildx + image registry + standalone `docker run` + inspection | **this skill (docker)** |
| `docker-compose.yml` patterns + bridge networks + Caddy + static IPs across 12 stacks | `infrastructure-stack` |
| Your GitOps Compose management platform | `composer` |

## Dockerfile — what good looks like

### Multi-stage skeleton (Go example, concrete example)

```dockerfile
# syntax=docker/dockerfile:1.7              # opt into latest BuildKit features
ARG GO_VERSION=1.26

FROM golang:${GO_VERSION}-alpine AS builder
WORKDIR /src

# deps layer: cached across code changes (deps don't change every commit)
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

# source + build
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags='-s -w' \
        -o /out/<app> ./cmd/<app>

# runtime: tiny + non-root + healthcheck
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
USER nonroot:nonroot
COPY --from=builder /out/<app> /usr/local/bin/<app>
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/<app>", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/<app>"]
```

### Layer-ordering rules

1. **Deps before code** — `COPY go.mod go.sum / package.json bun.lockb / Cargo.toml Cargo.lock` first, then `RUN <install>`, then `COPY . .`. Code changes invalidate only the source layer.
2. **One `RUN` per logical step** — but combine adjacent commands (`apt-get update && apt-get install && rm -rf /var/lib/apt/lists/*`) to avoid orphaned cache.
3. **`.dockerignore` is mandatory** — ship one with every project. At minimum: `.git`, `node_modules`, `dist`, `*.log`, `.env*`, `target/`, `__pycache__`, your repo's `tmp/` equivalent. Saves 10-100× context-send size.
4. **`COPY --chown=USER:GROUP`** — set permissions at copy time, not via `RUN chown` (which creates a redundant layer).
5. **Order ARG-bound RUN steps before code COPY** so changing a build arg doesn't invalidate code layers.

### BuildKit features worth using

```dockerfile
# syntax=docker/dockerfile:1.7

# 1. Cache mounts — survive across builds, MUCH faster than COPY/RUN
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates

# 2. Build-time secrets (NOT visible in image layers)
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev
# pass at build: docker buildx build --secret id=npmrc,src=$HOME/.npmrc .

# 3. SSH forwarding for private repos (NOT in image)
RUN --mount=type=ssh \
    git clone git@github.com:<org>/<private-repo>.git /opt/private
# pass at build: docker buildx build --ssh default .

# 4. Heredoc RUN — cleaner multi-line scripts (BuildKit 1.4+)
RUN <<EOF
set -eux
addgroup --system app
adduser --system --ingroup app app
mkdir -p /var/app && chown app:app /var/app
EOF
```

## buildx (the build front-end you actually want)

```bash
# one-time builder setup (uses BuildKit)
docker buildx create --name multi --driver docker-container --bootstrap --use
docker buildx ls

# single-arch local build (fast iteration, --load brings into local docker images)
docker buildx build --platform linux/amd64 -t <app>:dev --load .

# multi-arch build + push (cannot --load with >1 platform — push directly)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<org>/<app>:v1.2.3 \
  -t ghcr.io/<org>/<app>:latest \
  --push \
  .

# with build secrets + ssh + cache to registry
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --secret id=npmrc,src=$HOME/.npmrc \
  --ssh default \
  --cache-from type=registry,ref=ghcr.io/<org>/<app>:buildcache \
  --cache-to type=registry,ref=ghcr.io/<org>/<app>:buildcache,mode=max \
  -t ghcr.io/<org>/<app>:v1.2.3 \
  --push \
  .
```

Common buildx gotchas:
- `--load` only works with **one platform** at a time (docker store doesn't multi-arch). Multi-platform → must `--push` to a registry.
- Cache-to/from with `mode=max` exports ALL layer cache (slower per build, faster on next build). Default `mode=min` only caches the final image layers.
- `--platform` mismatch — if your runtime is arm64 (Mac M-series, Raspberry Pi) but you build amd64 only, `docker run` will silently emulate via qemu (slow). Always include the target arch in your build.

## Image inspection

Token-efficient introspection:

```bash
# layer-by-layer size + commands (no agent-hostile interactive TUI)
docker image history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' ghcr.io/<org>/<app>:latest

# what's actually IN a tag (manifest list for multi-arch)
docker buildx imagetools inspect ghcr.io/<org>/<app>:latest

# raw manifest (digest, layers, config)
docker manifest inspect ghcr.io/<org>/<app>:latest --verbose | jq '.[] | {platform, size}'

# config (env, cmd, entrypoint, exposed ports, healthcheck)
docker inspect <app>:latest --format '{{json .Config}}' | jq

# size + creation date (one-liner)
docker inspect <app>:latest --format '{{.Size}} {{.Created}}'

# TUI for human exploration (skip in agent context)
dive ghcr.io/<org>/<app>:latest
```

## Container debugging — the live one's misbehaving

```bash
# logs (always pair --tail with --follow for sane output)
docker logs --tail 50 --follow <app>-api

# structured timestamp output
docker logs --tail 100 --timestamps <app>-api 2>&1 | rg ERROR

# exec into a running container (root for debug)
docker exec -it -u root <app>-api sh

# exec a one-shot command (no -i -t needed for non-interactive)
docker exec <app>-api ps -ef

# inspect process tree + memory + network
docker top <app>-api
docker stats --no-stream <app>-api
docker inspect <app>-api --format '{{json .NetworkSettings}}' | jq

# copy a file out of a container (e.g. crash dump)
docker cp <app>-api:/var/log/app/crash-123.log /tmp/

# attach to an exited container's filesystem for forensics
docker commit <exited-container-id> forensic:snapshot
docker run --rm -it forensic:snapshot sh
```

## Registry workflows (ghcr.io is your default)

```bash
# auth — uses your gh PAT with write:packages
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
# or via gh CLI:
gh auth token | docker login ghcr.io -u <github-username> --password-stdin

# tag conventions you should be using
docker tag <image> ghcr.io/<org>/<app>:v1.2.3          # immutable
docker tag <image> ghcr.io/<org>/<app>:v1.2             # rolling minor
docker tag <image> ghcr.io/<org>/<app>:latest           # rolling

# push — always include all tags you set
docker push ghcr.io/<org>/<app>:v1.2.3
docker push --all-tags ghcr.io/<org>/<app>

# verify multi-arch after push
docker buildx imagetools inspect ghcr.io/<org>/<app>:v1.2.3
```

`:latest` discipline: per your `infrastructure-stack` skill convention, **never use `:latest` in compose**. The build CAN push `:latest` as a rolling pointer for humans, but compose pins to immutable `:v1.2.3` tags.

## Standalone `docker run` (for debugging, not production — production uses compose)

```bash
# common debug pattern: throwaway alpine to poke at networking
docker run --rm -it --network <network-name> alpine sh -c "apk add curl && curl -sS http://<app>-api:8080/health"

# run a tool from an image without installing locally
docker run --rm -v $(pwd):/work -w /work golangci/golangci-lint:latest golangci-lint run

# constrain resources (test what cgroup limits do)
docker run --rm -it --memory=128m --cpus=0.5 <app>:dev

# read-only fs + minimal capabilities (security)
docker run --rm -it \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 1000:100 \
  <app>:dev
```

## Pruning (reclaim disk safely)

```bash
# safe: only unreferenced dangling images
docker image prune

# AGGRESSIVE: unreferenced + unused tagged images (-a). Read carefully before --force.
docker image prune -a --filter "until=720h"             # only images >30d old

# stopped containers
docker container prune --filter "until=168h"

# unused volumes (DANGEROUS — destroys data)
docker volume ls -f dangling=true
docker volume prune --filter "label!=keep"

# build cache
docker buildx prune --keep-storage=10GB                 # keep most recent 10GB of cache
docker buildx prune -a --force                           # wipe all build cache

# system-wide (everything above + networks)
docker system prune -a --volumes --filter "until=720h"  # use sparingly
```

## Foot-guns (real ones that bite)

- **`COPY` cache invalidation**: changing file mtime invalidates the COPY layer even if content is identical. CI builds often hit this (clean checkout = new mtimes). Fix: `COPY --link` (BuildKit 1.4+) decouples target FS from build cache.
- **`USER` numeric vs name**: k8s pods enforce numeric UIDs. `USER appuser` works in docker but `runAsNonRoot: true` k8s pod will reject if image declares `USER` by name. Always: `USER 1000` or `USER 1000:100`.
- **`ENV` + `ARG` lifetime**: `ARG` exists only during build. `ENV` persists in image. Don't use `ARG SECRET=...` for secrets — use BuildKit `--mount=type=secret`.
- **Health check signal**: if your healthcheck has external deps (DB ping), it'll mark the container "unhealthy" during DB restart even if the app is fine. Make healthchecks return-only-self-status.
- **`docker compose up --build` vs `docker build`**: compose's build is single-platform + no buildx features. For multi-arch / cache-mounts you need `docker buildx build` separately then `docker compose up` with the image tag.
- **Container time zone**: default UTC. If logs need local time, mount `/etc/timezone` + `/etc/localtime`.
- **`docker logs` doesn't capture stderr from PID-1 wrappers** like tini — make sure your entrypoint writes to stdout/stderr, not files.
- **Image size shocker**: distroless `:nonroot` is ~2MB, alpine is ~5MB, debian:slim is ~30MB, ubuntu is ~70MB, full debian is ~100MB+. Pick aggressively.
- **buildx context bloat**: `.dockerignore` not being respected? Run `docker buildx build --progress=plain` and inspect the "transferring context" line — it shows the actual bytes sent.

## Useful one-liners

```bash
# Find the largest images on disk
docker images --format '{{.Size}}\t{{.Repository}}:{{.Tag}}' | sort -h | tail -10

# Which containers are restart-looping?
docker ps -a --format '{{.Status}}\t{{.Names}}' | rg 'Restarting'

# What process is each container running?
docker ps --format '{{.Names}}\t{{.Command}}' | rg -v ^$

# Which image was a running container built from? (sha256)
docker inspect <app>-api --format '{{.Image}}'

# Pull only the manifest (no layers) to verify a tag exists + multi-arch
docker buildx imagetools inspect ghcr.io/<org>/<app>:latest
```

## When to escalate beyond this skill

- **Build is slow but cache is hot** → profile with `docker buildx build --progress=plain` and look at "CACHED" vs "DONE" lines. Look at `infrastructure-stack` for compose-build optimization patterns.
- **Image is too big** → multi-stage isolation + distroless. If it's still big, the runtime deps are the problem; consider statically linking.
- **Push to ghcr fails** → `gh auth refresh -s write:packages`, see `gh` skill for full auth flows.
- **Network weirdness inside a compose stack** → `infrastructure-stack` skill (bridge subnets, static IPs, internal:true networks).
- **Considering moving off Docker to podman / containerd / nerdctl** → most commands above work via aliases, but BuildKit features map differently. Don't migrate without a specific reason.
