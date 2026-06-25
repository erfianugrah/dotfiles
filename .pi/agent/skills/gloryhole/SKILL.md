---
name: gloryhole
description: "Work in the user's self-built DNS resolver `glory-hole`, now at `~/knotea/resolver/` (the merged knotea binary; since the 2026-06-25 cutover the live `glory-hole` Fly app is ALSO the authoritative NS for `erfi.io`+`lab.erfi.io` at `137.66.1.170`) — Go binary + embedded Unbound recursor + loopback knotd + Astro/React dashboard. Pi-hole-style ad-blocking, expr-based policy engine, local records, conditional forwarding, sharded LRU cache, SQLite query log, REST/WS API, DoT/DoH. Three deployment profiles — home (LAN-fronted, VyOS upstream on servarr), a VyOS podman LAN resolver (vyos-sg), and a public DoT/DoH endpoint on Fly.io (sin region). Covers the packet-path through `pkg/dns` → policy → blocklist → cache → forwarder, the `pkg/forwarder` round-robin + circuit-breaker + UpstreamHealth model, SERVFAIL pass-through semantics, bundled-Unbound topology, Fly UDP-binding requirements, OpenTelemetry+Prometheus pattern, and the mock-DNS-server test idiom. Use when adding a forwarder/policy/blocklist feature, debugging a SERVFAIL path, designing telemetry, or touching the Fly deploy. Sibling to `knot-dns`, `knotctl`, and `fly` (deploy target)."
---

# gloryhole — self-built DNS server

