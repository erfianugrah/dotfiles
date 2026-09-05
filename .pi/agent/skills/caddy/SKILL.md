---
name: caddy
description: Use when working on the user's custom Caddy edge reverse-proxy stack at ~/infra/ergo/caddy-compose/ - adding or editing a site block, debugging ACME issuance (Cloudflare or rfc2136/TSIG to Knot), bumping xcaddy plugin pins, deploying or restarting the edge-services stack, or re-enabling the dormant edge HTTP cache (souin). Fires on 'caddy', 'Caddyfile', 'the edge proxy', 'ACME failure', 'make restart', 'edge-services', 'souin'. NOT for wafctl API routes or dashboard internals (waf-api).
---

# caddy - custom build + edge stack

Repo: `~/infra/ergo/caddy-compose/`. Deployed to the MS-01 NixOS router (ssh alias `router`) as the composer stack `edge-services`. The deployed file is `deploy/edge/Caddyfile`; the repo-root `Caddyfile` is a legacy config - never edit it for prod changes. Checkout on the router at `/var/lib/composer/stacks/edge-services`, data at `/var/lib/caddy/{data,config,log,waf}` (certs under `data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>/`). Caddy runs `network_mode: host`; wafctl on its own bridge.

Deploy loop: push, then `make edge-sync` (composer API sync of the stack checkout) or `make restart` (sync + up via composer, SOPS-decrypting `.env`), then `make edge-restart` for Caddyfile changes. Never assume a push alone deployed anything - sync explicitly. `docker restart caddy` (which `edge-restart` does) rather than `caddy reload` for Caddyfile changes: the single-file bind mount goes stale-inode on git sync, so `reload` would adapt the OLD inode.

**Project-truth: `~/infra/ergo/caddy-compose/AGENTS.md`** - read first for current versions, counts and the full gotcha list. This skill is the pattern layer.

## Direction change (2026-08-09) - read before adding features

The CRS/WAF/challenge stack is slated for removal and wafctl is being renamed `edgectl` (ddos/jail/events now, host-config management via the Caddy admin API next). Details: `PLAN.md` section "Direction Change". Do not extend CRS rules, the challenge system or their dashboard pages; the `wafctl` API surface itself is the `waf-api` skill.

## What's in the repo - three things at once

1. **Custom Caddy build** - Dockerfile uses `caddy:${VERSION}-builder` + `xcaddy build`. Compiled-in `--with` plugins (read the Dockerfile for the current list and pins): `caddy-dns/cloudflare`, `caddy-dns/rfc2136`, `caddy-dynamicdns` (pinned by commit), `caddy-l4`, first-party `caddy-body-matcher` / `caddy-policy-engine` / `caddy-ddos-mitigator`, and the dormant edge HTTP cache pair `caddyserver/cache-handler` + `darkweak/storages/nuts`. Every module is pinned. Two non-plugin build lines: the Souin cache core is the user's fork (`--with github.com/darkweak/souin=github.com/erfianugrah/souin@<tag>`) and `--replace` lines bump transitive deps with known vulns.
2. **Compose stack** - `caddy` (host network), `wafctl` on its own bridge. No IdP in the stack (Authelia is retired; `deploy/edge/authelia/` is historical). Each container `read_only` where possible, `cap_drop ALL`, run-as `1000:1000`.
3. **WAF management plane** - `wafctl/` (Go HTTP API + CLI, stdlib only) + `waf-dashboard/` (Astro + React + shadcn), bundled into the wafctl image and proxied at a dedicated subdomain. CRS rules converted from upstream `coreruleset` `.conf` to JSON at build time by `tools/crs-converter/`. Marked for removal (see above).

## Caddyfile patterns - the snippet idiom

All snippets are defined inline in the same Caddyfile (`(name) { ... }` blocks expand at parse time). The adapter resolves snippets TOP-DOWN: importing a snippet defined LATER in the file crash-loops Caddy (`File to import not found`). Most snippets sit at the top, but `(lan_only)` / `(research_auth)` / `(memledger_auth)` are defined mid-file - site blocks importing them MUST go below their definition. `rg -n '^\(' deploy/edge/Caddyfile` lists every snippet with its line.

