---
name: caddy
description: Use when working on the user's custom Caddy edge reverse-proxy stack at ~/infra/ergo/caddy-compose/ - adding or editing a site block, debugging ACME issuance (Cloudflare or rfc2136/TSIG to Knot), bumping xcaddy plugin versions, or touching the wafctl WAF service or its Astro/React dashboard. Fires on 'caddy', 'Caddyfile', 'wafctl', 'the edge proxy', 'WAF', 'ACME failure', 'make restart'.
---

# caddy — custom build + WAF management stack

Repo: `~/infra/ergo/caddy-compose/`. Deployed to the **MS-01 NixOS router** (ssh alias `router`) as the `edge-services` composer stack since 2026-07-30 - the servarr host-mode caddy AND the servarr composer are RETIRED (containers, `/mnt/user/composer`, `/mnt/cache/caddy`, `/mnt/user/data/authelia` all deleted). The deployed file is **`deploy/edge/Caddyfile`**; the repo-root `Caddyfile` is the legacy servarr config - never edit it for prod changes. Checkout on the router at `/var/lib/composer/stacks/edge-services`, data at `/var/lib/caddy/{data,config,log,waf}` (certs under `data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>/`). Caddy runs `network_mode: host`; wafctl on its own bridge. **No deploy webhook on edge-services** - after pushing, sync+up manually (`POST /api/v1/stacks/edge-services/{sync,up}`) and `docker restart caddy` on the router for Caddyfile changes: the single-file bind mount goes stale-inode on git sync, so `caddy reload` would adapt the OLD inode (restart re-resolves it).

**Project-truth: `~/infra/ergo/caddy-compose/AGENTS.md`** — read first for current versions, counts, and the full gotcha list. This skill is the pattern layer.

## What's in the repo — three things at once

1. **Custom Caddy build** - Dockerfile uses `caddy:${VERSION}-builder` + `xcaddy build` (base now Caddy 2.11.4). Ten compiled-in `--with` plugins: `caddy-dns/cloudflare`, `caddy-dns/rfc2136`, `caddy-dynamicdns` (pinned by commit), `caddy-l4`, first-party `caddy-body-matcher` / `caddy-policy-engine` / `caddy-ddos-mitigator`, and the edge HTTP cache pair `caddyserver/cache-handler` + `darkweak/storages/nuts`. ALL are pinned since 2026-07-25. Two non-plugin build lines: the Souin cache core is OUR FORK (`--with github.com/darkweak/souin=github.com/erfianugrah/souin@v1.7.7-erfi.1`, two patches - see gotcha "edge HTTP cache") and `--replace google.golang.org/grpc@...@v1.82.1` (transitive-dep bump for a HIGH vuln).
2. **Compose stack** — `caddy` (host network), `wafctl` on its own bridge. (Authelia retired 2026-07 - no IdP in the stack anymore.) Each container `read_only` where possible, `cap_drop ALL`, run-as `1000:1000`.
3. **WAF management plane** — `wafctl/` (Go HTTP API + CLI, stdlib only) + `waf-dashboard/` (Astro + React + shadcn), bundled into the wafctl image and proxied at a dedicated subdomain. CRS rules converted from upstream `coreruleset` `.conf` to JSON at build time by `tools/crs-converter/`.

## Caddyfile patterns — the snippet idiom

All snippets are defined inline at the top of the same Caddyfile (no external file resolution — `(name) { ... }` blocks expand at parse time). The adapter resolves snippets TOP-DOWN: importing a snippet defined LATER in the file crash-loops Caddy (`File to import not found`). Most snippets sit at the top, but `(lan_only)` / `(research_auth)` / `(memledger_auth)` are defined mid-file (~line 820) - site blocks importing them MUST go below that point (learned the crash-loop way 2026-08-11).

