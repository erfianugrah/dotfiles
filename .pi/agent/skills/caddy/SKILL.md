---
name: caddy
description: Use when working on the user's custom Caddy edge reverse-proxy stack (now NATIVE on the MS-01 NixOS router; source/build repo is ~/infra/ergo/caddy-compose/) - adding or editing a site block in the router repo's edge/Caddyfile, debugging ACME issuance (Cloudflare or rfc2136/TSIG to Knot), bumping plugin pins (pkgs/caddy-edge.nix), or re-enabling the dormant edge HTTP cache (souin). Fires on 'caddy', 'Caddyfile', 'the edge proxy', 'ACME failure', 'souin'. NOT for wafctl/edgectl API routes or dashboard internals (waf-api).
---

# caddy - custom build + edge stack (NATIVE since 2026-09-08)

**The edge Caddy + edgectl run as native NixOS systemd services on the router** (no Docker). Source of truth is the router repo `~/infra/router/`:

- **Live config**: `~/infra/router/edge/Caddyfile` (48 site blocks). Edit HERE, not the caddy-compose `deploy/edge/Caddyfile` (that is the archived container-era copy).
- **Binary**: `~/infra/router/pkgs/caddy-edge.nix` - caddy 2.11.4 + the 9 plugins (directory-replaced private sources from flake inputs; CVE `--replace` mirrors the Dockerfile).
- **Service wiring**: `~/infra/router/modules/edge.nix` (`services.caddy` + `systemd.services.edgectl`, tmpfiles-owned state, `caddy`/`wafctl` users).
- **Deploy**: router repo `make deploy` (git push -> router `/etc/nixos` resets to origin/main -> `nixos-rebuild switch` -> `eaves doctor` gate). Never `make restart`/composer for the edge - that path is gone.
- **Certs/state**: caddy resolves storage to `$HOME/.local/share/caddy` (unit sets `HOME=/var/lib/caddy`); certs live at `/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>/`. edgectl state at `/var/lib/wafctl/`.

**Source/build repo (unchanged)**: `~/infra/ergo/caddy-compose/` holds the `Dockerfile` (plugin manifest of record - the 9 plugins + CVE replaces that pkgs/caddy-edge.nix mirrors), the `wafctl/` + `waf-dashboard/` code (edgectl), and CI that builds + Trivy-scans + signs the images (vuln gate + container fallback). The compose stack is retained for the e2e/CRS test harness and as a fallback runtime - it is no longer how the edge runs.

**Project-truth**: `~/infra/router/docs/plans/2026-09-06-caddy-native-migration.md` (progress log + the cutover gotchas) and `~/infra/ergo/caddy-compose/AGENTS.md` (wafctl/dashboard dev). This skill is the pattern layer.

## Direction change (2026-08-09) - read before adding features

The CRS/WAF/challenge stack is slated for removal and wafctl is being renamed `edgectl` (ddos/jail/events now, host-config management via the Caddy admin API next). Details: `PLAN.md` section "Direction Change". Do not extend CRS rules, the challenge system or their dashboard pages; the `wafctl` API surface itself is the `waf-api` skill.

## What's in the repo - three things at once

1. **Custom Caddy build** - Dockerfile uses `caddy:${VERSION}-builder` + `xcaddy build`. Compiled-in `--with` plugins (read the Dockerfile for the current list and pins): `caddy-dns/cloudflare`, `caddy-dns/rfc2136`, `caddy-dynamicdns` (pinned by commit), `caddy-l4`, first-party `caddy-body-matcher` / `caddy-policy-engine` / `caddy-ddos-mitigator`, and the dormant edge HTTP cache pair `caddyserver/cache-handler` + `darkweak/storages/nuts`. Every module is pinned. Two non-plugin build lines: the Souin cache core is the user's fork (`--with github.com/darkweak/souin=github.com/erfianugrah/souin@<tag>`) and `--replace` lines bump transitive deps with known vulns.
2. **Native services (post-2026-09-08)** - both caddy and edgectl are systemd units on the router (router repo `modules/edge.nix`). No containers, no IdP (Authelia retired; `deploy/edge/authelia/` in caddy-compose is historical). The compose stack remains only as the e2e/CRS test harness + fallback runtime.
3. **WAF management plane** - `wafctl/` (Go HTTP API + CLI, stdlib only) + `waf-dashboard/` (Astro + React + shadcn), bundled into the wafctl image and proxied at a dedicated subdomain. CRS rules converted from upstream `coreruleset` `.conf` to JSON at build time by `tools/crs-converter/`. Marked for removal (see above).

