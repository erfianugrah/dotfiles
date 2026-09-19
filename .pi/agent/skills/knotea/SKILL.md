---
name: knotea
description: "Use when working on the user's self-built DNS server knotea (resolver half; binary glory-hole; Fly app knotea; glory-hole retired) - forwarder, policy, blocklist, SERVFAIL/NODATA debugging, bundled Unbound, query-log sizing, the router LAN resolver, or the Fly public DoT/DoH deploy. Fires on 'knotea', 'glory-hole', 'gloryhole', 'the resolver', 'expr policy', 'blocklist', 'upstream health', 'SERVFAIL', 'DoH/DoT', '10.0.10.5'. NOT for authoritative DNS (knot-dns) or live record edits (knotctl)."
---

# knotea - self-built DNS server (resolver half)

Live topology: knotea is the resolver half of the `knotea` binary (monorepo `~/infra/knotea`, resolver source `~/infra/knotea/resolver/`, authority source `~/infra/knotea/authority/`). Two deployments run it: the fleet LAN resolver on the MS-01 NixOS router at `10.0.10.5:53`, and the public Fly app `knotea` (region `sin`, dedicated anycast v4 `137.66.57.23`) which also embeds knotd as the authoritative server for `erfi.io` + `lab.erfi.io` + `servarr.io` + `servarr.dev` (the `knot-dns` skill). **Blue-green migration COMPLETED 2026-09-18:** the legacy Fly app `glory-hole` (anycast `137.66.1.170`, image 1.4.20) was the serving authority until the Phase 3 cutover; the `knotea` app (dedicated anycast `137.66.57.23`, 2GB volume) now serves all 4 zones (TLD glue + DS flipped via dns-tf, ad flag live) and `glory-hole` was RETIRED 2026-09-18 (machine destroyed and its dedicated IPs released; only its 2GB volume survives on the app - a rollback is a machine recreate + attach a NEW IP + repoint the dns-tf glue/DS at it, since 137.66.1.170 is gone and cannot be re-allocated). Binary, module path and image name stay `glory-hole`. Do not conflate the names.

Project truth: `~/infra/knotea/resolver/AGENTS.md` + `~/infra/knotea/resolver/CHANGELOG.md` (current version, config schema, per-feature decisions), root guardrails in `~/infra/knotea/AGENTS.md`. This skill is the pattern layer.

## What it is - one self-contained binary

- DNS server (UDP/TCP `:53`, DoT `:853`, DoH on the API port)
- Pi-hole-style blocklists with downloader + atomic-pointer swaps
- `expr`-based policy engine (BLOCK / ALLOW / REDIRECT / FORWARD)
- Authoritative local records (A/AAAA/CNAME/TXT/MX/PTR/SRV/NS/SOA/CAA + wildcards) - the split-horizon layer for `*.erfi.io` on the LAN
- Conditional forwarding (priority-sorted rules)
- Sharded LRU cache with TTL + blocked-TTL override
- SQLite query log (`modernc.org/sqlite`, CGO=0, WAL, async-buffered writes)
- REST + SSE + WebSocket API with API key / Basic / session+CSRF auth; embedded Astro + React + shadcn dashboard (`go:embed`)
- CF-shape authoritative REST API (`authority/pkg/api`, mounted in-process by `cmd/glory-hole/cfapi.go`, `knot_api.enabled`, off by default) - Cloudflare-compatible `/client/v4` over the loopback knotd; live on the Fly app on port 2096 at host `knotea.erfi.io`. Schema: `~/infra/knotea/authority/docs/api.md`
- Bundled Unbound recursor built from source in the image, supervised as a child process on a loopback port: DNSSEC-validated recursion without trusting an upstream

## Deployments

