---
name: infrastructure-stack
description: Use when starting a new self-hosted service as a Docker Compose stack, changing stack networking (bridge + static IP, subnets, expose vs ports, cross-stack shared networks), integrating a stack with the host-mode Caddy proxy, writing a per-stack AGENTS.md, or deciding compose vs k3s vs Proxmox VM. Fires on 'new compose stack', 'subnet allocation', 'expose vs ports', 'PUID/PGID', 'health check', 'graduate to k8s'. NOT for Dockerfiles or image builds (docker) or for deploying a stack (composer).
---

# Infrastructure - Compose-first, k3s/VMs as escalation

The user runs self-hosted services as discrete Docker Compose stacks under `~/infra/`, on two hosts: the servarr NAS (NixOS + ZFS; see `zfs-storage`) and the MS-01 router (composer-managed, its own rules below). Every stack follows the same conventions. This skill encodes them.

## Convention summary (read this first)

1. **One stack per service** under `~/infra/<name>/` (older stacks keep a `-compose` suffix; edge stacks live under `~/infra/ergo/`) with `compose.yaml` (older stacks still use `docker-compose.yml`) + `AGENTS.md` + optional `MIGRATION_*.md` planning docs. Do not create new top-level `~/*-compose` dirs (`~/dotfiles/infra/AGENTS.md`).
2. **Each stack gets a dedicated bridge network** with a `/24` subnet (or `/28` for small stacks) and **static `ipv4_address` assignments** per container.
3. **No port publishing for backend services** - use `expose: <port>` only. Public exposure happens at Caddy in another stack.
4. **Caddy runs in `network_mode: host`** in `~/infra/ergo/caddy-compose/` and reverse-proxies to the bridge static IPs via kernel routing.
5. **Caddyfile pins to static IPs**, not service hostnames (e.g. `reverse_proxy 172.19.X.Y:7878`).
6. **Bind-mounts over named volumes** for bulk data; absolute host paths only. On servarr the tier decides the path: `/appdata/<svc>/` (hot NVMe: SQLite configs, Postgres) or `/tank/appdata/<svc>/` and `/tank/media/` (bulk HDD) - `zfs-storage` has the placement rules. A `/mnt/user/...` path in an older stack is the pre-ZFS layout and needs migrating, not copying.
7. **PUID/PGID/UMASK = 1000/100/0002** on LinuxServer.io images. Containers that don't honour them use `user: 1000:100`.
8. **Per-service `healthcheck:`** with `CMD-SHELL` curl probe + 30s interval / 3 retries.
9. **`deploy.resources.limits`** for CPU + memory on every service.
10. **`internal: true`** on networks that should never see external traffic (DB + cache behind a service).
11. **Cross-stack shared networks** for services that need to consume across boundaries (e.g. `media` network for jellyfin consumers).

## Subnet allocation

Servarr stacks conventionally take one `/24` under `172.19.0.0/16`; router-local stacks use `172.20.x` (edge nets `172.31.x`, see `router-local.md`); a handful of stacks sit in other 172.x blocks. **When adding a new stack, pick a free `/24` and document the allocation in that stack's `AGENTS.md`.** Don't hard-code the full allocation map in a public file - grep the live stacks (`rg 'subnet:' ~/infra --glob '*compose*.y*ml'`) when you need a current view.

Rules of thumb:
- One `/24` per stack, X picked from whatever is documented as free on the target host.
- Reserve a high-X range for Caddy's WAF / forward-auth bridges so the host-mode Caddy can `extra_hosts` route to them deterministically.
- A small handful of historical stacks use `/28` instead of `/24` - keep them as-is, don't replicate.

## Common pitfalls

