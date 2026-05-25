---
name: fly
description: Fly.io app lifecycle via the `flyctl` CLI — deploy, secrets (Vaultwarden → flyctl set workflow), cert + custom DNS, machines (vs apps model), volumes + snapshots, scaling + auto-stop/start, private networking + .internal DNS, logs + debugging, cost optimization. Sibling to your self-hosted compose stacks — use Fly for workloads that benefit from global anycast / managed cert / auto-scale-to-zero. Default to Compose / k3s on your own hardware first; Fly is for things you can't or don't want to host yourself.
---

# fly — fly.io operations

This skill captures the workflows you'll actually do — lifecycle, secrets, certs, machines, debug. Skips generic "Hello World" tutorial content.

List all apps in your org with `flyctl apps list`. Examples below use `<app>` as the app-name placeholder — substitute the real name.

## Auth + setup

```bash
flyctl auth login                                  # browser-based OAuth
flyctl auth token                                  # print token for CI
flyctl auth whoami                                  # confirm logged in + org

# bash completion (one-time)
flyctl completion bash > ~/.local/share/bash-completion/completions/flyctl
```

## fly.toml — what matters

Minimum-viable example for a single-image deploy:

```toml
app = "<your-app>"
primary_region = "fra"                # closest to your users — pick once

[build]
  image = "<registry>/<image>:<pinned-tag>"   # NEVER `latest` (mirror compose discipline)

[env]
  TZ = "<your-tz>"           # e.g. UTC, Europe/Berlin, America/Los_Angeles
  PUBLIC_BASE_URL = "https://<host>.example.com"
  DATA_DIR = "/data"

[[services]]
  protocol = "tcp"
  internal_port = 80

  [[services.ports]]
    handlers = ["http"]
    port = 80
    force_https = true                  # 301 from :80 to :443

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

  [services.concurrency]
    type = "connections"
    hard_limit = 200
    soft_limit = 150

[[mounts]]
  source = "app_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
  cpus = 1

[deploy]
  strategy = "rolling"                  # vs "immediate" / "bluegreen" / "canary"
```

Validate locally before pushing:

```bash
flyctl config validate
```

## Deploy

```bash
# deploy with the local fly.toml (default behavior)
flyctl deploy

# deploy a specific image without rebuilding
flyctl deploy --image ghcr.io/<org>/<app>:v1.2.3

# deploy + watch
flyctl deploy --strategy=rolling --wait-timeout=600

# deploy without a redeploy (only update config)
flyctl deploy --strategy=immediate --skip-image-refresh

# remote build (no local Docker — Fly builds for you)
flyctl deploy --remote-only

# inspect what would deploy without doing it
flyctl deploy --dry-run --build-only
```

`strategy` options worth knowing:
- **rolling** (default) — one machine at a time, safest for stateful apps. Slowest.
- **immediate** — all at once, fastest but momentary outage.
- **bluegreen** — provision green, swap, retire blue. Best for stateless apps with health-checks.
- **canary** — 1 machine first then progressive rollout. Good for risky changes.

## Secrets — the workflow

Per your Vaultwarden-as-canonical-store discipline:

```bash
# pull from vault, stage into fly (no auto-deploy yet)
DB_URL=$(bw get password <app>-db)
SMTP_PW=$(bw get password <app>-smtp)
flyctl secrets set --stage \
  DB_URL="$DB_URL" \
  SMTP_PASSWORD="$SMTP_PW" \
  --app <app>

# trigger the redeploy with all staged secrets in one shot
flyctl secrets deploy --app <app>

# list current names + digests (values not retrievable from Fly side)
flyctl secrets list --app <app>
flyctl secrets list --json --app <app> | jq -r '.[].Name'

# remove a secret (triggers redeploy unless --stage)
flyctl secrets unset OLD_KEY --app <app> --stage
```

### Audit completeness (HAS vs NEEDS)

```bash
# what fly has
flyctl secrets list --json --app <app> | jq -r '.[].Name' | sort > /tmp/fly-has.txt
# what the app needs (extracted from .env.example or fly.toml.env)
rg -oP '^([A-Z_][A-Z0-9_]+)=' /path/to/<app>/.env.example | sed 's/=$//' | sort -u > /tmp/fly-needs.txt
diff /tmp/fly-needs.txt /tmp/fly-has.txt           # rows only in NEEDS = missing on fly
```

If staging a sync script in `~/dotfiles/bin/`, name it `fly-sync-secrets-from-vault` and have it:
1. Read the app's needed env var names from `.env.example`
2. Fetch each from `bw get <name>`
3. Bulk `flyctl secrets set --stage` then `flyctl secrets deploy`

