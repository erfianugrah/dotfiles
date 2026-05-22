---
name: infrastructure-stack
description: Deploy and architect self-hosted services using Docker Compose with bridge-network + static-IP + host-mode-Caddy reverse-proxy conventions (the user's established pattern across ~12 compose stacks). Covers per-stack AGENTS.md template, subnet allocation, expose vs ports, bind-mounts, PUID/PGID, health checks, resource limits, internal-only networks, cross-stack shared networks, secrets, and backups. Includes when-to-graduate-to k3s/k8s and Proxmox VM patterns. Use when starting a new compose stack, modifying networking, integrating with Caddy, or deciding compose vs k8s vs VM.
---

# Infrastructure — Compose-first, k3s/VMs as escalation

The user runs ~12 self-hosted services as discrete Docker Compose stacks. Every stack follows the same conventions. This skill encodes them.

## Convention summary (read this first)

1. **One stack per service** under `~/<svc>-compose/` with `docker-compose.yml` + `AGENTS.md` + optional `MIGRATION_*.md` planning docs.
2. **Each stack gets a dedicated bridge network** with a `/24` subnet (or `/28` for small stacks) and **static `ipv4_address` assignments** per container.
3. **No port publishing for backend services** — use `expose: <port>` only. Public exposure happens at Caddy in another stack.
4. **Caddy runs in `network_mode: host`** in `~/ergo/caddy-compose/` and reverse-proxies to the bridge static IPs via kernel routing.
5. **Caddyfile pins to static IPs**, not service hostnames (e.g. `reverse_proxy 172.19.1.2:7878`).
6. **Bind-mounts over named volumes** for bulk data; absolute host paths only.
7. **PUID/PGID/UMASK = 1000/100/0002** on LinuxServer.io images. Containers that don't honour them use `user: 1000:100`.
8. **Per-service `healthcheck:`** with `CMD-SHELL` curl probe + 30s interval / 3 retries.
9. **`deploy.resources.limits`** for CPU + memory on every service.
10. **`internal: true`** on networks that should never see external traffic (DB + cache behind a service).
11. **Cross-stack shared networks** for services that need to consume across boundaries (e.g. `media` network for jellyfin consumers).

## Subnet allocation

The user's existing `/24` allocations under the `172.19.0.0/16` block. **When adding a new stack, pick the next unused `/24` and document it in your stack's `AGENTS.md`.**

| Subnet | Stack | Notes |
|---|---|---|
| `172.19.1.0/24` | servarr | Sonarr, Radarr, Bazarr, Jellyfin, etc. |
| `172.19.2.0/24` | servarr/tracearr_backend | `internal: true` |
| `172.19.4.0/24` | vaultwarden | |
| `172.19.12.0/24` | keycloak | Auth IdP |
| `172.19.22.0/24` | immich | |
| `172.19.30.0/24` | servarr/media | Cross-stack shared (jellyfin consumers) |
| `172.19.98.0/24` | (caddy upstream) | |
| `172.19.99.0/24` | caddy/forward_auth_net | Authelia + Caddy WAF |
| `172.40.0.0/28` | gitea | Older /28 — keep as-is, don't replicate |
| Free | `172.19.5-11.0/24`, `172.19.13-21.0/24`, `172.19.23-29.0/24`, `172.19.31-97.0/24` | Pick any |

## docker-compose.yml template

Copy this and rename. Replace `myservice`, `172.19.X` subnet, and image.

```yaml
services:
  myservice:
    container_name: myservice
    hostname: myservice
    restart: unless-stopped
    image: vendor/image:VERSION   # ALWAYS pin a tag, never :latest in prod
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 512M
    expose:
      - 8080
    environment:
      - PUID=1000
      - PGID=100
      - UMASK=0002
      - TZ=Asia/Singapore
    volumes:
      - /mnt/user/data/myservice/config:/config
      - /mnt/user/data/myservice/data:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8080/healthz || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    networks:
      myservice:
        ipv4_address: 172.19.X.2

  # Optional DB on internal-only network:
  postgres_myservice:
    container_name: postgres_myservice
    hostname: postgres_myservice
    restart: unless-stopped
    image: postgres:18.1-alpine
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 512M
    expose:
      - 5432
    environment:
      POSTGRES_DB: myservice
      POSTGRES_USER: myservice
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes:
      - /mnt/user/data/myservice/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "myservice"]
      interval: 10s
    networks:
      myservice_backend:
        ipv4_address: 172.19.X.10

networks:
  myservice:
    driver: bridge
    ipam:
      config:
        - subnet: 172.19.X.0/24
          gateway: 172.19.X.1
  myservice_backend:
    driver: bridge
    internal: true        # DB only reachable from myservice container
```

## Caddyfile entry

In `~/ergo/caddy-compose/Caddyfile`, add a virtual host pointing to the static IP:

```caddyfile
myservice.erfi.io {
    encode zstd gzip
    reverse_proxy 172.19.X.2:8080 {
        import proxy_headers
    }
    import error_pages
    import site_log myservice
}
```

Reload Caddy after editing (composer auto-sync handles this; or `docker compose -f ~/ergo/caddy-compose/compose.yaml exec caddy caddy reload`).

## Per-stack AGENTS.md template

Every compose stack has its own `AGENTS.md` documenting the conventions. Copy this template:

```markdown
# myservice-compose

<one-line description>. Managed by composer (auto-sync from this repo).

## Topology

| Subnet | CIDR | Purpose |
|---|---|---|
| `myservice` | `172.19.X.0/24` | Main service network |
| `myservice_backend` | `172.19.X+1.0/24` | DB + cache (internal: true) |

Caddy entry: `~/ergo/caddy-compose/Caddyfile` → `myservice.erfi.io` → `172.19.X.2:8080`.

## Static IP allocation in `myservice` (172.19.X.0/24)

| IP | Service |
|---|---|
| .2 | myservice |
| .10 | postgres_myservice |

## Storage layout

- `/mnt/user/data/myservice/config/` — service config
- `/mnt/user/data/myservice/data/` — service data
- `/mnt/user/data/myservice/postgres/` — Postgres data

## Secrets

Sourced from `.env` (not committed). Vaultwarden vault has the canonical copies under `myservice/<key>`.

## Health checks

- `myservice`: `curl /healthz`
- `postgres_myservice`: `pg_isready`

## Upgrade procedure

1. Bump image tag in `docker-compose.yml`.
2. Commit + push (composer pulls automatically).
3. `composer reload myservice` (or `docker compose pull && up -d` on host).
4. Verify `<svc>.erfi.io` returns 200.
```

## Common pitfalls

- **`ports: "8080:8080"` for backend services**: don't. Caddy host-mode reaches static IPs directly. Publishing ports adds unnecessary attack surface and can collide with host services. Only publish ports for services that need direct external access (rare — Caddy is the front door).
- **Forgetting to add the Caddyfile entry**: stack runs but `<svc>.erfi.io` returns 502. Always pair compose-stack changes with Caddyfile entries.
- **Mismatched IP between compose and Caddyfile**: change one, forget the other. The static IP in `ipv4_address:` MUST equal the IP in `reverse_proxy`. Search both files when changing IPs.
- **Mixing `network_mode: host` with custom networks**: a service can't have both. Caddy uses host-mode; everything else uses bridge networks with static IPs.
- **Using named volumes for bulk data**: under Docker Desktop on WSL2, named volumes cache through stale hash paths in `/run/desktop/mnt/...` and break on reboot. Always bind-mount with absolute host paths.
- **Not pinning image tags**: `:latest` upgrades silently and breaks things. Always pin (`postgres:18.1-alpine`, `lscr.io/linuxserver/radarr:6.1.1`). Use `oci_tags <image>` to find current versions when bumping.
- **Skipping health checks**: Compose can't sequence `depends_on: condition: service_healthy` without them. Always declare a healthcheck.
- **PUID/PGID mismatch**: file permissions on bind-mounts inherit container UID. Mismatch with host owner = permission denied. Default everywhere: PUID=1000, PGID=100, UMASK=0002.
- **Putting the DB on the same network as the public-facing service**: makes the DB reachable from any container that knows the IP. Use a second `internal: true` network for backend dependencies, even when convenience tempts otherwise.

## When to graduate from compose

Compose works fine until one of:

1. **Multiple hosts** — load balancing or HA across machines. Compose has no scheduler. Next step: **k3s** (lightweight k8s, single-binary, suitable for 3-5 node homelab).
2. **Auto-scaling** — workload elasticity. Compose can't scale beyond `--scale N` (static). Next step: k3s + HPA.
3. **Self-healing** — node failure recovery. Compose has no rescheduler.
4. **Secret management at scale** — `.env` files don't scale past ~10 services. Vaultwarden CLI works but is manual. Next step: SOPS-encrypted secrets in git, or HashiCorp Vault, or k8s native secrets + sealed-secrets.

Don't graduate prematurely. The user's current scale (~12 stacks on Unraid + Proxmox VMs) fits compose comfortably.

## k3s (when you do graduate)

Single-binary, lightweight k8s. Install via `curl -sfL https://get.k3s.io | sh -`. Bundled components:

- **Traefik** ingress (replaces Caddy) — fine, but Caddy via `caddy-ingress` works too if you want continuity
- **Flannel** CNI — replace with **Cilium** for eBPF observability + better network policy
- **local-path-provisioner** — single-node only; for multi-node use **Longhorn** (replicated block) or **NFS CSI** pointing at Unraid
- **ServiceLB** (Klipper) — for bare-metal LB without cloud; replace with **MetalLB** for production-grade

Manifest layout convention (when migrating compose → k3s):

```
~/k3s-myservice/
├── kustomization.yaml         # references base/ and overlays/
├── base/
│   ├── deployment.yaml        # replaces docker-compose.yml service
│   ├── service.yaml           # ClusterIP, replaces network static-IP
│   ├── ingress.yaml           # replaces Caddyfile entry
│   └── pvc.yaml               # replaces bind-mount
└── overlays/
    └── prod/
        ├── kustomization.yaml
        └── replica-count.yaml
```

Use **Helm only for upstream charts you didn't write**. For your own services, raw manifests + `kustomize` is cleaner.

## Proxmox VMs (when compose is too much overhead)

For workloads that need a full VM (Windows, GPU passthrough, kernel modules, security isolation):

- **Proxmox VE** on bare metal. User runs Proxmox per dotfiles SSH config.
- **VM template via cloud-init**: build once, clone N times. Ubuntu 24.04 LTS + cloud-init datasource = baseline.
- **Snapshotting before changes** — Proxmox snapshots are cheap, restore is instant.
- **Backup via Proxmox Backup Server** (separate host) — incremental, dedup'd, encrypted.
- **Mount cluster filesystems via virtiofs** for shared data (faster than 9p, near-native).
- **Don't use containers in VMs except for transition** — adds a layer of overhead. Either commit to VMs or commit to containers per workload.

## Backups

The user's pattern (from servarr `MIGRATION_PLAN_ZFS.md`):

- **Config data** (`/config` per service): nightly snapshot + offsite copy
- **Bulk media**: ZFS snapshots + scheduled scrubs; no offsite (too large)
- **Postgres**: `pg_dump` to a separate volume nightly; rotate weekly/monthly
- **Compose YAML + AGENTS.md**: git (this repo + per-stack repos)
- **Secrets**: Vaultwarden as canonical store; `.env` reconstructed from vault on disaster recovery

## Related skills + sources

- `frontend-stack` — when scaffolding the app that this stack hosts
- `supabase` — when the project uses Supabase instead of self-hosted Postgres
- `ci-workflows` — to deploy this stack via CI
- **Docs sources**: `docker`, `kubernetes`, `k3s`, `caddy`, `traefik`, `cloudflare`, `ansible`, `terraform`, `helm`
- **User's reference repos**: `~/ergo/caddy-compose/AGENTS.md`, `~/servarr-compose/AGENTS.md`, `~/keycloak-compose/`, `~/vaultwarden-compose/`, `~/gitea-compose/`, `~/immich-compose/` — read these for canonical examples