| Snippet | Purpose |
|---|---|
| `(ddos)` | inline `ddos_mitigator { jail_file ... threshold ... whitelist ... }` |
| `(waf)` | imports `ddos`, sets `X-Request-Id`, runs `policy_engine { rules_file ... reload_interval 5s }`, registers `handle_errors` |
| `(waf_off)` | empty placeholder - metrics/respond-only sites |
| `(tls_config_cf)` | ACME via `dns cloudflare {$CF_API_TOKEN}` - for zones still on Cloudflare DNS |
| `(tls_config_rfc2136)` | ACME via TSIG nsupdate to the user's Knot - for zones served by Knot |
| `(lan_only)` | deny unless remote_ip is private/tailnet |
| `(research_auth)` | bearer-or-LAN gate: deny = NOT remote_ip in (10/8, 100.64/10, 172.16/12, 192.168/16) AND NOT `Authorization: Bearer {$RESEARCH_TOKEN}` |
| `(memledger_auth)` | same shape for the memledger API surface |
| `(proxy_headers)` | `trusted_proxies private_ranges` + `X-Forwarded-For {client_ip}` - used inside reverse_proxy |
| `(error_pages)` | `handle_errors` -> template at `/etc/caddy/errors/error.html` |
| `(site_log)` | combined JSON log to `/var/log/combined-access.log`; `log_append` lines pull `policy_*`, `ddos_*`, `challenge_*` fields lazily. Single source of truth tailed by wafctl. |

Global block uses explicit handler ordering: `order log_append first` -> `order ddos_mitigator after log_append` -> `order policy_engine after ddos_mitigator` so `log_append` captures action fields even when later handlers short-circuit.

**Canonical per-site shape**:
```caddyfile
example.com {
    import waf
    import research_auth         # only for bearer-gated API surfaces
    import tls_config_rfc2136    # or tls_config_cf for CF-DNS zones
    encode zstd gzip
    reverse_proxy <bridge-ip>:<port> {
        import proxy_headers
    }
    import error_pages
    import site_log example
}
```

Internal admin proxy on a high port IP-restricts to the wafctl bridge subnet and reverse-proxies to `localhost:2019`. **wafctl talks to that proxy port, never `:2019` directly.**

**Vhost naming**: default is plain `<name>.erfi.io`. The `.edge.` infix exists only where the plain name already serves something else - `knotea.edge.erfi.io` (LAN twin of the Fly-hosted `knotea.erfi.io` DoH/DoT) plus the historical `composer.edge` / `waf.edge` (LAN twins of their public same-name vhosts). New LAN-only services get the plain name (e.g. ntopng -> `ntop.erfi.io`), never `.edge.` by default.

## TSIG + rfc2136 - secret chain to Knot

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

**Three-edit rule** - adding/changing a TSIG-using env var needs three simultaneous edits or Caddy crash-loops:

1. `.env` - `TSIG_CADDY_ACME=<base64>` (SOPS-encrypted; age recipients per the `secret-handling` skill)
2. `compose.yaml` - `- TSIG_CADDY_ACME=${TSIG_CADDY_ACME}` passthrough on the `caddy` service
3. `Caddyfile` - `key {$TSIG_CADDY_ACME}` reference inside the rfc2136 block

**Secret flow**: SOPS in git -> composer decrypts at deploy time -> plaintext into container env -> Caddy reads at startup -> caddy-dns/rfc2136 sends a signed UPDATE to Knot.

Verify post-restart that the plaintext loaded (not the ciphertext) - check for the variable NAME only, never print the value:

```bash
ssh router 'docker inspect caddy --format "{{range .Config.Env}}{{println .}}{{end}}" | cut -d= -f1 | grep TSIG_'
```