## Caddyfile patterns - the snippet idiom

All snippets are defined inline in the same Caddyfile (`(name) { ... }` blocks expand at parse time). The adapter resolves snippets TOP-DOWN: importing a snippet defined LATER in the file crash-loops Caddy (`File to import not found`). Most snippets sit at the top, but `(lan_only)` / `(research_auth)` / `(memledger_auth)` are defined mid-file - site blocks importing them MUST go below their definition. `rg -n '^\(' ~/infra/router/edge/Caddyfile` lists every snippet with its line.

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

An internal admin proxy on a high port (IP-restricted to the wafctl bridge subnet, reverse-proxying to `localhost:2019`) still exists in the Caddyfile, but **nothing consumes it** since 2026-09-07 - wafctl no longer calls the Caddy admin API (CFProxyStore + `reloadCaddy` deleted in 53b6b9a after the stale-bind-mount `/load` clobber). The block + the wafctl `extra_hosts` alias were removed with it; the `:2020` Caddyfile block is parked for the control-plane rework.

**Vhost naming**: default is plain `<name>.erfi.io`. The `.edge.` infix is reserved for knotea alone (`knotea.edge.erfi.io`, LAN twin of the Fly-hosted `knotea.erfi.io` DoH/DoT) - the historical `composer.edge` / `waf.edge` twins were removed 2026-09-09. The wafctl/edgectl dashboard is `edge.erfi.io` (plus legacy `waf.erfi.io`); composer is `composer.erfi.io` only. New LAN-only services get the plain name (e.g. ntopng -> `ntop.erfi.io`), never `.edge.` by default.

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