- **`ports: "8080:8080"` for backend services**: don't. Caddy host-mode reaches static IPs directly. Publishing ports adds unnecessary attack surface and can collide with host services. Only publish ports for services that need direct external access (rare - Caddy is the front door).
- **Port-publishing on an `internal: true` network silently does nothing.** Docker creates NO DNAT rule for it - runtime `NetworkSettings.Ports` stays `null` and `docker port` is empty, with no error. If another stack needs to scrape/reach a service on an internal network, declare that network `external: true` in the CONSUMER stack and make the consumer a MEMBER of it (monitoring-compose's prometheus joins `memledger_backend` to scrape the postgres exporter), never try to publish a host port.
- **Forgetting to add the Caddyfile entry**: stack runs but `<svc>.<your-zone>` returns 502. Always pair compose-stack changes with Caddyfile entries.
- **Mismatched IP between compose and Caddyfile**: change one, forget the other. The static IP in `ipv4_address:` MUST equal the IP in `reverse_proxy`. Search both files when changing IPs.
- **Mixing `network_mode: host` with custom networks**: a service can't have both. Caddy uses host-mode; everything else uses bridge networks with static IPs.
- **Named volumes for bulk data**: they hide the data's tier and host path, so nothing else (snapshots, tier placement, migctl) can reason about it. Always bind-mount with absolute host paths. (Dev-box only: Docker Desktop on WSL2 also resolves named volumes through stale hash paths under `/run/desktop/mnt/...` after a reboot.)
- **Not pinning image tags**: `:latest` upgrades silently and breaks things. Always pin (`postgres:18.4-alpine`, `lscr.io/linuxserver/radarr:6.1.1`). Use `oci_tags <image>` to find current versions when bumping.
- **Skipping health checks**: Compose can't sequence `depends_on: condition: service_healthy` without them. Always declare a healthcheck.
- **PUID/PGID mismatch**: file permissions on bind-mounts inherit container UID. Mismatch with host owner = permission denied. Default everywhere: PUID=1000, PGID=100, UMASK=0002.
- **Docker root-creates a missing bind-mount host source.** When a bind-mount's host path doesn't exist, `docker compose up` auto-creates it as `root:root`. A container that then drops to PUID (1000) can't write it -> crashloop or "directory not writeable". Fix compose-natively with a `pre_start` lifecycle hook (NOT a manual `chown`, NOT a NixOS tmpfiles rule, NOT an LSIO `custom-cont-init.d` script - `pre_start` is image-agnostic and lives in the compose file):
  ```yaml
  pre_start:
    - image: busybox
      user: root
      command: sh -c 'mkdir -p /data/incomplete && chown 1000:100 /data/incomplete && chmod 0775 /data/incomplete'
  ```
  The ephemeral container runs as root sharing the service's mounts, fixes ownership, exits; the service then starts with a writable dir. Non-recursive chown (the running service owns its own files); add the service's own subdirs explicitly if the app writes into a nested path. `pre_start` is a newer Compose lifecycle hook: the dev box runs Compose v5.4.0, but check the TARGET daemon's `docker compose version` before relying on it.
- **Putting the DB on the same network as the public-facing service**: makes the DB reachable from any container that knows the IP. Use a second `internal: true` network for backend dependencies, even when convenience tempts otherwise.

## Reference files (read when you get there)

- `templates.md` - compose.yaml, Caddyfile block, per-stack AGENTS.md outline. Read when creating a stack.
- `router-local.md` - rules for stacks on the MS-01 router (pinned bridge names + dockerBridges, 172.20.x, absolute host paths). Read before touching a router-local stack (edge-services, forgejo, knotea, ripe-atlas - list them live via the composer API).
- `escalation.md` - when to leave compose, k3s and Proxmox notes. Read when someone says 'graduate to k8s' or 'we need HA'.

## Related skills + sources

- `zfs-storage` - which tier (`/appdata` vs `/tank/appdata`) a stack's state belongs on, and the snapshot/pg_dump backup model
- `composer` - deploying and restarting stacks (REST API; never raw compose on managed hosts)
- `caddy` - editing the edge Caddyfile and reloading it
- `sops-encrypt` - encrypting a stack's `.env` before it is committed
- `frontend-stack` - when scaffolding the app that this stack hosts
- `supabase` - when the project uses Supabase instead of self-hosted Postgres
- `ci-workflows` - to deploy this stack via CI
- **Docs sources**: `docker`, `kubernetes`, `k3s`, `caddy`, `traefik`, `cloudflare`, `terraform`, `helm`
- **User's reference repos**: `~/infra/ergo/caddy-compose/AGENTS.md`, `~/infra/servarr-compose/AGENTS.md`, `~/infra/keycloak-compose/`, `~/infra/vaultwarden-compose/`, `~/infra/forgejo-compose/AGENTS.md`, `~/infra/immich-compose/` - read these for canonical examples (some still carry pre-ZFS `/mnt/user` paths in their history sections)