Rotation order (full procedure in the `knot-dns` skill): rotate on Knot first, then here, else any ACME renewal in the gap returns `BADSIG`.

## wafctl - where it sits in the stack

Zero-dep Go (stdlib only). Default invocation runs the HTTP API; subcommands are thin clients. Two control surfaces:

- **Inbound from Caddy** - tails the combined access log (read-only mount); `jail.json` bidirectional sync with the ddos-mitigator plugin under flock.
- **Outbound to Caddy** - writes `policy-rules.json` atomically (the plugin mtime-polls); pokes Caddy admin via the IP-restricted proxy port using `extra_hosts: caddy:<gateway-ip>` because Docker inter-network isolation blocks docker0.

**The reload trick**: Caddy's `/load` short-circuits with `"config is unchanged"` when only `import`-ed files differ. wafctl injects a SHA-256 fingerprint comment into the Caddyfile body it POSTs to force reprovision (the on-disk Caddyfile is never modified).

Routes, env vars, stores, CLI and dashboard internals: the `waf-api` skill.

## Auth patterns

No forward-auth IdP remains in the stack. Current shapes:

| Pattern | Site shape |
|---|---|
| A - no auth | `import waf` + `reverse_proxy` |
| B - bearer-or-LAN | `import research_auth` + `reverse_proxy` - private API surfaces: LAN + tailnet pass open, WAN needs `Authorization: Bearer $RESEARCH_TOKEN` |
| C - mixed public/API | `route { @public path /api/* /webhooks/*; reverse_proxy @public ...; ... }` - first match wins |

`RESEARCH_TOKEN` must be in the caddy container's `environment:` in `deploy/edge/compose.yaml`, not just `.env` - else the matcher compares against an empty string and nothing authenticates.

## Build / release - make targets

| Target | What |
|---|---|
| `make build` / `build-caddy` / `build-wafctl` | local docker build; `NO_CACHE=1` to force plugin re-pull |
| `make push` / `push-caddy` / `push-wafctl` | to the user's Docker Hub namespace |
| `make scan` | Trivy CRITICAL+HIGH gate |
| `make sign` / `sbom` | cosign keyless + syft attestations |
| `make deploy` / `deploy-*` / `deploy-all` | build -> scan -> push -> sync -> restart |
| `make edge-sync` | composer API sync of the edge-services checkout on the router |
| `make edge-restart` | edge-sync + `docker restart caddy` + live `caddy validate`; runs NO cache verify |
| `make caddy-reload` | sync git + redeploy WAF/CSP/headers via wafctl + reload (no container restart) |
| `make caddy-quick-reload` | sync git + reload only |

### `make restart` vs `make restart-caddy` - the single biggest footgun

- **`make restart`** - `prep-composer-tree` then composer API `sync` + `up`. Composer decrypts the SOPS `.env` first. **Only safe path for changes touching `.env` or env-var passthrough.**
- **`make restart-caddy` / `restart-wafctl`** - plain `compose up --force-recreate` on the router, bypassing SOPS: ciphertext env, crash loop.

`prep-composer-tree` runs `docker exec -u composer composer git ... reset --hard HEAD` to wipe the dirty tree left by SOPS re-encrypt. The `-u composer` flag is mandatory - root-owned files break the next decrypt.

For a **stuck cert state** (deleted on disk but Caddy still serves cached), use `docker restart caddy` (preserves resolved env, empties in-memory cert cache) - NOT `make restart-caddy`.

## Docker image build flow - four stages

1. `xcaddy build` with the `--with` modules.
2. `golang:*-alpine` builds `crs-converter`, clones CRS at the pinned version, emits `default-rules.json` + `crs-metadata.json` (folding in `waf/custom-rules.json`).
3. `alpine` fetches Cloudflare IP ranges, builds `cf_trusted_proxies.caddy` with `trusted_proxies static <cidrs>`.
4. Runtime `caddy:*-alpine` copies built binary + assets + entrypoint. Adds `nftables`. Entrypoint seeds the CF-IP file if missing then `exec caddy run`.