| Profile | Where | Upstream | Purpose |
|---|---|---|---|
| LAN resolver (fleet) | Host-networked container `knotea` on the MS-01 NixOS router, bound to the services-plane alias `10.0.10.5:53`. Composer stack `knotea`; compose `~/infra/knotea/deploy/edge/compose.yaml`; image `ghcr.io/erfianugrah/knotea:<tag>` (bump the tag there to upgrade). Dashboard/API on `127.0.0.1:8081` (8080 is composer), fronted by the edge Caddy | bundled Unbound (loopback) | Every NixOS host pins `networking.nameservers = ["10.0.10.5"]` and Kea DHCP hands it to every segment; `local_records` carry the split-horizon `*.erfi.io` -> `10.0.10.1` overrides. Runs GLOBAL blocklists (hagezi-ultimate + oisd) for every LAN client - verified live 2026-09-13; the router dnat-steers the TV's external :53 here (see `~/infra/flint-openwrt/docs/network-model.md`). Query evidence: SQLite `queries` table (`client_ip`, `domain`, `qtype`) at `/var/lib/glory-hole/glory-hole.db` via `docker exec knotea sqlite3`. Authority half is OFF in its config (public authoritative DNS stays on Fly until the hidden-primary flip, `~/infra/router/topology.md`) |
| Public DoT/DoH + authoritative | Fly app `knotea` (serving since the 2026-09-18 cutover) / `glory-hole` (RETIRED 2026-09-18: machine destroyed, dedicated IPs released; 2GB volume kept for a machine-recreate rollback), `sin`, `137.66.57.23` | bundled Unbound + embedded knotd (`127.0.0.1:5354`) | DoT/DoH for personal devices, ad-block, and the authoritative NS for `erfi.io` + `lab.erfi.io` + `servarr.io` + `servarr.dev`. Auth-zone queries bypass the recursive client ACL, blocklist and cache and route to loopback knotd. Blue-green completed 2026-09-18 (TLD glue + DS flipped to the knotea app via dns-tf) |
| VyOS podman container on `vyos-sg` (`172.16.0.5`) | Not verified in this pass. `~/infra/router/docs/incident-2026-05-edge/` documents the edge cutover to the MS-01 router; confirm the box still runs (`ssh vyos-sg 'sudo podman ps'`) before relying on the recipes at the bottom | bundled Unbound | Historical Singapore site resolver (replaced pihole + unbound) |

Router config seed pattern (from the compose header): the git-managed `config.yml` is bind-mounted read-only at the image SEED path (`/etc/glory-hole/config.example.yml`); on first boot the entrypoint copies it to the volume at `/var/lib/glory-hole/config.yml` (LIVE, host `/var/lib/knotea`). A sha256 marker detects a changed seed on redeploy: the live file is backed up to `.bak` and replaced. Between deploys, dashboard/API writes land on the volume and survive restarts. The compose sets `name: knotea` explicitly because it shares a parent dir name (`edge`) with caddy-compose's deploy - without it one stack's `up --remove-orphans` deletes the other's containers.

## Architecture - packet path

```
client -> [UDP/TCP :53 | DoT :853 | DoH on API port]
       -> pkg/dns Handler.ServeDNS
         1. allowed_clients gate (IP/CIDR allowlist for plain DNS)
         2. EDNS0 buffer + DO-bit preserved
         3. Policy engine (expr rules; BLOCK / ALLOW / REDIRECT / FORWARD)
         4. Local records (CNAME chain resolution)
         5. Blocklist check (atomic.Pointer hash + pattern match)
         6. Cache lookup
         7. Conditional forwarding evaluator (priority-sorted rules)
              -> forwarder.ForwardWithUpstreams(ctx, msg, override)
            else default forward
              -> forwarder.Forward(ctx, msg)         # round-robin UDP
              -> forwarder.ForwardTCP(ctx, msg)      # TCP variant
         8. Cache.Set, write response (writeMsg sets TC bit + strips
            Answer if UDP response > EDNS0 buffer / 512)
         9. Async query log -> SQLite worker pool
```

Filtering (`pkg/blocklist`, `pkg/policy`, `pkg/pattern`) runs inside the handler, before the forwarder is touched - fast-path lookups, lock-free reads. Telemetry is recorded by the handler (`recordForwardedQuery`), not by the forwarder.

## Package map

