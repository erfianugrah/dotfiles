---
name: fly
description: Fly.io app lifecycle via the `flyctl` CLI — deploy, secrets (Vaultwarden → flyctl set workflow), cert + custom DNS, machines (vs apps model), volumes + snapshots, scaling + auto-stop/start, private networking + .internal DNS, logs + debugging, cost optimization. Sibling to your self-hosted compose stacks — use Fly for workloads that benefit from global anycast / managed cert / auto-scale-to-zero. Default to Compose / k3s on your own hardware first; Fly is for things you can't or don't want to host yourself.
---

# fly — fly.io operations

This skill captures the workflows you'll actually do — lifecycle, secrets, certs, machines, debug. Skips generic "Hello World" tutorial content.

List all apps in your org with `flyctl apps list`. Examples below use `<app>` as the app-name placeholder - substitute the real name.

Command and flag existence was checked against **flyctl v0.4.77** (2026-08-03)
by running `--help` on every invocation in this file. Re-check before trusting
a flag in a script: `flyctl <cmd> --help | rg <flag>`. Dollar figures below are
order-of-magnitude only - the pricing page is authoritative.

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

# remote build is the DEFAULT (no local Docker needed); opt out with --local-only
flyctl deploy --remote-only
flyctl deploy --local-only

# build the image but stop before deploying it
flyctl deploy --build-only
```

Flags that do NOT exist on `flyctl deploy` (v0.4.77), despite being widely
cited: `--dry-run`, `--skip-image-refresh`. Verify with
`flyctl deploy --help | rg <flag>` before putting one in a script.

### Pushing images to Fly's own registry (`registry.fly.io`)

Fly machines pull images **server-side**. That means a private ghcr.io /
DockerHub image is not reachable by default - the machine has no credentials.
Two ways out; the mirror is usually the better one.

**Mirror pattern - the only supported route for a private image.** Retag the
already-built image into Fly's registry and push it there. Every app gets
`registry.fly.io/<app>` for free, and machines can always pull from it.

```bash
flyctl auth docker                              # writes a Fly token into ~/.docker/config.json

docker pull ghcr.io/<org>/<image>:<ver>
docker tag  ghcr.io/<org>/<image>:<ver> registry.fly.io/<app>:<ver>
docker push registry.fly.io/<app>:<ver>
flyctl deploy -a <app> --image registry.fly.io/<app>:<ver>
```

Canonical worked example: `~/knotea/resolver/Makefile` targets `fly-image` +
`fly-deploy`. Note that despite the name, `fly-deploy` builds **nothing**
locally - it mirrors the CI-built image. Mirror the same step in the release
workflow so tagged versions are pushable without a local Docker at all.

**Pushing a locally built image** (iterating on a throwaway / bench app) is the
same minus the pull:

```bash
flyctl auth docker
docker build -t registry.fly.io/<app>:<tag> -f Dockerfile .
docker push registry.fly.io/<app>:<tag>
flyctl deploy -a <app> --image registry.fly.io/<app>:<tag>
```

**There is no credentials-on-the-machine alternative.** Fly does not accept
third-party registry credentials for image pulls - no `flyctl deploy` flag, no
magic secret name, nothing in the docs. (An earlier version of this skill
claimed `DOCKER_REGISTRY_USERNAME` / `DOCKER_REGISTRY_PASSWORD` secrets did
this. They do not exist: zero hits across the flyio doc corpus, no flag in
flyctl v0.4.77, and Fly's own answer on the request is "push to your app
registry instead".) Mirror, or make the upstream image public.

Useful adjacent commands:

```bash
docker manifest inspect registry.fly.io/<app>:<tag>   # exists? exit 1 if not (needs auth docker)
flyctl releases -a <app> --image                      # image refs actually deployed
```

There is no API to list tags in the Fly registry - a tag only becomes visible
to Fly once it is part of a release.

Gotchas:
- **`flyctl auth docker` tokens expire after 5 minutes.** Re-auth immediately
  before the push, not at the top of a long script; a slow push of a large
  image can die partway. A `denied: authentication required` means re-run it,
  not that the tag is wrong.
- Registry paths are per-app but **access is org-scoped**: you can push to
  `registry.fly.io/app-1` and deploy that same image on `app-2` in the same
  org (`flyctl deploy --app app-2 --image registry.fly.io/app-1:tag`). Useful
  for build-once-deploy-many.
- `[build] image = "..."` in `fly.toml` is fine and is the documented way to
  pin a public image. The footgun is `[build] dockerfile = ...` (or just a
  Dockerfile in the working directory): a bare `flyctl deploy` then builds
  instead of shipping the mirrored image you meant. If you deploy by
  `--image`, keep the build keys out.

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
flyctl volumes extend <vol-id> --size 5 --app <app>                 # grow in place, usually no restart
flyctl volumes snapshots list <vol-id> --app <app>
flyctl volumes snapshots create <vol-id> --app <app>

# restore = create a NEW volume from a snapshot. There is no `volumes restore`
# subcommand (it silently prints group help, which reads like success).
flyctl volumes create app_data --snapshot-id <snap-id> --size 5 --region fra --app <app>
```