> **knotea merge (2026-06-16)** — glory-hole is being merged with `knot-fly`
> (authoritative DNS) into a single supervised binary, `knotea`. The monorepo
> lives at `~/knotea/` with glory-hole under **`~/knotea/resolver/`** and
> knot-fly under `~/knotea/authority/`. The monorepo is the canonical source
> tree. **P6 cutover DONE (2026-06-25):** the live `glory-hole` Fly app (sin,
> anycast v4 `137.66.1.170`) now runs the merged knotea binary and is the
> **authoritative** nameserver for `erfi.io` + `lab.erfi.io` — the Namecheap glue
> was swapped off `knot-fly-mvp` (`169.155.56.21`, frozen, pending retirement
> after soak). The binary supervises both Unbound (recursive, `127.0.0.1:5353`)
> and knotd (authoritative, `127.0.0.1:5354`) — co-location fixes the Fly UDP
> hairpin SERVFAIL on `*.erfi.io` (knot-dns gotcha #24). Plans:
> `~/knotea/docs/plans/2026-06-16-knotea-merge.md` +
> `~/knotea/docs/plans/2026-06-25-knotea-cutover-runbook.md`. Sibling skills:
> `knot-dns`, `knotctl`.

Repo: `~/knotea/resolver/` (canonical source; the live `glory-hole` app builds from the monorepo root Dockerfile as of the cutover). Module path `glory-hole` (single Go module). Binary / image / Fly app: `glory-hole` (cosmetic name — Fly can't rename in place; the binary is knotea). Don't conflate the two.

**Project-truth: `~/knotea/resolver/AGENTS.md` + `~/knotea/resolver/CHANGELOG.md`** — read first for current version, config schema, and per-feature decisions. Root merge guardrails live in `~/knotea/AGENTS.md` + `~/knotea/docs/plans/2026-06-16-knotea-merge.md`. This skill is the pattern layer.

## What it is — one self-contained binary

Single Go binary that combines:

- DNS server (UDP/TCP/:53, DoT/:853, DoH on the API port)
- Pi-hole-style blocklists with downloader + atomic-pointer swaps
- `expr`-based policy engine (BLOCK / ALLOW / REDIRECT / FORWARD actions)
- Authoritative local records (A/AAAA/CNAME/TXT/MX/PTR/SRV/NS/SOA/CAA + wildcards)
- Conditional forwarding (priority-sorted rules)
- Sharded LRU cache with TTL + blocked-TTL override
- SQLite query log (modernc.org/sqlite — CGO=0; WAL; async-buffered writes)
- REST + Server-Sent-Events + WebSocket API with API key / Basic / session+CSRF auth
- Embedded Astro + React + shadcn dashboard (go:embed)
- **Bundled Unbound recursor** built from source in the Docker image, supervised as a child process on a loopback port — provides DNSSEC-validated recursion without trusting an upstream

Three live deployments:

| Profile | Where | Upstream | Purpose |
|---|---|---|---|
| home | LAN (deployed on `servarr`) | site router | LAN ad-block + local records for internal hostnames |
| LAN resolver (SG) | VyOS podman container on `vyos-sg` @ `172.16.0.5` (config `/config/erfi/gloryhole/config.yml`) | bundled Unbound (loopback) | Replaced pihole+unbound+httpbun as the Singapore site resolver (2026-06-03). DHCP name-server (4 subnets), `system name-server`, and `service dns forwarding` all point at it |
| public DoT/DoH **+ authoritative** | Fly.io — `sin`, anycast v4 `137.66.1.170` | bundled Unbound (loopback) + embedded knotd (`127.0.0.1:5354`) | DoT/DoH for personal devices, ad-block — **and** since the 2026-06-25 cutover the authoritative NS for `erfi.io` + `lab.erfi.io` (glue points here). Auth-zone queries bypass the recursive client ACL + blocklist/cache and route to loopback knotd |

## Architecture — packet path

```
client → [UDP/TCP :53 | DoT :853 | DoH on API port]
       → pkg/dns Handler.ServeDNS
         1. allowed_clients gate (IP/CIDR allowlist for plain DNS)
         2. EDNS0 buffer + DO-bit preserved
         3. Policy engine (expr rules; BLOCK / ALLOW / REDIRECT / FORWARD)
         4. Local records (CNAME chain resolution)
         5. Blocklist check (atomic.Pointer hash + pattern match)
         6. Cache lookup
         7. Conditional forwarding evaluator (priority-sorted rules)
              → forwarder.ForwardWithUpstreams(ctx, msg, override)
            else default forward
              → forwarder.Forward(ctx, msg)         # round-robin UDP
              → forwarder.ForwardTCP(ctx, msg)      # TCP variant
         8. Cache.Set, write response (writeMsg sets TC bit + strips
            Answer if UDP response > EDNS0 buffer / 512)
         9. Async query log → SQLite worker pool
```

Filtering (`pkg/blocklist`, `pkg/policy`, `pkg/pattern`) runs **inside the handler**, before the forwarder is touched — fast-path lookups, lock-free reads. Telemetry is recorded by the handler (`recordForwardedQuery`), not by the forwarder.

## Package map

| Package | Role |
|---|---|
| `cmd/glory-hole/main.go` | CLI flags, lifecycle wiring, config-watcher OnChange callbacks, whitelist→policy migration. Subcommands: `import-pihole`, `hash-password`. |
| `pkg/dns/` | UDP/TCP servers, Handler, `handler_forwarding.go` (delegates to forwarder), EDE extraction, dnstap correlation with Unbound |
| `pkg/forwarder/` | `forwarder.go` (Forwarder type, `Forward`/`ForwardTCP`/`ForwardWithUpstreams`), `circuit_breaker.go`, `health.go` (UpstreamHealth), `evaluator.go` (priority-sorted ConditionalRule), `matcher.go` (DomainMatcher / CIDRMatcher / QueryTypeMatcher) |
| `pkg/unbound/` | Process supervisor, typed config model, `text/template` writer for `unbound.conf`, dnstap reply buffer, stats parser, `/api/unbound/*` endpoints |
| `pkg/blocklist/` | Downloader uses `pkg/resolver` HTTP client → upstream DNS (never `/etc/resolv.conf`); atomic.Pointer swaps; pattern stats |
| `pkg/policy/` | `expr-lang/expr` engine; helpers `Domain`, `DomainMatches`, `DomainEndsWith`, `IPInCIDR`, `Hour`, `InTimeRange`, `QueryTypeIn` |
| `pkg/pattern/` | Exact / wildcard / regex matcher — Pi-hole compatible (`/^regex$/`) |
| `pkg/localrecords/` | Authoritative answers, CNAME chain resolution |
| `pkg/cache/` | Sharded LRU + TTL, blocked-TTL override, gauge-tracked size |
| `pkg/storage/` | SQLite via `modernc.org/sqlite`, WAL, async buffered writes, retention sweeper, migrations |
| `pkg/config/` | YAML load + validate, fsnotify watcher, hot-reload diff helpers |
| `pkg/telemetry/` | OpenTelemetry meter + Prometheus exporter, basic-auth wrapper for `/metrics` |
| `pkg/resolver/` | `net.Resolver` over configured upstreams; factories the HTTP clients used by blocklist downloader, ACME, etc. |
| `pkg/api/` | REST handlers, middleware (rate-limit, CSRF, auth), DoH endpoint. Dashboard embedded via `go:embed pkg/api/ui/static/dist/` |

## Forwarder — the design rules

### Forward path (`Forward` / `ForwardTCP` / `ForwardWithUpstreams`)

```go
attempts := min(retries, len(upstreams))
for i := 0; i < attempts; i++ {
    upstream := selectUpstream()    // round-robin over GetHealthyUpstreams()
    client := clientPool.Get()      // UDP only; TCP creates fresh per call
    // wrap in breaker.Call(...) if health is registered
    resp, _, queryErr := client.ExchangeContext(ctx, r, upstream)
    if queryErr != nil { lastErr = queryErr; continue }   // network err → retry
    if resp == nil    { continue }                          // nil → retry
    return resp, nil                // ANY rcode → return immediately
}
return nil, fmt.Errorf("all upstream servers failed: %w", lastErr)
```

**Key invariants**:

- **SERVFAIL/NXDOMAIN/REFUSED are valid DNS responses, not errors.** They are returned to the client immediately, never retried. Retrying would be both an RFC violation and a security risk — it can mask a DNSSEC-bogus response by retrying against a non-validating upstream. The code comment is intentional and load-bearing.
- **UDP uses a `sync.Pool` of `*dns.Client`. TCP does not** — `ForwardTCP` constructs a fresh client per call. Higher TCP volume = more allocations; budget accordingly.
- **Circuit breaker is disabled when the only upstream is loopback.** `forwarder.NewForwarder` detects `isLocalUpstream` and skips registration — otherwise a transient hiccup against the bundled Unbound would trip the breaker into a death spiral against a process the same host supervises.

### Circuit breaker (`circuit_breaker.go`)

Atomic state machine (Closed/Open/HalfOpen) per upstream. Tunable failure threshold, success threshold, timeout, half-open concurrent-probe cap. `UpstreamHealth` is `map[string]*CircuitBreaker` with `sync.RWMutex` + `AddUpstream`/`RemoveUpstream`.

### Conditional rules (`evaluator.go`)

`RuleEvaluator` holds priority-sorted compiled rules. `Evaluate(domain, clientIP, qtype) → []string` upstreams or `nil` to fall through to default forward. Matchers are AND-combined. Empty matcher = wildcard.

### Adding a forwarder feature — the shape to follow

1. Add a typed config struct under `ForwarderConfig` (`yaml`-tagged).
2. Wire it through `NewForwarder` so defaults are clear and dependent fields validate at startup.
3. Branch in `Forward`/`ForwardTCP` minimally — keep the round-robin + retry loop intact; new behaviour is a decision **after** a successful `ExchangeContext`.
4. Respect the circuit breaker — any retry/escalation MUST go through `breaker.Call` so half-open accounting stays correct.
5. Mirror the v0.7.8 SERVFAIL pass-through ethos — opt-in, narrowly scoped, ideally restricted to a configured upstream allowlist (e.g. only the bundled Unbound, where a TCP retry papers over a UDP path glitch without crossing security boundaries).
6. Test by extending `forwarder_test.go` — see test patterns below.

## Bundled Unbound — runtime topology

Inside the Docker image, Unbound is built from source (libevent, OpenSSL, dnstap, fstrm, protobuf-c) and supervised as a child process on a loopback port. On the Fly profile, `upstream_dns_servers` is empty — Unbound is the **only** upstream, and the breaker is disabled (above).

`docker-entrypoint.sh` copies the baked `/etc/glory-hole/config.yml` to the persistent volume on **first boot only** — UI-written changes survive deploys. Force a reset by removing the file and restarting the machine.

## Fly deployment — `Dockerfile.fly` + `fly.toml` shape

Tiny `Dockerfile.fly` layers `config.fly.yml` + entrypoint onto the pre-built `<docker-namespace>/glory-hole:${VERSION}` image. Three services in `fly.toml`:

| Service | Notes |
|---|---|
| HTTP API (force_https, min=1) | UI + DoH + Prometheus scrape target |
| `:53/UDP` | **Plain UDP DNS — needs a dedicated v4 (`fly ips allocate-v4`)** and bind to `fly-global-services:53`, not `:53`. Plain UDP cannot see real client IPs (Fly NATs) — rely on `trusted_proxies` + PROXY proto on TCP/DoT for client identification. |
| `:53/TCP`, `:853/TCP` (DoT) | Both PROXY-proto so real client IPs survive |

Persistent volume mounted at `/var/lib/glory-hole`. Primary region is **`sin`** (migrated from `fra` 2026-06-03; the dedicated v4/v6 anycast IPs + the Fly-managed cert are app-level and survived the region move).

Deploy: `make fly-deploy` (= `docker-fly` + push + `fly deploy --build-arg VERSION=… --build-arg BUILD_TIME=…`) or `fly deploy --remote-only`. CI deploys on tag push.

## Config schema — comparing profiles

Top-level keys (from `pkg/config/config.go`):

```
telemetry, server, policy, auth, local_records, conditional_forwarding,
forwarder (.circuit_breaker), upstream_dns_servers, blocklists, whitelist,
logging, database, cache, block_page, unbound,
update_interval, auto_update_blocklists
```

`config.yml` and `config.fly.yml` are **gitignored** — they carry real tokens, bcrypt hashes, allowlists. The repo only ships `config/config.example.yml`. `config.test.yml` is in-repo but **out of date** — it still references the pre-v0.5 `storage:` block and defunct top-level `policies:`/`tls:`/`dot_*:` keys. Don't copy it.

For the per-profile diff (cache sizing, retention windows, listen addresses, allowlists, query-logger workers), read `AGENTS.md` — it changes with each release.

## Telemetry

`pkg/telemetry/telemetry.go` shape:

```go
meter := provider.Meter("glory-hole")
counter, _ := meter.Int64Counter("dns.queries.total",
    metric.WithDescription("..."))
histogram, _ := meter.Float64Histogram("dns.query.duration",
    metric.WithUnit("ms"))
gauge, _ := meter.Int64UpDownCounter("clients.active",
    metric.WithDescription("..."))
```

Setup chain: `prometheus.New()` exporter → `sdkmetric.NewMeterProvider(WithResource, WithReader(exporter))` → `otel.SetMeterProvider(provider)`. The Prometheus HTTP server is **separate** from the API server: `mux.Handle("/metrics", promhttp.Handler())` on its own port, optional basic auth via `metrics_username`/`metrics_password`, `ReadHeaderTimeout: 10s` (Slowloris guard).

Tracing is a stub (`tracenoop.NewTracerProvider()`); `cfg.TracingEndpoint` is read but no OTLP exporter is wired.

Adding a counter: define field on `Metrics`, instantiate with `meter.Int64Counter` in the constructor, call `m.X.Add(ctx, 1, metric.WithAttributes(...))` from the handler. UpDown counters serve as gauges.

## Test patterns — the mock-DNS-server idiom

`pkg/forwarder/forwarder_test.go` `mockDNSServer` is the canonical helper used across the whole package:

```go
func mockDNSServer(t *testing.T, responses map[string]*dns.Msg) (string, func()) {
    pc, _ := net.ListenPacket("udp", "127.0.0.1:0")     // ephemeral port
    addr := pc.LocalAddr().String()
    go func() {
        buf := make([]byte, 512)
        for {
            n, clientAddr, err := pc.ReadFrom(buf)
            if err != nil { return }
            req := new(dns.Msg); req.Unpack(buf[:n])
            if mockResp, ok := responses[req.Question[0].Name]; ok {
                resp := mockResp.Copy(); resp.SetReply(req)
                packed, _ := resp.Pack()
                pc.WriteTo(packed, clientAddr)
            }   // else: default NXDOMAIN
        }
    }()
    return addr, func() { pc.Close() }
}
```

Naming: `TestForward_<scenario>` (`Success`, `RoundRobin`, `Timeout`, `Retry`, `SERVFAIL`, `SERVFAIL_PassThrough`, `ContextCancellation`). Use `t.Fatal` for setup, `t.Errorf` inside loops. Never pass `nil` loggers — `logging.NewDefault()` returns a working slog. Race detector mandated in CI (`make test-race`). Coverage target ≥80 % per package, 90 %+ for DNS handler and policy.

E2E via `docker-compose.e2e.yml` — auth disabled, all features on, high ports so no privileges needed.

## Build / deploy

| Target | What |
|---|---|
| `make ui` | Build Astro dashboard into `pkg/api/ui/static/dist/` |
| `make build` | UI + Go binary with ldflags injecting `version` / `buildTime` / `gitCommit` |
| `make build-all` | Cross-compile linux/darwin/windows × amd64/arm64 |
| `make test` / `test-race` / `test-coverage` | `go test -v` / `-race` / `-cover` |
| `make lint` | Per-directory `golangci-lint run --timeout=5m` (sidesteps a toolchain bug with the all-package form) |
| `make dev` / `make run` | `go run` / built binary |
| `make docker` | Full multi-arch (`Dockerfile`); Unbound built from source |
| `make docker-fly` | `Dockerfile.fly` layer atop the published image |
| `make fly-deploy` | docker-fly → push → `fly deploy` |
| `make release` | `lint test build` |

**Three Dockerfiles**:

- `Dockerfile` — full build, Unbound + UI + Go inside the image. Supports `--mount=type=cache` for the Go build cache.
- `Dockerfile.release` — used by GoReleaser CI; skips the Go build stage, copies pre-built binaries from the buildx context. Faster multi-arch.
- `Dockerfile.fly` — 4-line layer atop the published image to bake the Fly config.

## Gotchas — the durable list

1. **Fly UDP/53 binding** — must be `fly-global-services:53`, not `:53`. Set via `server.udp_listen_address`. Plain UDP DNS on Fly cannot see real client IPs; rely on PROXY proto on TCP/DoT for client identification.
2. **Fly anycast UDP unreliability** — UDP path between Fly edges and the machine is best-effort; transient losses can surface as SERVFAIL upstream errors. This is the motivation for any opt-in TCP-retry feature against `127.0.0.1` Unbound. See `knot-dns` skill for the hairpin-block sibling problem on a Fly-hosted Knot.
3. **Circuit breaker death spiral on local Unbound** — disabled by `forwarder.NewForwarder` when the only upstream is loopback. Don't re-enable it for the Fly profile.
4. **SERVFAIL pass-through is RFC-mandated** — a v0.7.8 fix removed all SERVFAIL retry logic. Any new retry path must be opt-in and narrowly scoped or it regresses DNSSEC-validation security.
5. **Whitelist is migrated, not honored** — at boot, `migrateWhitelistToPolicies` rewrites each entry into an ALLOW policy rule and clears `cfg.Whitelist`. Editing `whitelist:` post-migration is a no-op.
6. **`config.yml` and `config.fly.yml` are gitignored** — real tokens, hashes, allowlists. Don't paste them into PRs or commit them.
7. **First-boot config copy on Fly** — `docker-entrypoint.sh` copies the baked image config to the volume only if absent. Subsequent deploys preserve UI-written changes. Force reset: `fly ssh console`, remove the file, restart.
8. **TCP forward path has no client pool** — `ForwardTCP` allocates fresh per call.
9. **UDP response size + TC bit** — `Handler.writeMsg` enforces `EDNS0 UDPSize()` (or 512) on UDP, sets `Truncated: true`, strips Answer. Forces client TCP retry. Don't disable without an alternative anti-amplification guard.
10. **Dashboard rebuild is silent** — Astro lives under `pkg/api/ui/dashboard/`; touching `package.json` requires `npm ci && npm run build`. Embedded via `go:embed`, so a stale `dist/` ships into the binary without warning.
11. **Hot reload coverage** — config-watcher `OnChange` reloads blocklist, policy, local records, whitelist (→ policy), conditional forwarding, rate limit, forwarder. Listen-address changes still require restart.
12. **Repo dir vs binary name** — `gloryhole/` on disk, `glory-hole` everywhere else. Don't fight it.
13. **VyOS container deploy (equuleus 1.3, `vyos-sg`)** — the gotchas that cost time: (a) run config sessions via `ssh vyos-sg 'vbash -s' <<EOF … EOF` — `bash -s` silently fails to persist `set`s; (b) `volume`/`port` attributes must be separate per-leaf `set` commands, not a combined one-liner; (c) the **plain** `erfianugrah/glory-hole` image bakes `config.example.yml`, NOT `config.yml`, so the default `-config /etc/glory-hole/config.yml` fails — override with `set container name gloryhole command '-config'` + `arguments '/var/lib/glory-hole/config.yml'` pointing at the mounted config; (d) VyOS `service dns forwarding` **recurses independently** unless given `name-server <glory-hole-ip>` — without it the DHCP-secondary/gateway path bypasses ad-blocking. Web UI reached at `http://172.16.0.5:8080` (host-port `:3021` mapping is flaky — podman port-forward quirk).

## Cross-references

- **`knot-dns` skill** — sibling DNS work but opposite role (authoritative vs recursive); shares the Fly anycast UDP-hairpin lessons.
- **`fly` skill** — deploy target; UDP binding requirements, `fly ips allocate-v4`, PROXY proto, volume mounts.
- **`composer` skill** — if running as a managed compose stack rather than direct Fly app.
- **Prometheus / Grafana** — scrape on the metrics port; dashboards live in `deploy/grafana/`, alerts in `deploy/prometheus/alerts/`.
- **Pi-hole import** — `glory-hole import-pihole --zip ...` consumes Teleporter archives; pattern matching is intentionally Pi-hole-compatible.

## Operator recipes

```bash
# Local dev (auth off, high ports — see config.e2e.yml)
docker compose -f docker-compose.e2e.yml up

# Tail Fly logs
fly logs -a glory-hole

# Inside the Fly machine — inspect Unbound supervisor
fly ssh console -C 'cat /var/log/unbound/unbound.log | tail -50'

# Force reset of UI-modified config on Fly
fly ssh console -C 'rm /var/lib/glory-hole/config.yml'
fly machine restart <id>

# Drive the API (replace token with real one from UI; substitute your hostname)
curl -H "Authorization: Bearer $TOKEN" https://<your-glory-hole-host>/api/v1/policy/rules | jq

# --- vyos-sg LAN resolver (podman container managed by VyOS config) ---
# Logs / status
ssh vyos-sg 'sudo podman logs --tail 50 gloryhole'
ssh vyos-sg 'sudo podman ps --filter name=gloryhole'
# Edit container config (vbash, NOT bash)
ssh vyos-sg 'vbash -s' <<'EOF'
source /opt/vyatta/etc/functions/script-template
configure
set container name gloryhole image 'docker.io/erfianugrah/glory-hole:<new-tag>'
commit
save
exit
EOF
# Config lives on the host volume; restart picks up edits
ssh vyos-sg 'sudo vi /config/erfi/gloryhole/config.yml'   # then:
ssh vyos-sg 'sudo systemctl restart vyos-container-gloryhole'
# Verify resolve + block (172.16.0.5 direct, or gateway 10.68.69.1 via dns-forwarding)
ssh vyos-sg 'dig +short @172.16.0.5 example.com; dig +short @172.16.0.5 doubleclick.net'
# Web UI: http://172.16.0.5:8080  (login erfi / shared-with-Fly creds)
```