| Snippet | Purpose |
|---|---|
| `(ddos)` | inline `ddos_mitigator { jail_file ... threshold ... whitelist ... }` |
| `(waf)` | imports `ddos`, sets `X-Request-Id`, runs `policy_engine { rules_file ... reload_interval 5s }`, registers `handle_errors` |
| `(waf_off)` | empty placeholder — metrics/respond-only sites |
| `(tls_config)` | ACME via `dns cloudflare {$CF_API_TOKEN}` — for zones still on Cloudflare DNS |
| `(tls_config_rfc2136)` | ACME via TSIG nsupdate to user's Knot — for zones served by the user's Knot DNS app |
| `(forward_auth)` | RETIRED with Authelia - do not use; legacy configs only |
| `(research_auth)` | bearer-or-LAN gate: deny = NOT remote_ip in (10/8, 100.64/10, 172.16/12, 192.168/16) AND NOT `Authorization: Bearer {$RESEARCH_TOKEN}` - LAN/tailnet pass open, WAN needs the bearer |
| `(proxy_headers)` | `trusted_proxies private_ranges` + `X-Forwarded-For {client_ip}` — used inside reverse_proxy |
| `(error_pages)` | `handle_errors` → template at `/etc/caddy/errors/error.html` |
| `(site_log)` | combined JSON log to `/var/log/combined-access.log`. ~25 `log_append` lines pull `policy_*`, `ddos_*`, `challenge_*` fields lazily. Single source of truth tailed by wafctl. |

Global block uses explicit handler ordering: `order log_append first` → `order ddos_mitigator after log_append` → `order policy_engine after ddos_mitigator` so `log_append` captures action fields even when later handlers short-circuit.

**Canonical per-site shape**:
```caddyfile
example.com {
    import waf
    import research_auth         # only for bearer-gated API surfaces
    import tls_config_rfc2136    # or tls_config for CF-DNS zones
    encode zstd gzip
    reverse_proxy <bridge-ip>:<port> {
        import proxy_headers
    }
    import error_pages
    import site_log example
}
```

Internal admin proxy on a high port IP-restricts to the wafctl bridge subnet and reverse-proxies to `localhost:2019`. **wafctl talks to that proxy port, never `:2019` directly.**

## TSIG + rfc2136 — secret chain to Knot

```caddyfile
(tls_config_rfc2136) {
    tls {
        issuer acme {
            dns rfc2136 {
                key_name "caddy-acme."
                key_alg "hmac-sha256"
                key {$TSIG_CADDY_ACME}
                server "<knot-public-ip>:53"
            }
            propagation_delay 30s
            resolvers <knot-public-ip>
        }
    }
}
```

**Three-edit rule** — adding/changing a TSIG-using env var needs three simultaneous edits or Caddy crash-loops:

1. `.env` — `TSIG_CADDY_ACME=<base64>` (SOPS-encrypted, age recipient must match composer's)
2. `compose.yaml` — `- TSIG_CADDY_ACME=${TSIG_CADDY_ACME}` passthrough on the `caddy` service
3. `Caddyfile` — `key {$TSIG_CADDY_ACME}` reference inside the rfc2136 block

**Secret flow**: SOPS in git → Composer decrypts at deploy time → plaintext into container env → Caddy reads at startup → caddy-dns/rfc2136 sends signed `nsupdate`-style UPDATE to Knot.

Verify post-restart that the plaintext actually loaded (not the ciphertext):

```bash
ssh router 'docker inspect caddy --format "{{range .Config.Env}}{{println .}}{{end}}" | grep TSIG_'
```

Rotation order (see `knot-dns` skill for the full procedure): rotate on Knot first, then here, else any ACME renewal in the gap returns `BADSIG`.

## wafctl — what it is and where it sits

Zero-dep Go (stdlib only). Default invocation runs the HTTP API; subcommands are thin clients. Two control surfaces matter:

- **Inbound from Caddy** — tails the combined access log (read-only mount); jail.json bidirectional sync with the ddos-mitigator plugin under flock.
- **Outbound to Caddy** — writes `policy-rules.json` atomically (the plugin mtime-polls every few seconds); pokes Caddy admin via the IP-restricted proxy port using `extra_hosts: caddy:<gateway-ip>` because Docker inter-network isolation blocks docker0.

**The reload trick**: Caddy's `/load` short-circuits with `"config is unchanged"` when only `import`-ed files differ. wafctl injects a SHA-256 fingerprint comment into the Caddyfile body it POSTs to force reprovision (the on-disk Caddyfile is never modified).

CLI shape (top-level subcommands): `serve` (default), `version`, `health`, `config`, `rules`, `deploy`, `events`, `ratelimit`/`rl`, `csp`, `lists`, `blocklist`. Flags: `--addr`, `--json`, `--file/-f`.

For exact command surface + endpoint list run `wafctl --help` inside the container; spec changes per release.

## Auth patterns (post-Authelia)

Authelia was retired 2026-07 (edge-SSO plan abandoned; its data dir deleted).
No forward-auth IdP remains in the stack. Current shapes:

| Pattern | Site shape |
|---|---|
| A - no auth | `import waf` + `reverse_proxy` |
| B - bearer-or-LAN | `import research_auth` + `reverse_proxy` - used for the private API surface (searxng/crawler/osint/llama.erfi.io): LAN + tailnet pass open, WAN needs `Authorization: Bearer $RESEARCH_TOKEN` |
| C - mixed public/API | `route { @public path /api/* /webhooks/*; reverse_proxy @public ...; ... }` - first match wins |

`RESEARCH_TOKEN` must be in the caddy container's `environment:` in
deploy/edge/compose.yaml (it is), not just `.env` - else the matcher compares
against an empty string and nothing authenticates.

## Build / release — make targets

| Target | What |
|---|---|
| `make build` / `build-caddy` / `build-wafctl` | local docker build; `NO_CACHE=1` to force plugin re-pull |
| `make push` / `push-caddy` / `push-wafctl` | to the user's Docker Hub namespace |
| `make scan` | Trivy CRITICAL+HIGH gate |
| `make sign` / `sbom` | cosign keyless + syft attestations |
| `make deploy` / `deploy-*` / `deploy-all` | build → scan → push → sync → restart |
| `make caddy-reload` | sync git + redeploy WAF/CSP/headers via wafctl + reload (no container restart) |
| `make caddy-quick-reload` | sync git + reload only |

### `make restart` vs `make restart-caddy` — the single biggest footgun

- **`make restart`** — calls the Composer API (edge-services stack on the router). Composer decrypts SOPS `.env` first. **Only safe path for changes touching `.env` or env-var passthrough.** There is NO deploy webhook on edge-services, so every deploy is this manual step.

`restart` depends on `prep-composer-tree` which `docker exec -u composer composer git ... reset --hard HEAD` to wipe the dirty tree left by SOPS re-encrypt. The `-u composer` flag is mandatory — root-owned files break the next decrypt.

For a **stuck cert state** (deleted on disk but Caddy still serves cached), use `docker restart caddy` (preserves resolved env, empties in-memory cert cache) — NOT `make restart-caddy`.

## Docker image build flow — four stages

1. `xcaddy build` with the `--with` modules.
2. `golang:*-alpine` builds `crs-converter`, clones CRS at the pinned version, emits `default-rules.json` + `crs-metadata.json` (folding in `waf/custom-rules.json`).
3. `alpine` fetches Cloudflare IP ranges, builds `cf_trusted_proxies.caddy` with `trusted_proxies static <cidrs>`.
4. Runtime `caddy:*-alpine` copies built binary + assets + entrypoint. Adds `nftables`. Entrypoint seeds the CF-IP file if missing then `exec caddy run`.

**Version-tag sync** — Makefile / compose.yaml / `.github/workflows/build.yml` / README must agree. `CADDY_TAG` (published image) is distinct from `CADDY_VERSION` (upstream base they trail).

## Gotchas — the durable list

1. **`make restart-*` bypasses SOPS** → ciphertext env → crash loop. Use `make restart`.
2. **Three-edit rule** for new env vars — `.env` + `compose.yaml` passthrough + consumer config. Partial deploys crash.
3. **Composer SOPS re-encrypt leaves a dirty tree** → next `git pull` refuses → next deploy uses stale code. `prep-composer-tree` resets it; must run as `-u composer`.
4. **The composer instance's WAF blocks default `curl` UA on PUT/POST** (not GET). Send a browser-style `User-Agent` plus `Origin` and `Referer` matching the page. 403 with a reference-ID = this rule.
5. **`caddy reload` is sticky** — `"config is unchanged"` short-circuits and does NOT re-evaluate cert state, even if cert files were deleted. Force re-issue: `docker restart caddy`.
6. **TSIG rotation order**: Knot first, then here. ACME renewals in the gap return `BADSIG`.
7. **Zone migration**: when a zone moves CF DNS → Knot, every site block under it MUST swap `import tls_config` → `import tls_config_rfc2136`. Otherwise Caddy writes ACME TXT to CF while validators ask Knot → silent failure once recursive caches expire.
8. **Pin every xcaddy module.** Unpinned modules float on `--no-cache` rebuilds - new `caddy-l4` releases raised the `caddy/v2` minimum twice and broke older bases (now all pinned since 2026-07-25). When bumping any module OR the Caddy base, bump them all to latest known-good and verify with `docker run --rm <image> /usr/bin/caddy list-modules`. For a non-plugin transitive dep bump (e.g. a HIGH-vuln gRPC), use xcaddy `--replace module=module@version` (go.mod replace, no blank import), not `--with`.
9. **Edge HTTP cache (edge variant only).** Souin core is OUR FORK (`github.com/erfianugrah/souin@v1.7.7-erfi.1`) with two patches (born-stale Store() fix; revalidation double-store fix). `order cache after policy_engine` so WAF blocks never enter the cache. Enabled on docs.erfi.io (whole-site, `disable_query`), jellyfin (`/Items/*/Images/*` only), navidrome (`/rest/getCoverArt*` only), erfianugrah.com + revista.erfi.io (whole-site static Astro, response-CC-governed, `disable_query`). `stale-if-error` in the site `default_cache_control` is REQUIRED for origin-down insurance (else origin-down past TTL = 502). **No working purge**: the souin admin API permanently returns `[]` and admin PURGE is a no-op; reclaim = `scripts/cachectl.sh purge <site>` (deletes the site's nuts dir + `docker restart caddy`). Storage layout is load-bearing (2026-07-31 incident): per-site `nuts { configuration { Dir /data/cache/nuts/<site>; EntryIdxMode HintKeyAndRAMIdxMode } }` - NEVER a global nuts block (registration race -> silent in-memory fallback) and `Dir` must sit inside `configuration` (else `nuts.Factory` drops the path -> tmpfs `/tmp/souin-nuts`, wiped per restart). Full quirks + evidence: `test/cache/README.md`; harness `make test-cache`; ops + config pattern: the `souin` skill; live checks `scripts/cachectl.sh status|verify|probe`.
10. **Version-tag drift** - see above.
11. **wafctl <-> Caddy admin routing**: `extra_hosts: caddy:<bridge-gateway>` required (Docker inter-network isolation blocks docker0). Talk to the proxy port, not `:2019`.
12. **Snippet import order** - see the snippet-idiom section: top-down resolution, forward reference = crash loop. `(research_auth)` and friends live ~line 820, not the top.
13. **Pre-commit hook** blocks unencrypted `.env` / `.tfvars` / `.tfstate` (looks for `ENC[AES256_GCM,` or `sops_*` markers). Override per-path via `.allow-unencrypted-paths`.
14. **wafctl event-store retention** - bounded by `WAF_EVENT_MAX_AGE` / `WAF_GENERAL_LOG_MAX_AGE`. Size on disk scales with traffic; check AGENTS.md for current envelopes before sizing a new deploy.

## Subdirectory map

| Dir | What |
|---|---|
| `deploy/edge/` | the LIVE deploy: `Caddyfile` + `compose.yaml` (+ retired `authelia/` - historical) |
| `errors/` | `error.html` — template-driven 4xx/5xx with WAF-specific 403/429 |
| `scripts/` | `entrypoint.sh`, `setup-cors.sh`, `update-geoip.sh` |
| `test/` | `Caddyfile.e2e/.test`, Go e2e tests, CRS official YAML test cases |
| `test/cache/` | Edge HTTP cache harness (`run-tests.sh`, `origin.py`, `Caddyfile.test`) + `README.md` (7 verified Souin quirks). `make test-cache` runs it against the binary from `CADDY_IMAGE` |
| `tools/crs-converter/` | Standalone Go binary — CRS SecRule `.conf` → JSON. Invoked at build + `make generate-rules` |
| `waf/` | Committed crs-converter outputs (`custom-rules.json`, `default-rules.json`, `crs-metadata.json`) |
| `waf-dashboard/` | Astro + React + shadcn frontend. Embedded into wafctl image. |
| `wafctl/` | Go HTTP API + CLI (stdlib only). Owns `main.go` env wiring + `cli*.go` subcommands |

## Roadmap — describe as roadmap, not capability

- **`PLAN.md`** — Postgres + Valkey storage migration (interface extraction → events → IP jail → RL counters).
- **`CHALLENGE_HARDENING_PLAN.md`** — server-side JS mutation, app-state verification, expanded fingerprint surface, encrypted signal transport, behavioural signals, dedicated canvas testing.
- **`L4_INTEGRATION_PLAN.md`** — unify L4 + L7 enforcement under wafctl. Today only the `caddy-l4` listener wrappers + DDoS mitigator + raw SSH passthroughs ship.

Check status checkboxes in each PLAN before claiming anything beyond "in design".

## Cross-references

- **`knot-dns` skill** + `~/infra/knot-fly/AGENTS.md` — upstream of rfc2136; owner of TSIG rotation procedure and force-renewal recipe.
- **`composer` skill** — composer API endpoints (`stacks/<name>/{sync,up}`, `stacks/<name>/env`), the WAF UA gotcha for PUT/POST, SOPS-decrypt-on-deploy contract.
- **`infrastructure-stack` skill** — SOPS+age, compose conventions, Unraid+cache patterns, healthchecks, read-only rootfs, cap_drop.
- **`tailscale-homelab` skill** — every `ssh router` invocation below assumes this works.
- **NOT Fly** — this stack doesn't deploy to Fly. Only Knot does.

## Operator recipes — `ssh router` snippets

```bash
# Inspect a live cert (substitute your hostname)
HOST=caddy.example.com
CERT_DIR=/var/lib/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$HOST
ssh router "openssl x509 -in $CERT_DIR/$HOST.crt -noout -dates -issuer"

# Force-renew a single site (delete + restart, NOT reload)
ssh router "rm $CERT_DIR/$HOST.{crt,key,json}"
ssh router "docker restart caddy"
ssh router "docker logs --since 1m caddy 2>&1 | grep -iE '$HOST|acme'"

# Watch ACME activity live
ssh router 'docker logs -f caddy 2>&1 | grep -E "tls.obtain|authorization|finalize|obtained|BADSIG|BADKEY"'

# Verify TSIG plaintext actually loaded
ssh router 'docker inspect caddy --format "{{range .Config.Env}}{{println .}}{{end}}" | grep TSIG_'

# wafctl health (replace with current bridge IP from compose.yaml)
ssh router 'curl -sf http://<wafctl-bridge-ip>:8080/api/v1/health | jq'
```