Volume gotchas:
- Volumes are **regional**, not global. A volume in `fra` can only attach to machines in `fra`. If you scale to multiple regions, each needs its own volume — they don't auto-replicate.
- Snapshots are taken automatically every 24h (5 retained). Force one before risky upgrades.
- Volumes grow in place with `flyctl volumes extend` but **cannot shrink**. To go smaller: snapshot, `volumes create --snapshot-id` at the smaller size, move the machine over, destroy the old one.

## Private networking + .internal DNS

Inside a Fly org, apps can talk to each other on a WireGuard mesh via `.internal` DNS:

```bash
# from inside one app, reach another
curl http://other-app.internal:8080/health

# closest N machines (AAAA)
curl http://top1.nearest.of.other-app.internal:8080/health

# specific machine
curl http://<machine-id>.vm.<app>.internal:8080/health

# process group / region subsets
curl http://<group>.process.<app>.internal:8080/health
curl http://fra.<app>.internal:8080/health
```

`<app>.internal` already returns the 6PN addresses of **all started** machines
(stopped/autostopped ones are excluded), so it is the "any instance" form.
The underscore names are TXT discovery records, not HTTP endpoints:
`_apps.internal` lists app names in the org, `_instances.internal` lists
machine/app/address/region. Query them with `dig`, don't curl them.

Your service must bind `fly-local-6pn` (aliased in `/etc/hosts`) or the 6PN
address itself - binding only to `127.0.0.1` makes it unreachable over 6PN.

Tailscale integration: Fly orgs can be added to a Tailscale tailnet via Tailscale's `flyctl` integration. Useful for letting your Unraid box reach Fly internal services without going public.

## Postgres - two products, don't mix them up

`flyctl postgres` is the **unmanaged legacy** offering. flyctl itself now warns
on every invocation: "Unmanaged Fly Postgres is not supported by Fly.io Support
and users are responsible for operations, management, and disaster recovery."
The managed product is `flyctl mpg` (create / attach / connect / proxy /
backup / restore / status / users).

```bash
# legacy / unmanaged
flyctl postgres list
flyctl postgres connect --app <pg-app-name>              # opens psql
flyctl postgres attach <pg-app-name> --app <client-app>  # injects DATABASE_URL secret
flyctl postgres backup list --app <pg-app-name>          # NOT `list-backups`
flyctl postgres backup create --app <pg-app-name>
flyctl postgres backup restore <backup-id>               # WAL-restore into a NEW cluster, not in place

# managed
flyctl mpg list
flyctl mpg status
flyctl mpg attach <cluster> --app <client-app>
flyctl mpg proxy                                         # local port -> managed cluster
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

Check usage:

```bash
flyctl orgs show <your-org>
```

There is no `flyctl billing` command (v0.4.77) - invoices and usage are
dashboard-only.

## Foot-guns (real ones)

- **Secrets `set` triggers redeploy unless `--stage`**. Always `--stage` + batch + `deploy` for multi-secret updates.
- **`flyctl certs check` polls slowly**. The status `Awaiting configuration` means DNS records aren't found yet; `DNS Validated` means cert is being issued; `Ready` means done. Issuance can take 5-15 min for Let's Encrypt rate limits. Use `bg_bash` for the polling loop (see "Certs" section above).
- **Private third-party registries are not supported at all.** Machines pull server-side with no credentials; public ghcr.io / Docker Hub images work, private ones do not, and there is no secret or flag that changes this. Mirror into `registry.fly.io/<app>` (see "Pushing images to Fly's own registry").
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