## Certs + custom DNS

```bash
# 1. Tell fly about your domain (must own DNS)
flyctl certs add <host>.example.com --app <app>

# 2. Configure DNS — fly prints the records to create
flyctl certs show <host>.example.com --app <app>
# typically: A → fly app's anycast IPv4, AAAA → IPv6, _acme-challenge CNAME for cert issuance

# 3. Poll until issued (the pattern that times out pi's bash tool).
#    Use bg_bash so the loop runs detached:
bg_bash command='for i in $(seq 1 20); do
  status=$(flyctl certs check <host>.example.com --app <app> 2>&1 | grep -oP "Status\s*=\s*\K\w+")
  echo "[$(date +%H:%M:%S)] attempt $i: $status"
  [ "$status" = "Ready" ] && break
  sleep 10
done'

# 4. Verify HTTPS works
flyctl certs show <host>.example.com --app <app>
curl -sS https://<host>.example.com/v1/health

# remove a cert (also removes Fly's anycast routing for it)
flyctl certs remove <host>.example.com --app <app>
```

Caddy parallel: in your self-hosted compose pattern you terminate TLS at `~/ergo/caddy-compose/`. Fly handles cert + TLS at the edge for you; if you ever front Fly with Caddy too (anti-pattern but sometimes useful for unified routing), set `force_https = false` in the inner `[[services]]` and let Caddy do TLS termination.

## Machines vs Apps (mental model)

- **App** = logical service identity + DNS + cert + secrets + scaling policies.
- **Machine** = one running VM. An app can have N machines across M regions.

Fly used to be apps-only ("Nomad"); since 2023 it's machines underneath. You configure at the app level; Fly schedules to machines.

```bash
# list machines for an app (each is a VM)
flyctl machine list --app <app>
flyctl machine status <machine-id> --app <app>

# restart / destroy a specific machine (useful when one is wedged)
flyctl machine restart <machine-id> --app <app>
flyctl machine destroy <machine-id> --force --app <app>    # app self-heals back to count

# update one machine's image (without affecting others)
flyctl machine update <machine-id> --image new-image:tag --app <app>

# inspect (raw machine config)
flyctl machine status <machine-id> --json --app <app> | jq
```

## Scaling

```bash
# show current
flyctl scale show --app <app>

# count (more machines = more redundancy + parallelism)
flyctl scale count 2 --app <app>                            # 2 machines total
flyctl scale count 2 --region fra,iad --app <app>           # geo-distribute

# VM size (machine sizing)
flyctl scale vm shared-cpu-2x --memory 512 --app <app>      # bump CPU + RAM
# sizes: shared-cpu-1x..8x (cheapest), performance-1x..16x

# auto-stop + auto-start (scale to zero — huge cost win for ntfy-style apps)
# set via fly.toml:
# [http_service]
#   auto_stop_machines  = "stop"        # "stop" / "suspend" / "off"
#   auto_start_machines = true
#   min_machines_running = 0
```

`auto_stop_machines` saves $$ for low-traffic apps. First request after stop has ~3-5s cold-start. Fine for push / notification / batch apps; bad UX for an interactive HTTP API. Decide per-app.

## Volumes (persistent storage)

```bash
flyctl volumes list --app <app>
flyctl volumes create app_data --size 1 --region fra --app <app>    # 1 GB
flyctl volumes show <vol-id> --app <app>
flyctl volumes destroy <vol-id> --app <app>
flyctl volumes fork <vol-id> --app <app>                            # clone (useful for migrations)
flyctl volumes snapshots list <vol-id> --app <app>
flyctl volumes snapshots create <vol-id> --app <app>
flyctl volumes restore <snapshot-id> --app <app>
```

Volume gotchas:
- Volumes are **regional**, not global. A volume in `fra` can only attach to machines in `fra`. If you scale to multiple regions, each needs its own volume — they don't auto-replicate.
- Snapshots are taken automatically every 24h (5 retained). Force one before risky upgrades.
- Volumes can't shrink. Plan size up-front; resizing requires destroy + restore from snapshot.

## Private networking + .internal DNS

Inside a Fly org, apps can talk to each other on a WireGuard mesh via `.internal` DNS:

```bash
# from inside one app, reach another
curl http://other-app.internal:8080/health

# multi-instance (any healthy machine)
curl http://_app.internal/health

# specific machine
curl http://<machine-id>.vm.<app>.internal:8080/health
```

Tailscale integration: Fly orgs can be added to a Tailscale tailnet via Tailscale's `flyctl` integration. Useful for letting your Unraid box reach Fly internal services without going public.