**Version-tag sync** - Makefile / compose.yaml / `.github/workflows/build.yml` / README must agree. `CADDY_TAG` (published image) is distinct from `CADDY_VERSION` (upstream base they trail).

## Dormant edge cache (souin / cache-handler)

The edge HTTP cache is REMOVED from the live `deploy/edge/Caddyfile` (header comment there says so); the souin fork + nuts modules are still compiled into the image. Re-enable ONLY via `docs/edge-cache-removal.md` (exact blocks that were removed, why, and the `cachectl verify` bug that prompted it) plus `test/cache/README.md` (the verified Souin quirk catalogue with source references - read it before asserting any souin behaviour). What still exists:

- `tools/cachectl` - Go ops CLI: `cd tools/cachectl && go run . status|verify|probe <url>|purge <site|all>`. `purge` (rm the site's nuts dir + `docker restart caddy`) is the only working purge; the souin admin API permanently returns `[]` and admin PURGE is a no-op. `make build-cachectl` builds it; `make edge-verify-cache` runs `verify` - only meaningful while the cache is enabled, and `make edge-restart` does NOT run it.
- `test/cache/` harness (`make test-cache`, extracts the binary from `CADDY_IMAGE`). Mirror any storage/handler-shape change into `test/cache/Caddyfile.test` or a green run proves nothing.
- Version pins live in the Dockerfile (`cache-handler`, `storages/nuts/caddy`, the souin fork replace). Fork repo: `~/infra/ergo/souin`.

Config rules if it comes back (each violation is a silent failure, evidence in the README): per-site `nuts { configuration { Dir /data/cache/nuts/<site>; EntryIdxMode HintKeyAndRAMIdxMode } }` - never a global nuts block (registration race -> in-memory fallback), `Dir` inside `configuration` (else the path is dropped -> tmpfs `/tmp/souin-nuts`, wiped per restart); `order cache after policy_engine` so WAF blocks never enter the cache; `stale-if-error` in `default_cache_control` for origin-down insurance; `key { disable_query }` on whole-site public caches; never cache media streams or Range-heavy downloads. Diagnostics: `Cache-Status: Souin; hit; ... detail=NUTS` is the disk storer, `detail=DEFAULT` is the in-memory fallback (dies on restart).

## Gotchas - the durable list

1. **`make restart-*` bypasses SOPS** -> ciphertext env -> crash loop. Use `make restart`.
2. **Three-edit rule** for new env vars - `.env` + `compose.yaml` passthrough + consumer config. Partial deploys crash.
3. **Composer SOPS re-encrypt leaves a dirty tree** -> next sync refuses -> next deploy uses stale code. `prep-composer-tree` resets it; must run as `-u composer`.
4. **The composer instance's WAF blocks default `curl` UA on PUT/POST** (not GET). Send a browser-style `User-Agent` plus `Origin` and `Referer` matching the page. 403 with a reference-ID = this rule.
5. **`caddy reload` is sticky** - `"config is unchanged"` short-circuits and does NOT re-evaluate cert state, even if cert files were deleted. Force re-issue: `docker restart caddy`.
6. **TSIG rotation order**: Knot first, then here. ACME renewals in the gap return `BADSIG`.
7. **Zone migration**: when a zone moves CF DNS -> Knot, every site block under it MUST swap `import tls_config_cf` -> `import tls_config_rfc2136`. Otherwise Caddy writes ACME TXT to CF while validators ask Knot -> silent failure once recursive caches expire.
8. **Pin every xcaddy module.** Unpinned modules float on `--no-cache` rebuilds; new `caddy-l4` releases have raised the `caddy/v2` minimum and broken older bases. When bumping any module OR the Caddy base, bump them all to latest known-good and verify with `docker run --rm <image> /usr/bin/caddy list-modules`. For a non-plugin transitive dep bump, use xcaddy `--replace module=module@version` (go.mod replace, no blank import), not `--with`.
9. **Edge HTTP cache is dormant** - see the section above; do not "fix" cache behaviour in a Caddyfile that has no `cache` handler.
10. **Version-tag drift** - see above.
11. **wafctl <-> Caddy admin routing**: `extra_hosts: caddy:<bridge-gateway>` required (Docker inter-network isolation blocks docker0). Talk to the proxy port, not `:2019`.
12. **Snippet import order** - top-down resolution, forward reference = crash loop. `(lan_only)` / `(research_auth)` / `(memledger_auth)` are mid-file, not at the top.
13. **Pre-commit hook** blocks unencrypted `.env` / `.tfvars` / `.tfstate` (looks for `ENC[AES256_GCM,` or `sops_*` markers). Override per-path via `.allow-unencrypted-paths`.
14. **wafctl event-store retention** - bounded by `WAF_EVENT_MAX_AGE` / `WAF_GENERAL_LOG_MAX_AGE`. Size on disk scales with traffic; check AGENTS.md for current envelopes before sizing a new deploy.

## Subdirectory map

| Dir | What |
|---|---|
| `deploy/edge/` | the LIVE deploy: `Caddyfile` + `compose.yaml` (+ retired `authelia/` - historical) |
| `docs/` | `edge-cache-removal.md` + dated incident write-ups |
| `errors/` | `error.html` - template-driven 4xx/5xx with WAF-specific 403/429 |
| `scripts/` / `tools/` | `entrypoint.sh`, `setup-cors.sh`, `update-geoip.sh`; `tools/cachectl`, `tools/crs-converter`, vendored `tools/coreruleset` |
| `test/` | `Caddyfile.e2e/.test`, Go e2e tests (`test/e2e`), CRS official YAML test cases |
| `test/cache/` | dormant edge-cache harness (`run-tests.sh`, `origin.py`, `Caddyfile.test`) + `README.md` |
| `waf/` | Committed crs-converter outputs (`custom-rules.json`, `default-rules.json`, `crs-metadata.json`) |
| `waf-dashboard/` | Astro + React + shadcn frontend. Embedded into wafctl image. |
| `wafctl/` | Go HTTP API + CLI (stdlib only). Owns `main.go` env wiring + `cli*.go` subcommands |

## Roadmap - describe as roadmap, not capability

- **`PLAN.md`** - "Direction Change" first; then the storage-migration and edgectl items.
- **`CHALLENGE_HARDENING_PLAN.md`** / **`L4_INTEGRATION_PLAN.md`** - historical plans for surfaces now slated for removal; do not build against them.

Check status checkboxes in each PLAN before claiming anything beyond "in design".

## Cross-references

- **`waf-api` skill** - wafctl routes, stores, env vars, dashboard internals.
- **`knot-dns` skill** + `~/infra/knotea/authority/AGENTS.md` - upstream of rfc2136; owner of TSIG rotation procedure and force-renewal recipe.
- **`composer` skill** - composer API endpoints (`stacks/<name>/{sync,up}`, `stacks/<name>/env`), the WAF UA gotcha for PUT/POST, SOPS-decrypt-on-deploy contract.
- **`secret-handling` skill** - SOPS/age recipients and rotation; never restate here.
- **`infrastructure-stack` skill** - compose conventions, healthchecks, read-only rootfs, cap_drop.
- **`tailscale-homelab` skill** - every `ssh router` invocation below assumes this works.
- **NOT Fly** - this stack doesn't deploy to Fly. Only Knot does.

## Operator recipes - `ssh router` snippets

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

# Verify the TSIG variable is present (names only)
ssh router 'docker inspect caddy --format "{{range .Config.Env}}{{println .}}{{end}}" | cut -d= -f1 | grep TSIG_'

# wafctl health (replace with current bridge IP from compose.yaml)
ssh router 'curl -sf http://<wafctl-bridge-ip>:8080/api/v1/health | jq'
```
