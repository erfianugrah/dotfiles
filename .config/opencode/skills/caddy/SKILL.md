---
name: caddy
description: Drive the user's custom Caddy build + WAF management stack at `~/ergo/caddy-compose/` — the host-mode reverse proxy that fronts the user's `*.<your-zone>` services on `servarr`. Covers the xcaddy plugin set (cloudflare, rfc2136, dynamicdns, l4, body-matcher, policy-engine, ddos-mitigator), the Caddyfile snippet idiom (`(waf)`, `(forward_auth)`, `(tls_config)` vs `(tls_config_rfc2136)`, `(site_log)`, `(proxy_headers)`), the TSIG/rfc2136 secret chain to Knot, the wafctl Go service + Astro/React dashboard, Authelia forward-auth integration, the `make restart` vs `make restart-caddy` SOPS footgun, and the zone-migration pattern. Use when working in `~/ergo/caddy-compose/`, adding a new site block, debugging an ACME failure, bumping a plugin version, or touching anything wafctl. Sibling to `knot-dns` (TSIG upstream), `composer` (deployment platform), `infrastructure-stack` (SOPS + compose patterns).
---

# caddy — custom build + WAF management stack

Repo: `~/ergo/caddy-compose/`. Deployed to `servarr` under `/mnt/user/composer/stacks/caddy/`, data on cache SSD at `/mnt/cache/caddy/{site,data,config,log,waf,wafctl/...}`. Caddy itself runs `network_mode: host`; Authelia and wafctl sit on dedicated bridges.

**Project-truth: `~/ergo/caddy-compose/AGENTS.md`** — read first for current versions, counts, and the full gotcha list. This skill is the pattern layer.

## What's in the repo — three things at once

1. **Custom Caddy build** — Dockerfile uses `caddy:${VERSION}-builder` + `xcaddy build`. Compiled-in modules: `caddy-dns/cloudflare`, `caddy-dns/rfc2136`, `caddy-dynamicdns`, `caddy-l4`, plus first-party `caddy-body-matcher`, `caddy-policy-engine`, `caddy-ddos-mitigator`. Two intentionally unpinned (`caddy-dynamicdns`, `caddy-l4`) — see gotcha "unpinned xcaddy modules".
2. **Compose stack** — `caddy` (host network), `authelia` on its own bridge, `wafctl` on its own bridge. Each container `read_only` where possible, `cap_drop ALL`, run-as `1000:1000`.
3. **WAF management plane** — `wafctl/` (Go HTTP API + CLI, stdlib only) + `waf-dashboard/` (Astro + React + shadcn), bundled into the wafctl image and proxied at a dedicated subdomain. CRS rules converted from upstream `coreruleset` `.conf` to JSON at build time by `tools/crs-converter/`.

## Caddyfile patterns — the snippet idiom

All snippets are defined inline at the top of the same Caddyfile (no external file resolution — `(name) { ... }` blocks expand at parse time).

| Snippet | Purpose |
|---|---|
| `(ddos)` | inline `ddos_mitigator { jail_file ... threshold ... whitelist ... }` |
| `(waf)` | imports `ddos`, sets `X-Request-Id`, runs `policy_engine { rules_file ... reload_interval 5s }`, registers `handle_errors` |
| `(waf_off)` | empty placeholder — metrics/respond-only sites |
| `(tls_config)` | ACME via `dns cloudflare {$CF_API_TOKEN}` — for zones still on Cloudflare DNS |
| `(tls_config_rfc2136)` | ACME via TSIG nsupdate to user's Knot — for zones served by the user's Knot DNS app |
| `(forward_auth)` | Authelia at the auth bridge IP, `uri /api/authz/forward-auth`, copies `Remote-User Remote-Groups Remote-Email Remote-Name` |
| `(research_auth)` | Bearer-token bypass for MCP clients; falls back to forward_auth |
| `(proxy_headers)` | `trusted_proxies private_ranges` + `X-Forwarded-For {client_ip}` — used inside reverse_proxy |
| `(error_pages)` | `handle_errors` → template at `/etc/caddy/errors/error.html` |
| `(site_log)` | combined JSON log to `/var/log/combined-access.log`. ~25 `log_append` lines pull `policy_*`, `ddos_*`, `challenge_*` fields lazily. Single source of truth tailed by wafctl. |

Global block uses explicit handler ordering: `order log_append first` → `order ddos_mitigator after log_append` → `order policy_engine after ddos_mitigator` so `log_append` captures action fields even when later handlers short-circuit.

**Canonical per-site shape**:
```caddyfile
example.com {
    import waf
    import forward_auth          # optional
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
ssh servarr 'docker inspect caddy --format "{{range .Config.Env}}{{println .}}{{end}}" | grep TSIG_'
```

Rotation order (see `knot-dns` skill for the full procedure): rotate on Knot first, then here, else any ACME renewal in the gap returns `BADSIG`.

## wafctl — what it is and where it sits

Zero-dep Go (stdlib only). Default invocation runs the HTTP API; subcommands are thin clients. Two control surfaces matter:

- **Inbound from Caddy** — tails the combined access log (read-only mount); jail.json bidirectional sync with the ddos-mitigator plugin under flock.
- **Outbound to Caddy** — writes `policy-rules.json` atomically (the plugin mtime-polls every few seconds); pokes Caddy admin via the IP-restricted proxy port using `extra_hosts: caddy:<gateway-ip>` because Docker inter-network isolation blocks docker0.