**TSIG env vars** - native caddy reads secrets from `/var/lib/secrets/edge.env` (the unit's `EnvironmentFile`, 0600 root on the router, outside git). Adding/changing a TSIG var needs two edits: the value in `/var/lib/secrets/edge.env` on the router + the `{$VAR}` reference in the Caddyfile. (The container-era SOPS/.env/compose-passthrough three-edit rule is gone with the stack.)

**Secret flow**: `/var/lib/secrets/edge.env` -> systemd `EnvironmentFile` -> caddy process env -> caddy-dns/rfc2136 sends a signed UPDATE to Knot. (sops-nix adoption for this file is a parked follow-up.)

Verify post-restart that the plaintext loaded (not the ciphertext) - check for the variable NAME only, never print the value:

```bash
ssh router 'sudo -n grep -o "^[A-Z_]*" /var/lib/secrets/edge.env | grep TSIG_'
```

Rotation order (full procedure in the `knot-dns` skill): rotate on Knot first, then here, else any ACME renewal in the gap returns `BADSIG`.

## wafctl - where it sits in the stack

Zero-dep Go (stdlib only). Default invocation runs the HTTP API; subcommands are thin clients. Two control surfaces:

- **Inbound from Caddy** - tails the combined access log (read-only mount); `jail.json` bidirectional sync with the ddos-mitigator plugin under flock.
- **Outbound to Caddy** - writes `policy-rules.json` atomically (the plugin mtime-polls). wafctl no longer calls the Caddy admin API (the `/load` path was the 2026-09-07 stale-bind-mount clobber vector; removed in 53b6b9a).

~~The reload trick~~ (historical): wafctl used to inject a SHA-256 fingerprint comment into the Caddyfile body it POSTed to `/load` to defeat Caddy's bytes.Equal no-op. Deleted with `reloadCaddy` - config delivery is now file-based only (plugin mtime hot-reload).

Routes, env vars, stores, CLI and dashboard internals: the `waf-api` skill.

## Auth patterns

No forward-auth IdP remains in the stack. Current shapes:

| Pattern | Site shape |
|---|---|
| A - no auth | `import waf` + `reverse_proxy` |
| B - bearer-or-LAN | `import research_auth` + `reverse_proxy` - private API surfaces: LAN + tailnet pass open, WAN needs `Authorization: Bearer $RESEARCH_TOKEN` |
| C - mixed public/API | `route { @public path /api/* /webhooks/*; reverse_proxy @public ...; ... }` - first match wins |

`RESEARCH_TOKEN` must reach the native caddy process env - read from `/var/lib/secrets/edge.env` (the caddy unit's `EnvironmentFile`), not a compose file. Else the matcher compares against an empty string and nothing authenticates.

## Build / deploy - native (post-2026-09-08)

The edge runs native. The container make-targets (`edge-sync`, `restart-edge`, `restart-caddy`, the SOPS footgun) are gone with the stack - do not use them for the live edge.

- **Change the Caddyfile**: edit `~/infra/router/edge/Caddyfile`, then `cd ~/infra/router && make deploy` (push -> router resets /etc/nixos to origin/main -> `nixos-rebuild switch` -> `eaves doctor` gate). The `services.caddy` module validates the config and reloads caddy on change.
- **Bump a plugin / the caddy base / a CVE replace**: edit `~/infra/router/pkgs/caddy-edge.nix` AND mirror the version in `~/infra/ergo/caddy-compose/Dockerfile` (the manifest of record CI scans), then `make deploy`. The router rebuilds the binary from source.
- **edgectl code change**: edit `~/infra/ergo/caddy-compose/wafctl/`, bump the `caddyCompose` flake-input pin + `pkgs/wafctl.nix` version in the router repo, `make deploy`.
- **Validate the Caddyfile without deploying**: `ssh router 'sudo -n <caddy-edge-store-path>/bin/caddy validate --config /etc/nixos/edge/Caddyfile --adapter caddyfile'` (real ACME auth needs the secrets in `/var/lib/secrets/edge.env`; dummy vars only catch directive/syntax errors).
- **Stuck cert state** (deleted on disk but caddy still serves cached): `ssh router 'sudo -n systemctl restart caddy'` - empties the in-memory cert cache. `caddy reload` will NOT (it short-circuits on "config is unchanged").

The caddy-compose `make build/push/scan/sign` targets now build ONLY the CI/fallback image (Trivy vuln gate + container fallback runtime) - they do not deploy the live edge.

**Version-tag sync** - caddy-compose Makefile / compose.yaml / `.github/workflows/build.yml` / README (the CI image pin) AND router `pkgs/wafctl.nix` version + the `caddyCompose` flake pin must agree. `CADDY_TAG` (published image) is distinct from `CADDY_VERSION` (upstream base they trail).

## Dormant edge cache (souin / cache-handler)

The edge HTTP cache is REMOVED from the live `~/infra/router/edge/Caddyfile` (header comment there says so); the souin fork + nuts modules are still compiled into the binary. Re-enable ONLY via `docs/edge-cache-removal.md` (exact blocks that were removed, why, and the `cachectl verify` bug that prompted it) plus `test/cache/README.md` (the verified Souin quirk catalogue with source references - read it before asserting any souin behaviour). What still exists:

- `tools/cachectl` - Go ops CLI: `cd tools/cachectl && go run . status|verify|probe <url>|purge <site|all>`. `purge` (rm the site's nuts dir + `systemctl restart caddy`) is the only working purge; the souin admin API permanently returns `[]` and admin PURGE is a no-op. `make build-cachectl` builds it; `make edge-verify-cache` runs `verify` - only meaningful while the cache is enabled, and `make edge-restart` does NOT run it.
- `test/cache/` harness (`make test-cache`, extracts the binary from `CADDY_IMAGE`). Mirror any storage/handler-shape change into `test/cache/Caddyfile.test` or a green run proves nothing.
- Version pins live in the Dockerfile (`cache-handler`, `storages/nuts/caddy`, the souin fork replace). Fork repo: `~/infra/ergo/souin`.

Config rules if it comes back (each violation is a silent failure, evidence in the README): per-site `nuts { configuration { Dir /data/cache/nuts/<site>; EntryIdxMode HintKeyAndRAMIdxMode } }` - never a global nuts block (registration race -> in-memory fallback), `Dir` inside `configuration` (else the path is dropped -> tmpfs `/tmp/souin-nuts`, wiped per restart); `order cache after policy_engine` so WAF blocks never enter the cache; `stale-if-error` in `default_cache_control` for origin-down insurance; `key { disable_query }` on whole-site public caches; never cache media streams or Range-heavy downloads. Diagnostics: `Cache-Status: Souin; hit; ... detail=NUTS` is the disk storer, `detail=DEFAULT` is the in-memory fallback (dies on restart).

## Gotchas - the durable list

1. **The composer instance's WAF blocks default `curl` UA on PUT/POST** (not GET). Send a browser-style `User-Agent` plus `Origin` and `Referer` matching the page. 403 with a reference-ID = this rule.
2. **`caddy reload` is sticky** - `"config is unchanged"` short-circuits and does NOT re-evaluate cert state, even if cert files were deleted. Force re-issue: `ssh router 'sudo -n systemctl restart caddy'`.
3. **TSIG rotation order**: Knot first, then here. ACME renewals in the gap return `BADSIG`.
4. **Zone migration**: when a zone moves CF DNS -> Knot, every site block under it MUST swap `import tls_config_cf` -> `import tls_config_rfc2136`. Otherwise Caddy writes ACME TXT to CF while validators ask Knot -> silent failure once recursive caches expire.
5. **Pin every xcaddy module.** Unpinned modules float on `--no-cache` rebuilds; new `caddy-l4` releases have raised the `caddy/v2` minimum and broken older bases. When bumping any module OR the Caddy base, bump them all to latest known-good and verify with `docker run --rm <image> /usr/bin/caddy list-modules`. For a non-plugin transitive dep bump, use xcaddy `--replace module=module@version` (go.mod replace, no blank import), not `--with`.
6. **Edge HTTP cache is dormant** - see the section above; do not "fix" cache behaviour in a Caddyfile that has no `cache` handler.
7. **Version-tag drift** - see above.
8. **Snippet import order** - top-down resolution, forward reference = crash loop. `(lan_only)` / `(research_auth)` / `(memledger_auth)` are mid-file, not at the top.
9. **Pre-commit hook** blocks unencrypted `.env` / `.tfvars` / `.tfstate` (looks for `ENC[AES256_GCM,` or `sops_*` markers). Override per-path via `.allow-unencrypted-paths`.
10. **wafctl event-store retention** - bounded by `WAF_EVENT_MAX_AGE` / `WAF_GENERAL_LOG_MAX_AGE`. Size on disk scales with traffic; check AGENTS.md for current envelopes before sizing a new deploy.

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
CERT_DIR=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$HOST
ssh router "openssl x509 -in $CERT_DIR/$HOST.crt -noout -dates -issuer"

# Force-renew a single site (delete + restart, NOT reload)
ssh router "sudo -n rm $CERT_DIR/$HOST.{crt,key,json}"
ssh router 'sudo -n systemctl restart caddy'
ssh router "sudo -n journalctl -u caddy --since 1m | grep -iE '$HOST|acme'"

# Watch ACME activity live
ssh router 'sudo -n journalctl -u caddy -f | grep -E "tls.obtain|authorization|finalize|obtained|BADSIG|BADKEY"'

# Verify the TSIG variable is present (names only)
ssh router 'sudo -n systemctl show caddy -p EnvironmentFiles; sudo -n grep -o "^[A-Z_]*" /var/lib/secrets/edge.env | grep TSIG_'

# edgectl (wafctl) health - native, on :8082 (8080 belongs to the composer container)
ssh router 'curl -sf http://127.0.0.1:8082/api/health | head -c 200'

# TSIG drift check (native caddy's first NEW cert after cutover failed
# "dns: bad authentication" 2026-09-09: edge.env held a stale
# TSIG_CADDY_ACME; cert store preservation meant no issuance had exercised
# rfc2136 until then). Compare against the container-era sops source:
# secretctl cmp 'sops:~/infra/ergo/caddy-compose/deploy/edge/.env#TSIG_CADDY_ACME' \
#   'keyfile:~/.config/knotctl/keys/caddy-acme.key'   # keyfile leg digests the whole file; expect MISMATCH-by-framing
# ground truth = a live probe: knotctl --key acme add _acme-challenge.<host> TXT '"probe"'
```