| Package | Role |
|---|---|
| `cmd/glory-hole/main.go` | CLI flags, lifecycle wiring, config-watcher OnChange callbacks, whitelist -> policy migration, hourly retention goroutine. Subcommands: `import-pihole`, `hash-password`. `cfapi.go` mounts the CF-shape API |
| `pkg/dns/` | UDP/TCP servers, Handler, `handler_forwarding.go`, EDE extraction, dnstap correlation with Unbound |
| `pkg/forwarder/` | `forwarder.go` (`Forward`/`ForwardTCP`/`ForwardWithUpstreams`), `circuit_breaker.go`, `health.go`, `evaluator.go` (priority-sorted ConditionalRule), `matcher.go` |
| `pkg/unbound/` | Process supervisor, typed config model, `text/template` writer for `unbound.conf`, dnstap reply buffer, stats parser, `/api/unbound/*` |
| `pkg/blocklist/` | Downloader uses `pkg/resolver` HTTP client -> upstream DNS (never `/etc/resolv.conf`); atomic.Pointer swaps |
| `pkg/policy/` | `expr-lang/expr` engine; helpers `Domain`, `DomainMatches`, `DomainEndsWith`, `IPInCIDR`, `Hour`, `InTimeRange`, `QueryTypeIn` |
| `pkg/pattern/` | Exact / wildcard / regex matcher, Pi-hole compatible (`/^regex$/`) |
| `pkg/localrecords/` | Authoritative local answers, CNAME chain resolution, split-horizon NODATA |
| `pkg/cache/` | Sharded LRU + TTL, blocked-TTL override |
| `pkg/storage/` | SQLite, WAL, async buffered writes, retention sweeper, hourly pre-aggregates (`hourly_stats`, `query_hourly`, `client_hourly`) for fast stats reads, migrations |
| `pkg/config/` | YAML load + validate, fsnotify watcher, hot-reload diff helpers |
| `pkg/telemetry/` | OpenTelemetry meter + Prometheus exporter, basic-auth wrapper for `/metrics` |
| `pkg/resolver/` | `net.Resolver` over configured upstreams; HTTP clients for blocklist downloader, ACME |
| `pkg/api/` | REST handlers, middleware (rate-limit, CSRF, auth), DoH endpoint. Dashboard embedded from `pkg/api/ui/static/dist/` |

## Forwarder - the design rules

```go
attempts := min(retries, len(upstreams))
for i := 0; i < attempts; i++ {
    upstream := selectUpstream()    // round-robin over GetHealthyUpstreams()
    client := clientPool.Get()      // UDP only; TCP creates fresh per call
    // wrap in breaker.Call(...) if health is registered
    resp, _, queryErr := client.ExchangeContext(ctx, r, upstream)
    if queryErr != nil { lastErr = queryErr; continue }   // network err -> retry
    if resp == nil    { continue }                          // nil -> retry
    return resp, nil                // ANY rcode -> return immediately
}
return nil, fmt.Errorf("all upstream servers failed: %w", lastErr)
```

- SERVFAIL / NXDOMAIN / REFUSED are valid DNS responses, not errors. They return to the client immediately and are never retried: retrying is an RFC violation and can mask a DNSSEC-bogus answer by re-asking a non-validating upstream. Any new retry path must be opt-in and narrowly scoped (e.g. a TCP retry against the bundled Unbound only, to paper over a UDP path glitch without crossing a security boundary).
- UDP uses a `sync.Pool` of `*dns.Client`; TCP constructs a fresh client per call. Budget allocations accordingly.
- The circuit breaker is disabled when the only upstream is loopback (`forwarder.NewForwarder` detects `isLocalUpstream`), otherwise a transient hiccup against the bundled Unbound trips the breaker into a death spiral against a process the same host supervises. Never re-enable it for the Fly or router profiles.
- Circuit breaker (`circuit_breaker.go`): atomic Closed/Open/HalfOpen per upstream; `UpstreamHealth` is `map[string]*CircuitBreaker` behind an RWMutex.
- Conditional rules (`evaluator.go`): `Evaluate(domain, clientIP, qtype)` returns upstreams or `nil` to fall through. Matchers AND-combine; an empty matcher is a wildcard.

Adding a forwarder feature: typed config struct under `ForwarderConfig`; wire defaults through `NewForwarder`; branch minimally after a successful `ExchangeContext`, keeping the round-robin + retry loop intact; route any retry through `breaker.Call`; extend `forwarder_test.go`.