**The reload trick**: Caddy's `/load` short-circuits with `"config is unchanged"` when only `import`-ed files differ. wafctl injects a SHA-256 fingerprint comment into the Caddyfile body it POSTs to force reprovision (the on-disk Caddyfile is never modified).

CLI shape (top-level subcommands): `serve` (default), `version`, `health`, `config`, `rules`, `deploy`, `events`, `ratelimit`/`rl`, `csp`, `lists`, `blocklist`. Flags: `--addr`, `--json`, `--file/-f`.

For exact command surface + endpoint list run `wafctl --help` inside the container; spec changes per release.

## Authelia integration — four patterns

Authelia runs on its own bridge with file-based secrets in `/secrets/{jwt_secret,session_secret,storage_encryption_key,smtp_password}` (NOT env vars — they'd show up in `docker inspect`). Config + users_database SOPS-encrypted.

| Pattern | Site shape |
|---|---|
| A — no auth | `import waf` + `reverse_proxy` |
| B — full Authelia | `import waf` + `import forward_auth` + `reverse_proxy` |
| C — mixed | `route { @public path /api/* /webhooks/*; reverse_proxy @public ...; forward_auth ...; reverse_proxy ... }` — first match wins, auth applies to the fallback |
| D — research bearer | `(research_auth)` accepts `Authorization: Bearer {$RESEARCH_TOKEN}`, falls back to forward_auth |

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

- **`make restart`** — calls Composer API. Composer decrypts SOPS `.env` first. **Only safe path for changes touching `.env` or env-var passthrough.**
- **`make restart-caddy` / `restart-wafctl` / `restart-authelia`** — raw `docker compose up -d --force-recreate <svc>`. **Bypasses Composer's SOPS layer.** Containers come up with `ENC[AES256_GCM,...]` ciphertext and crash-loop. Only safe when config hasn't changed.

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
8. **Unpinned xcaddy modules float on `--no-cache` rebuilds.** New `caddy-l4` releases have raised the `caddy/v2` minimum and broken older base versions. When bumping any module, bump them all and verify with `docker run --rm <image> /usr/bin/caddy list-modules`.
9. **Version-tag drift** — see above.
10. **wafctl ↔ Caddy admin routing**: `extra_hosts: caddy:<bridge-gateway>` required (Docker inter-network isolation blocks docker0). Talk to the proxy port, not `:2019`.
11. **Pre-commit hook** blocks unencrypted `.env` / `.tfvars` / `.tfstate` (looks for `ENC[AES256_GCM,` or `sops_*` markers). Override per-path via `.allow-unencrypted-paths`.
12. **wafctl event-store retention** — bounded by `WAF_EVENT_MAX_AGE` / `WAF_GENERAL_LOG_MAX_AGE`. Size on disk scales with traffic; check AGENTS.md for current envelopes before sizing a new deploy.

## Subdirectory map

| Dir | What |
|---|---|
| `authelia/` | `configuration.yml`, `users_database.yml` (SOPS), 2FA enrollment artefacts |
| `errors/` | `error.html` — template-driven 4xx/5xx with WAF-specific 403/429 |
| `scripts/` | `entrypoint.sh`, `setup-cors.sh`, `update-geoip.sh` |
| `test/` | `Caddyfile.e2e/.test`, Go e2e tests, CRS official YAML test cases |
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

- **`knot-dns` skill** + `~/knot-fly/AGENTS.md` — upstream of rfc2136; owner of TSIG rotation procedure and force-renewal recipe.
- **`composer` skill** — composer API endpoints (`stacks/<name>/{sync,up}`, `stacks/<name>/env`), the WAF UA gotcha for PUT/POST, SOPS-decrypt-on-deploy contract.
- **`infrastructure-stack` skill** — SOPS+age, compose conventions, Unraid+cache patterns, healthchecks, read-only rootfs, cap_drop.
- **`tailscale-homelab` skill** — every `ssh servarr` invocation below assumes this works.
- **NOT Fly** — this stack doesn't deploy to Fly. Only Knot does.

## Operator recipes — `ssh servarr` snippets

```bash
# Inspect a live cert (substitute your hostname)
HOST=caddy.example.com
CERT_DIR=/mnt/cache/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$HOST
ssh servarr "openssl x509 -in $CERT_DIR/$HOST.crt -noout -dates -issuer"

# Force-renew a single site (delete + restart, NOT reload)
ssh servarr "rm $CERT_DIR/$HOST.{crt,key,json}"
ssh servarr "docker restart caddy"
ssh servarr "docker logs --since 1m caddy 2>&1 | grep -iE '$HOST|acme'"

# Watch ACME activity live
ssh servarr 'docker logs -f caddy 2>&1 | grep -E "tls.obtain|authorization|finalize|obtained|BADSIG|BADKEY"'

# Verify TSIG plaintext actually loaded
ssh servarr 'docker inspect caddy --format "{{range .Config.Env}}{{println .}}{{end}}" | grep TSIG_'

# wafctl health (replace with current bridge IP from compose.yaml)
ssh servarr 'curl -sf http://<wafctl-bridge-ip>:8080/api/v1/health | jq'
```
