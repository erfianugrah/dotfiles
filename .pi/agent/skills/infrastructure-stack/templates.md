# infrastructure-stack: compose, Caddyfile and AGENTS.md templates

Supporting reference for the `infrastructure-stack` skill. Copy-paste starting points for a new stack: the compose.yaml (bridge + static IPs, health checks, resource limits, pg18 mount), the Caddyfile site block, and the per-stack AGENTS.md outline.

## compose.yaml template

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
      - /appdata/myservice/config:/config       # hot tier (NVMe)
      - /tank/appdata/myservice/data:/data      # bulk tier (HDD raidz2)
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
    image: postgres:18.4-alpine
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
      # postgres:18+ images: mount at /var/lib/postgresql (PGDATA is now the
      # version-specific /var/lib/postgresql/18/docker underneath). A mount at
      # /var/lib/postgresql/data is the 17-and-below convention and on 18 it
      # leaves the real PGDATA on the container's writable layer.
      - /appdata/myservice/pg:/var/lib/postgresql
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

In `~/infra/ergo/caddy-compose/Caddyfile`, add a virtual host pointing to the static IP:

```caddyfile
myservice.<your-zone> {
    encode zstd gzip
    reverse_proxy 172.19.X.2:8080 {
        import proxy_headers
    }
    import error_pages
    import site_log myservice
}
```

Caddy is the composer-managed `edge-services` stack on the router and has no deploy webhook: push, then `make caddy-reload` (or `make restart` for `.env` changes) from `~/infra/ergo/caddy-compose/` - see the `caddy` skill. Never run raw `docker compose` against a managed stack.

## Per-stack AGENTS.md template

Every compose stack has its own `AGENTS.md` documenting the conventions. Copy this template:

```markdown
# myservice

<one-line description>. Managed by composer (auto-sync from this repo).

## Topology

| Subnet | CIDR | Purpose |
|---|---|---|
| `myservice` | `172.19.X.0/24` | Main service network |
| `myservice_backend` | `172.19.X+1.0/24` | DB + cache (internal: true) |

Caddy entry: `~/infra/ergo/caddy-compose/deploy/edge/Caddyfile` -> `myservice.<your-zone>` -> `172.19.X.2:8080`.

## Static IP allocation in `myservice` (172.19.X.0/24)

| IP | Service |
|---|---|
| .2 | myservice |
| .10 | postgres_myservice |

## Storage layout

- `/appdata/myservice/config/` - service config (hot tier)
- `/tank/appdata/myservice/data/` - service data (bulk tier)
- `/appdata/myservice/pg/` - Postgres data (mounted at `/var/lib/postgresql`)

## Secrets

`.env` is SOPS-encrypted with age and committed; it is the canonical copy. Never commit plaintext (`sops-encrypt` skill); how composer decrypts it at deploy is in the `composer` skill.

## Health checks

- `myservice`: `curl /healthz`
- `postgres_myservice`: `pg_isready`

## Upgrade procedure

1. Bump image tag in `compose.yaml`.
2. Commit + push (stacks with a webhook redeploy on push).
3. Otherwise `POST $BASE/stacks/myservice/deploy?async=true` (composer REST API; there is no CLI and raw compose is forbidden on managed hosts).
4. Verify `<svc>.<your-zone>` returns 200.
```