## Postgres (managed cluster)

If you use `flyctl postgres create`:

```bash
flyctl postgres list
flyctl postgres connect --app <pg-app-name>        # opens psql
flyctl postgres attach <pg-app-name> --app <client-app>  # injects DATABASE_URL secret

# backups
flyctl postgres list-backups --app <pg-app-name>
flyctl postgres backup create --app <pg-app-name>
flyctl postgres backup restore <backup-id> --app <pg-app-name>
```

For most workloads, **NOT using Fly Postgres is cheaper** — connect to your own self-hosted PG via the `.internal` mesh (if your PG is on Fly too) or via Tailscale (to your Unraid PG).

## Debugging

```bash
# logs
flyctl logs --app <app>                              # tail all
flyctl logs --app <app> --machine <id>               # single machine
flyctl logs --no-tail --json --app <app> | jq        # one-shot + JSON

# health
flyctl status --app <app>
flyctl checks list --app <app>

# SSH into a running machine (must be enabled — most images allow)
flyctl ssh console --app <app>
flyctl ssh console --machine <id> --app <app>
flyctl ssh console -C 'ls -la /data' --app <app>    # one-shot

# port-forward to a private service (debugging without exposing)
flyctl proxy 5432 --app <pg-app>                     # local :5432 → fly pg

# the do-everything-diag command
flyctl doctor

# get a token for API calls (debug at the platform layer)
flyctl auth token | head -c 40                       # CI-safe excerpt
```

## Cost optimization

Three knobs:

1. **VM size**: `shared-cpu-1x` 256MB is ~$3/mo. `performance-2x` 4GB is ~$30/mo. Pick the smallest that meets P95 latency.
2. **`auto_stop_machines` + `min_machines_running=0`**: idle apps pay $0 except for storage. For push / batch / notification apps with infrequent traffic, no-brainer.
3. **Region count**: each region replicates VMs + volumes. Most personal apps need 1 region. Multi-region only for global anycast performance.

Check bills + usage:

```bash
flyctl billing show
flyctl orgs show <your-org>
```

## Foot-guns (real ones)

- **Secrets `set` triggers redeploy unless `--stage`**. Always `--stage` + batch + `deploy` for multi-secret updates.
- **`flyctl certs check` polls slowly**. The status `Awaiting configuration` means DNS records aren't found yet; `DNS Validated` means cert is being issued; `Ready` means done. Issuance can take 5-15 min for Let's Encrypt rate limits. Use `bg_bash` for the polling loop (see "Certs" section above).
- **Image pulls from private registries** need `flyctl secrets set DOCKER_REGISTRY_PASSWORD=...` first. Public ghcr.io images work without auth.
- **`.fly` vs `.fly.dev` confusion**: your app gets a free `<app>.fly.dev` hostname AND can have custom domains. Both work; don't disable the .fly.dev URL — it's useful for testing routing.
- **Machine ID vs app name**: a lot of `flyctl` commands work with either, but the `--machine` flag specifically wants the ID (looks like `1234ab567c89def`).
- **`flyctl deploy` cancels prior in-flight deploys** automatically. Useful but surprising; if you pushed a typo + immediately re-pushed, the first push will be killed mid-rollout.
- **Volume regional pin**: forgetting this leads to "no machines in region X" errors when you scale. Either co-locate volumes with the region you scale to, or use forks.
- **No outbound static IP by default**: if a downstream service whitelists IPs, you need to enable a dedicated outbound IP (paid feature).
- **`force_https = true` + healthchecks on `:80`**: the healthcheck on :80 gets redirected to :443 and fails. Either set `force_https = false` for internal health, or use the HTTPS path.

## When to use Fly vs your own compose / k3s

| Workload | Where |
|---|---|
| Public-facing, anycast routing needed, traffic from far places | Fly |
| You need a managed TLS cert without running Caddy | Fly |
| Cost-sensitive low-traffic side project | Fly + `auto_stop_machines` (scale to 0) |
| You want to self-host on hardware you own | Compose + Caddy (your `infrastructure-stack` skill) |
| Stateful complex (postgres + multiple services + cross-stack networking) | Compose (you have 12+ stacks already, no win on Fly) |
| Heavy compute or GPU | Your own boxes; Fly GPU is expensive |
| You need to run > 1 region with the same data | Fly (anycast + LiteFS) or accept the latency tax of single-region self-host |

Existing pattern: compose for everything home-resident; Fly for the small handful of services that genuinely benefit from global edge + zero-ops TLS.
