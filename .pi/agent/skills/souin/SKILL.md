---
name: souin
description: Operate and configure the edge HTTP cache (caddyserver/cache-handler, Souin core via the erfianugrah fork, nuts/nutsdb on-disk storage) in ~/infra/ergo/caddy-compose. Use when adding cache to a site on the edge Caddyfile, debugging cache misses / non-persistence / Cache-Status anomalies, changing nuts storage options (EntryIdxMode, SegmentSize, MergeInterval), purging or reclaiming cache storage, or extending the test/cache harness. Fires on "souin", "cache-handler", "nuts", "edge cache", "Cache-Status", "stale-if-error", "cache purge". Covers the three storage bugs verified 2026-07-31 (provider-inheritance race, nuts.Factory Dir-drop, harness blind spot), the REQUIRED per-site nuts config pattern, the cachectl ops tool, and the 7 documented behavioral quirks. Sibling to `caddy` (the wider Caddy/WAF stack) and `composer` (deploy path).
---

# souin - edge HTTP cache operations

**Project truth: `~/infra/ergo/caddy-compose/test/cache/README.md`** - the verified
quirk catalogue (7 behavioral quirks + the 2026-07-31 storage incident),
each with source references into the pinned module versions. Read it before
asserting ANY souin behavior. The harness is `make test-cache` (71 tests).
This skill is the operational layer: config pattern, ops tool, deploy path.

Stack: `caddyserver/cache-handler@v0.16.0` + forked Souin core
(`github.com/erfianugrah/souin@v1.7.7-erfi.1`, replace in Dockerfile - two
patches: born-stale Store() fix, revalidation double-store fix) +
`darkweak/storages/nuts/caddy@v0.0.19` (nutsdb v1.0.4 on-disk). Edge variant
only (`deploy/edge/Caddyfile` on the MS-01, composer stack `edge-services`).

## The REQUIRED config pattern (violating any of these = silent failure)

1. **Per-site `nuts {}` with a UNIQUE `Dir` in every cache-enabled site
   block. NEVER a global `nuts` block.** A handler with no provider of its
   own inherits the app-level provider (cache-handler `httpcache.go`
   `FromApp` ~line 220); with a global nuts block every handler then opens
   its OWN nutsdb on the SAME path during concurrent provisioning -
   registration-race losers silently fall back to in-memory storage
   (nondeterministic, 3-4 of 5 observed live), winners are independent
   writers on one dir (record-clobber hazard).
2. **`Dir` must sit INSIDE `configuration {}`.** `nuts.Factory` ignores
   `provider.Path` entirely when `Configuration` is non-nil
   (`storages/nuts` `nuts.go` ~line 133, the `Dir = Path` is in the
   `else` branch) and silently falls back to `/tmp/souin-nuts` - a tmpfs
   in the edge container, so the cache wipes on every restart. Adding
   `configuration { EntryIdxMode ... }` without `Dir` is what caused the
   2026-07-31 incident. Do not bother with a `path` line at all.
3. **`EntryIdxMode HintKeyAndRAMIdxMode`** (keys-only RAM index) - the
   default keeps the full value index in RAM, so container RAM scales
   with cached bytes. No size bound or LRU exists anywhere; bounds are
   ttl+stale and `key { disable_query }` cardinality control.

```caddyfile
cache {
    ttl 24h
    stale 72h
    default_cache_control "public, max-age=86400, stale-if-error=259200"
    nuts {
        configuration {
            Dir /data/cache/nuts/<site-name>
            EntryIdxMode HintKeyAndRAMIdxMode
        }
    }
}
```

Site-scoping patterns that exist today: whole-site public static
(docs.erfi.io - always with `key { disable_query }` against query-spam
cache-blowing), route-scoped immutable media metadata behind per-client
query auth (jellyfin `/Items/*/Images/*`, navidrome `/rest/getCoverArt*` -
auth params in the query give per-client keys, no cross-user leak).
Media streams are never cache targets: per-session transcode artifacts,
Range-header semantics souin handles badly, unbounded storage growth.

`stale-if-error` in `default_cache_control` is REQUIRED for origin-down
insurance (RFC 5861): on the error path Souin only serves stale when the
cached response carries it; on the non-error path only when the request
sends `max-stale` (browsers never do).