## Bundled Unbound

Built from source in the image (libevent, OpenSSL, dnstap, fstrm, protobuf-c), supervised as a child on a loopback port. On the Fly and router profiles `upstream_dns_servers` is empty: Unbound is the only upstream and the breaker is off. `docker-entrypoint.sh` seeds `/var/lib/glory-hole/config.yml` from the baked example on first boot only; UI-written changes survive deploys. Force a reset by removing the file and restarting.

## Build, images, deploy

Images (three Dockerfiles):

- `~/infra/knotea/Dockerfile` (monorepo root) - the merged knotea image: Unbound + Knot built from source, Go build, UI. Build context must be the repo root (go.work + `replace` reach `authority`). This is what CI publishes as `ghcr.io/erfianugrah/knotea` on version tags (`.forgejo/workflows/release.yml` - Forgejo Actions on the router runner, `ci-workflows` skill) and what both live deployments run.
- `resolver/Dockerfile` - the pre-merge standalone resolver build; cannot build standalone any more.
- `resolver/Dockerfile.release` - GoReleaser path: skips the Go build stage, copies prebuilt binaries from the buildx context.

Fly: `resolver/fly.toml` defines the services (HTTP API, app-terminated HTTPS via PROXY, the CF-API listener on 2096, DNS UDP + TCP on 53, DoT on 853) - read the file rather than a summary. Nothing builds locally: `make fly-image` mirrors the CI-built ghcr image into `registry.fly.io/knotea` (Fly machines cannot pull private ghcr), `make fly-deploy IMAGE_VERSION=x` mirrors then `flyctl deploy --image` (the Makefile's `FLY_APP` is `knotea` since the 2026-09-14 blue-green flip). Since v1.4.27 (2026-09-18) the tag-triggered release deploys itself: after the registry pushes, the `fly-deploy` job runs `flyctl deploy -a knotea --image registry.fly.io/knotea:<ver> --yes` and asserts the version inside the machine, then `composer-deploy` bumps the router stack (next paragraph). Release ritual: release commit + tag pushed together. Repo secrets it needs: `GHCR_TOKEN`, an org-scoped Fly deploy token (`fly` skill), `GH_PUSH_TOKEN`, `COMPOSER_API_KEY`. The manual path (`make fly-deploy IMAGE_VERSION=x`) still works and is the fallback when the runner is down. The mirror loop still pushes `registry.fly.io/glory-hole` per tag although that app is retired - drop `glory-hole` from the `for APP in` loop in release.yml when next touching CI. Persistent volume at `/var/lib/glory-hole` (2GB - the 2026-09-05 storm sized it); VM `shared-cpu-1x` / 512 MB with `GOMEMLIMIT=384MiB`. Volume + dedicated IP are CLI/API one-shots (`flyctl volumes create/extend`, `fly ips allocate-v4`), not toml-declarable.

Router: the release's `composer-deploy` job sed-bumps the image tag in `deploy/edge/compose.yaml`, pushes to GitHub main with `GH_PUSH_TOKEN`, then POSTs the composer deploy endpoint for the `knotea` stack and polls until the router checkout reports the bump commit. The explicit POST is required because the router-host stack has NO GitHub webhook, so composer auto-sync never fires for it (bit on 2026-09-18: `last_sync` four days stale). Manual fallback: bump the tag, push, `POST /api/v1/stacks/knotea/deploy` (`composer` skill; the router itself is the `eaves` skill).

Release source: the knotea monorepo is canonical for every running instance. The standalone `~/infra/gloryhole` repo (remote `erfianugrah/gloryhole`) is still receiving commits and its own `release.yml` publishes `ghcr.io/erfianugrah/gloryhole`, but no deployment in `~/infra` references that image - whether anything consumes it is unresolved. Do not develop resolver features there.

| Make target (`resolver/Makefile`) | What |
|---|---|
| `ui` / `build` / `build-all` | Astro dashboard into `pkg/api/ui/static/dist/`; Go binary with version ldflags; cross-compile matrix |
| `test` / `test-race` / `test-coverage` / `bench` | race detector is mandated in CI |
| `lint` | per-directory `golangci-lint` (sidesteps a toolchain bug with the all-package form) |
| `docker` / `docker-push` | local multi-arch build of the merged image |
| `fly-image` / `fly-deploy` / `fly-deploy-ci` | see above |
| `smoke-cfapi` | end-to-end smoke of the live CF-shape API (touches prod DNS, self-cleaning; needs `KNOT_API_TOKEN` by var reference) |
| `release` | `lint test build` |

## Config schema

Top-level keys (`pkg/config/config.go`): `telemetry, server, policy, auth, local_records, conditional_forwarding, forwarder (.circuit_breaker), upstream_dns_servers, blocklists, whitelist, logging, database, cache, block_page, unbound, knot_api, knot, update_interval, auto_update_blocklists`.

`knot` (authoritative half, embedded knotd): `enabled, listen, storage, nsid, served_zones, zone_apex`. `zone_apex` is a per-zone map (plus a `default` fallback; values may use the `{zone}` placeholder) that drives boot-time apex bootstrapping: `soa` (mbox/ns/refresh/retry/expire/minimum + ttl) and `ns` + `ns_ttl`. It exists because a fresh Knot confdb has no zones at all - a zoneless Knot answers REFUSED.

### Boot: seed + zone-reconcile (v1.4.22+)

Boot order for the authoritative half: render seed `knot.conf` from `resolver/config/config.fly.yml` + env (strict `${VAR}` - unresolved refs fail the boot), `knotc conf-check` -> `conf-import` to the confdb (only on a fresh/reseeded volume - existing confdb is the source of truth), start knotd, wait for the control socket (`<rundir>/knot.sock`), then **zone-reconcile**: for each `served_zones` entry, create-if-absent via the control client (missing -> zone create + apex SOA/NS from `zone_apex` + `knotea-auto` signing; existing with apex -> skip; existing without apex -> apex only). Per-zone failures are logged (`zone-reconcile: zone ... create: ...`) and are NOT fatal - the remaining zones still reconcile and knotd keeps serving. Apex bootstrap runs BEFORE `EnableDNSSEC` so the initial signing covers the apex. Zone CONTENT is not reconcile's job - that is `knotctl apply` of `authority/zones/*.yml` (see the knotctl skill). Post-deploy verification: `fly logs -a <app> | rg 'zone-reconcile|zone reconcile'` must show one line per served zone (action = created / exists-with-apex-skip / apex-bootstrapped).

`config.yml` and `config.fly.yml` are gitignored (tokens, bcrypt hashes, allowlists); the repo ships `config/config.example.yml`. `config.test.yml` is in-repo but stale (pre-v0.5 `storage:` block, defunct `policies:`/`tls:`/`dot_*:` keys) - do not copy it. Per-profile differences (cache sizing, retention, listen addresses, allowlists, logger workers) live in `resolver/AGENTS.md`.

## Telemetry

`pkg/telemetry/telemetry.go`: `prometheus.New()` exporter -> `sdkmetric.NewMeterProvider(WithResource, WithReader)` -> `otel.SetMeterProvider`. The Prometheus HTTP server is separate from the API server (`/metrics` on its own port, optional basic auth via `metrics_username` / `metrics_password`, `ReadHeaderTimeout: 10s`). Tracing is a no-op stub. Adding a counter: field on `Metrics`, `meter.Int64Counter` in the constructor, `m.X.Add(ctx, 1, metric.WithAttributes(...))` from the handler; UpDown counters serve as gauges.

## Test patterns

`pkg/forwarder/forwarder_test.go` `mockDNSServer(t, responses map[string]*dns.Msg) (addr string, cleanup func())` is the canonical helper: `net.ListenPacket("udp", "127.0.0.1:0")`, a goroutine that unpacks each request, looks up `req.Question[0].Name`, replies with `SetReply` or a default NXDOMAIN. Naming `TestForward_<Scenario>` (`Success`, `RoundRobin`, `Timeout`, `Retry`, `SERVFAIL`, `SERVFAIL_PassThrough`, `ContextCancellation`). `t.Fatal` for setup, `t.Errorf` inside loops; never pass nil loggers (`logging.NewDefault()`). Coverage target 80% per package, 90%+ for the DNS handler and policy. E2E: `docker-compose.e2e.yml` (auth off, all features on, high ports).

## Gotchas - the durable list

1. Fly UDP/53 must bind `fly-global-services:53`, not `:53` (`server.udp_listen_address`). Plain UDP on Fly cannot see real client IPs; rely on PROXY proto on TCP/DoT.
2. Fly anycast UDP is best-effort; transient loss surfaces as SERVFAIL upstream errors. Motivation for any opt-in TCP-retry against loopback Unbound.
3. Circuit breaker death spiral on local Unbound - disabled automatically for loopback-only upstreams; keep it that way.
4. SERVFAIL pass-through is RFC-mandated; there is no SERVFAIL retry and new retry paths must be opt-in and narrow.
5. Whitelist is migrated, not honoured: `migrateWhitelistToPolicies` rewrites entries into ALLOW policy rules at boot and clears `cfg.Whitelist`. Editing `whitelist:` afterwards is a no-op.
6. `config.yml` / `config.fly.yml` are gitignored for a reason - never paste them into PRs or commits.
7. First-boot config copy: deploys preserve the on-volume config. Force reset = remove the file, restart the machine/container.
8. TCP forward path has no client pool.
9. UDP response size + TC bit: `Handler.writeMsg` enforces the EDNS0 size (or 512), sets `Truncated`, strips Answer. Do not disable without another anti-amplification guard.
10. Dashboard rebuild is silent: Astro under `pkg/api/ui/dashboard/`; touching its `package.json` needs `make ui` or a stale `dist/` ships via `go:embed` without warning.
11. Hot reload covers blocklist, policy, local records, whitelist (-> policy), conditional forwarding, rate limit, forwarder. Listen-address changes and `database.retention_days` need a restart.
12. Repo vs binary vs app names: source is `~/infra/knotea/resolver/`; binary + module + image name are `glory-hole`; the Fly app is `knotea` (serving since the 2026-09-18 cutover; `glory-hole` is the retired legacy app - no machine, volume kept, its `registry.fly.io/glory-hole` still receives the release mirror); the router container and composer stack are `knotea`.
13. Fly-profile query-log sizing: the "prune cron" is the in-app hourly retention goroutine (`database.retention_days`, 50K-row batches), captured at boot. The public profile sees ~100K queries/day normally; incident loops can 10x that (the 2026-09-05 erfi.io delegation-loop storm logged 1.27M rows/~725MB in one day and filled the 1GB volume 100% - every SQLite write wedged, inserts and the sweeper's own deletes included, and the API stats endpoints 500ed for hours until the volume was extended). Since 1.4.14: volume is 2GB, the hourly tick runs `storageWatchdog` (exports `storage.disk.usage` gauge; prunes to 24h/6h/1h windows at >=90% until <80%), the cleanup full-drains `incremental_vacuum` so the file tracks live data, and stats/queries/clients endpoints return 503 + error text on storage failures. Keep `retention_days: 2` in the on-volume `config.yml`. Diagnose with `sqlite3 ... "select count(*), min(timestamp) from queries"`: oldest row inside the retention window means the goroutine works and it is a sizing problem. Manual space reclaim on a live app: extend the volume FIRST (`flyctl volumes extend <vol> --size N`, no restart), then VACUUM - a 100%-full volume has no room for VACUUM's temp file. BusyBox grep on the Fly box does NOT support `\|` BRE alternation - a multi-pattern grep silently returns empty. Since v1.4.18 the dashboard read paths no longer scan `queries` at all: `query_hourly(hour,domain,query_type)` + `client_hourly(hour,client_ip)` are pre-aggregated (live-updated per flush batch, background backfill on open), so /api/stats went 15.5s (503) -> 0.5s on the identical storm window - verified locally in `resolver/hack/flysim` (seed 1.38M-row DB on fast disk, copy to /mnt/d 9P, `docker run --memory=512m --memory-swap=512m --cpus=1` on a host-built binary, `probe.sh` times all six endpoints; re-run after ANY storage read-path change). Also fixed in v1.4.18: retention bound its cutoff as a raw `time.Time` (driver renders space layout `... 04:30:00+0000`) against RFC3339-stored timestamps, so every row on the cutoff day survived and the volume tracked retention+1day - it now binds `FormatTimestamp`. Related trap: summary-table hour columns are space-layout; an RFC3339 cutoff string sorts ABOVE every same-day space-layout hour (' ' < 'T') and over-deletes - truncate prunes to the hour boundary in the hour string's own layout.
14. Split-horizon NODATA: a local-record name with only an A override answers NODATA (empty NOERROR) for AAAA instead of falling through to public recursion, and symmetrically for AAAA-only names. The LAN has no IPv6, so a public AAAA (CDN proxy) for an internal name is always wrong for AAAA-preferring clients.
15. VyOS container deploy (`vyos-sg`, status unverified - see the deployments table): run config sessions via `ssh vyos-sg 'vbash -s' <<EOF` (`bash -s` silently fails to persist `set`s); `volume` / `port` attributes are separate per-leaf `set` commands; the plain image bakes `config.example.yml` so override `command '-config'` + `arguments '/var/lib/glory-hole/config.yml'`; VyOS `service dns forwarding` recurses independently unless given `name-server <glory-hole-ip>`.
16. The router stack IS the LAN's DNS: the dev box, Flint and - on the router - composer's own git clone all resolve through it. A delete/recreate of the stack (e.g. re-pointing its repo_url: composer has no UPDATE, only DELETE + `POST /stacks/git`) is a LAN-wide outage window, and every management call must use direct IPs in that window: composer `http://10.0.69.1:8080/api/v1/...`, Forgejo git `ssh://git@10.0.69.1:2223/erfi/<repo>.git` (Caddy L4 proxy; :22 is the router sshd, :2222 is compose-network-only). Composer ssh host keys go in `/var/lib/composer/ssh/known_hosts` (plaintext skip-list; Forgejo host key from `docker exec forgejo sh -c "cat /var/lib/gitea/ssh/gitea.rsa.pub"` - ssh-keyscan cannot talk to the forge git sshd). Full incident record + key inventory: repo `docs/plans/2026-09-19-gh-retirement.md`.

## Cross-references

- `knot-dns` skill - the authoritative half; shares the Fly deploy and the UDP-hairpin lessons.
- `knotctl` skill - record edits against the embedded knotd.
- `fly` skill - UDP binding, `fly ips allocate-v4`, PROXY proto, volumes.
- `composer` skill / `eaves` skill - the router `knotea` stack and the MS-01 host it runs on.
- Prometheus / Grafana dashboards in `resolver/deploy/grafana/`, alerts in `resolver/deploy/prometheus/`.
- Pi-hole import: `glory-hole import-pihole --zip ...` consumes Teleporter archives.

Docs sources (erfi-toolkit docs tool): `pihole`, `miekg-dns-v2`, `flyio`, `vyos`, `sqlite`.

## Operator recipes

```bash
# Local dev (auth off, high ports)
docker compose -f docker-compose.e2e.yml up

# Fly (knotea = the serving app; glory-hole is retired and has no machine)
fly logs -a knotea
fly logs -a knotea | rg 'zone-reconcile|zone reconcile'   # v1.4.22+: one line per served zone after boot
fly ssh console -a knotea -C 'tail -50 /var/log/unbound/unbound.log'
fly ssh console -a knotea -C 'rm /var/lib/glory-hole/config.yml' && fly machine restart <id>   # reset UI-edited config

# Router LAN resolver
ssh router 'docker logs --tail 50 knotea'
ssh router 'docker inspect knotea --format "{{.Config.Image}}"'
dig +short @10.0.10.5 example.com; dig +short @10.0.10.5 doubleclick.net    # resolve + block
dig +short @10.0.10.5 radarr.erfi.io                                         # split-horizon -> 10.0.10.1

# API (token by var reference, never printed)
curl -H "Authorization: Bearer $TOKEN" https://<glory-hole-host>/api/v1/policy/rules | jq

# vyos-sg (unverified - see deployments table)
ssh vyos-sg 'sudo podman logs --tail 50 gloryhole'
ssh vyos-sg 'sudo systemctl restart vyos-container-gloryhole'
```