## Ops tool - tools/cachectl (Go CLI in caddy-compose, stdlib only)

```bash
cd ~/infra/ergo/caddy-compose/tools/cachectl
go run . status           # per-site DB sizes, fallback count, tmpfs check, RAM
go run . verify           # hard asserts: 0 fallbacks, DBs at configured Dirs, no /tmp/souin-nuts
go run . probe <url>      # request twice via edge IP, print Cache-Status both times
go run . purge <site|all> # rm /data/cache/nuts/<site> + docker restart caddy
# or: make build-cachectl -> tools/cachectl/cachectl <cmd>; make edge-verify runs verify
# probe sends browser-ish headers + HTTP/2 on purpose: h1 requests with
# default Go headers trip the edge WAF detect rules, and block pages are
# never cached (response has no Cache-Status -> looks like a cache bug).
```

- `purge` is the ONLY working purge: the souin admin API permanently
  returns `[]` and admin PURGE is a no-op (admin server provisions before
  the cache app and snapshots an empty Storers list); direct `PURGE <url>`
  is a passthrough that evicts only if the ORIGIN answers PURGE with 2xx.
- Env overrides: `SSH_HOST` (default nixos), `CONTAINER`, `EDGE_IP`.

## Reading Cache-Status (the live diagnostic surface)

- `Souin; hit; ttl=N; key=...; detail=NUTS` - disk storer serving (good).
- `detail=DEFAULT` - in-memory fallback serving; entry dies on restart.
  Cross-check: `docker logs caddy --since <start> | grep -c "default storage"`
  must be 0 (cachectl verify does this).
- `fwd=uri-miss; stored` - cold fetch, stored.
- `fwd=request; detail=REQUEST-REVALIDATION` - revalidated per response
  `must-revalidate` (correct for max-age=0 HTML).
- POST/HEAD never cache; 404s are heuristically cacheable by default.

## Deploy + verify loop

1. Edit `deploy/edge/Caddyfile` -> validate:
   `docker run --rm -e EMAIL=x@y.z -e CF_API_TOKEN=<40chars> -e TSIG_CADDY_ACME=d -e TSIG_CADDY_DDNS=d -v $PWD/deploy/edge/Caddyfile:/etc/caddy/Caddyfile:ro --entrypoint /usr/bin/caddy erfianugrah/caddy:<tag> validate --config /etc/caddy/Caddyfile --adapter caddyfile`
   (`validate` provisions, so it catches storage-config errors `adapt` misses).
2. Mirror the change in `test/cache/Caddyfile.test` if it affects storage
   or handler shape; run `make test-cache` (must stay 0 failures; suite 7
   asserts the storage layout).
3. Commit + push; `make edge-restart` (composer edge-services sync +
   `docker restart caddy` + the verify gate; Caddyfile is bind-mounted,
   read at process start; restart preserves resolved env - safe).
4. The restart target already runs `make edge-verify` (cachectl verify)
   as the post-deploy gate. Then `probe` a URL per touched site.
   For a restart-persistence check: probe, restart, probe again - must
   still be `hit; detail=NUTS`.

## Hard don'ts

- No global `nuts {}` block (race + shared-dir multi-writer).
- No `configuration {}` without `Dir` inside (silent /tmp relocation).
- No redis storage backend (eviction SCAN storms, souin#646/#671).
- Don't trust the souin admin API for keys/purge (permanently empty).
- Don't cache media streams, Range-heavy downloads, or auth'd API SPA
  responses. Request `Authorization` responses are never stored (strict
  mode), but cookie-auth'd shared content needs a per-client key in the
  URL or explicit acceptance of cross-client sharing.
- Don't treat a green harness run as sufficient if you changed storage
  layout without mirroring it into `Caddyfile.test` - the 2026-07-31
  false-pass was exactly that.

## Cross-references

- `caddy` skill - the full Caddy/WAF stack, deploy gotchas, module pins.
- `composer` skill - the edge-services deploy API.
- `test/cache/README.md` - quirk catalogue with source line references.
- Fork repo: `~/infra/ergo/souin` (the two patches live in
  `pkg/middleware/middleware.go`).
