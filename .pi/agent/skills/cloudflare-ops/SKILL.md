---
name: cloudflare-ops
description: "Use when working against the Cloudflare API (REST) or wrangler CLI - zones, DNS records, cache purge, rulesets/WAF, Workers or Pages deploys and secrets, R2/D1/KV/Queues/Durable Objects/Hyperdrive bindings, Email Routing, debugging cf-* headers, bulk operations across zones, or cf-terraforming adoption. Fires on 'cloudflare', 'wrangler', 'worker', 'R2', 'durable object', 'cache purge', 'WAF rule', 'error 1016'. NOT for Zero Trust policy design (cloudflare-one) or Terraform structure (terraform)."
---

# Cloudflare operations

Named `cloudflare-ops` because Claude Code ships Cloudflare's own skill bundle
whose top-level skill is called `cloudflare`; this local skill is pi-only
unless symlinked into `~/dotfiles/.claude/skills/`. Reference files:
`bindings.md` (wrangler.jsonc + KV/R2/D1/DO/Queues/Hyperdrive/Email - read
when wiring a Worker to anything), `automation.md` (Python SDK,
cf-terraforming, BIND import - read for bulk or IaC-adoption work).

## Core principles

1. **API token, not API key.** Global API keys are deprecated for new work. Always mint a scoped token with the minimum permissions (account-level vs zone-level vs user-level resources).
2. **Two scopes, two endpoints.** Zone-level resources (`/zones/{id}/...`) and account-level resources (`/accounts/{id}/...`) take different token permissions. Read the resource path before scoping the token.
3. **Rate limits are real.** Default 1,200 req / 5 min per token. `wrangler`, the Python SDK, and the Terraform provider all retry with backoff - your custom scripts must too.
4. **Cache headers matter.** When debugging unexpected responses, read `cf-cache-status`, `cf-ray` and `cf-mitigated` (table below). Cloudflare's cache is aggressive; bypass with `Cache-Control: no-cache` from the origin or purge via API.
5. **Match the resource taxonomy in code.** A "page rule" is legacy. The current model is rulesets -> rules -> expressions. Don't write code against deprecated endpoints unless you're maintaining old TF state.
6. **Prefer retrieval over baked-in knowledge for limits, pricing and signatures.** Cloudflare ships changes weekly. Before quoting a numeric limit, pricing tier, type signature, or new binding shape, check the docs mirror: topic `cloudflare` (developer docs) or `cloudflare-api` (OpenAPI spec) - pi `docs_search source="cloudflare"`, Claude Code erfi-toolkit `docs` tool (`action=search|read`, `source=cloudflare`). When this skill and the docs disagree, trust the docs.

## Authentication

### API token (recommended)

```sh
export CLOUDFLARE_API_TOKEN="cf_<40-chars>"

# Verify token + see scopes
curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq .
```

**Token-scope rules of thumb**:

| Resource | Scope | Permissions |
|---|---|---|
| DNS records | Zone | `Zone:Read`, `DNS:Edit` |
| Workers / Pages | Account | `Workers Scripts:Edit`, `Workers Routes:Edit` |
| R2 buckets | Account | `Workers R2 Storage:Edit` |
| Rulesets | Account or Zone | `Account Rulesets:Edit` or `Zone:Rulesets:Edit` |
| Zero Trust (Access / Gateway / Tunnels) | Account | `Access: Apps and Policies:Edit`, `Cloudflare Tunnel:Edit` |
| Pages projects | Account | `Pages:Edit` |
| Custom hostnames | Zone | `SSL and Certificates:Edit` + `Custom Hostnames:Edit` |
| Cache purge (deploy tokens) | Zone | `Zone:Cache Purge` - or the post-deploy purge 401s |

Multiple tokens beat one mega-token. For automation that touches both Workers + DNS, mint two.

### Legacy: API key + email (avoid)

`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`. Only for truly ancient endpoints; every v4 endpoint you will touch accepts token-only.

## API basics

Base URL: `https://api.cloudflare.com/client/v4/`

```sh
# Account ID + zone IDs (paginated, 50 per page)
curl -sS https://api.cloudflare.com/client/v4/accounts \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result[] | {id, name}'

curl -sS https://api.cloudflare.com/client/v4/zones?per_page=50 \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result[] | {id, name, status}'
```

**Response envelope** (every endpoint):

```json
{
  "success": true,
  "errors": [],
  "messages": [],
  "result": { ... } | [ ... ],
  "result_info": { "page": 1, "per_page": 50, "total_count": N }
}
```

Always check `.success` and `.errors` before reading `.result`.
**Pagination**: pass `page=1&per_page=50` and loop until `result_info.total_count <= page * per_page`.

## DNS records

```sh
ZONE_ID="<zone-id>"

# List
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?per_page=100" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result[] | {id, type, name, content, proxied, ttl}'

# Create
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"A","name":"api","content":"203.0.113.1","ttl":1,"proxied":true}'
# ttl=1 = automatic. proxied=true = orange-cloud, false = grey-cloud (DNS-only).

# Patch (partial update)
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"203.0.113.2"}'

# Delete
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

## Cache purge (per-URL or full)

```sh
# Selective purge by URL (preferred)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files":["https://<host>/path1","https://<host>/path2"]}'

# Full zone purge (use sparingly - flushes everything)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"purge_everything":true}'

# Purge by tag (requires Enterprise + Cache-Tag header set by origin)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tags":["product-123","category-shoes"]}'
```

## Rulesets (firewall / WAF / cache / transform rules)

Page rules are legacy. Modern model: ruleset -> rules -> expressions.

```sh
# List ALL rulesets in a zone
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, phase}'

# Phases:
#   http_request_firewall_custom        # Custom WAF
#   http_request_firewall_managed       # Managed rules (paid)
#   http_request_dynamic_redirect       # Bulk redirects
#   http_request_late_transform         # Header injection
#   http_request_cache_settings         # Cache TTL / bypass / serve-stale
#   http_response_compression           # zstd / brotli / gzip
#   http_ratelimit                      # Rate limiting
#   ddos_l7                             # DDoS overrides
```

## Workers + Pages: deploy and secrets

```sh
wrangler init my-worker && cd my-worker
wrangler dev                 # local Workers runtime (miniflare), http://localhost:8787
wrangler dev --remote        # against the real edge - routes/DNS testing
wrangler deploy
wrangler tail --format=pretty --status=error

# Worker secrets (baked into env on next deploy)
wrangler secret put OPENAI_API_KEY          # paste value at prompt
wrangler secret list --name <worker-name>

# Pages: secrets via wrangler (wrangler 4.123.0 - `wrangler pages secret --help`)
wrangler pages secret put <KEY> --project-name <project>
wrangler pages secret list --project-name <project>
wrangler pages secret bulk secrets.json --project-name <project>
wrangler pages secret delete <KEY> --project-name <project>

# Pages: plain (non-secret) env vars go via the API or the dashboard
curl -sS -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/<project>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deployment_configs":{"production":{"env_vars":{"KEY":{"value":"...","type":"plain_text"}}}}}'
```

Config file, bindings (KV/R2/D1/Queues/DO/Hyperdrive/Email) and the
`assets` block: `bindings.md`. Use `wrangler.jsonc`, not `wrangler.toml`, for
new projects - some newer features are JSON-config only.

## Zero Trust vs the homelab edge

Zero Trust resources (Access, Gateway, Tunnels, WARP) are all account-scoped
under `/accounts/{id}/`. Policy design and the API surface belong to Claude
Code's vendored `cloudflare-one` bundle and the `cloudflare` docs topic; what
this skill owns is the placement decision:

- **Tunnel vs host-mode Caddy**: a Tunnel exposes a local service without
  inbound ports or a public IP (the origin dials out to the edge). It is the
  alternative to the `caddy` + public-DNS pattern when you cannot take
  inbound. Locally-managed tunnels (a `config.yml` in the cloudflared config
  dir + `cloudflared tunnel run`) and remotely-managed tunnels (ingress JSON
  set via dashboard/API) are mutually exclusive per tunnel - don't mix.
- **Access vs Authelia**: Access is the equivalent of the `(forward_auth)`
  Authelia snippet in the Caddy stack. Use Access when the app sits behind a
  Tunnel; use Authelia forward-auth when it sits behind host-mode Caddy.
  Don't double-gate.

## Headers cheat-sheet for debugging

| Header | What it tells you |
|---|---|
| `cf-cache-status` | `HIT` / `MISS` / `BYPASS` / `EXPIRED` / `REVALIDATED` / `DYNAMIC` / `STALE` |
| `cf-ray` | Request ID + datacenter (last 3 chars). Search dashboard logs by ray ID. |
| `cf-mitigated` | Set if WAF / DDoS / bot management blocked something. Value indicates which. |
| `server-timing: cdn-cache;desc=HIT` | Modern equivalent of cf-cache-status. |
| `x-content-source` | Worker-set, can identify which Worker handled the request. |

```sh
curl -sI "https://<host>/path" | rg -i 'cf-|server-timing'
```

## Rate-limit handling

- **HTTP 429** = your limit. Read the `retry-after` header (seconds).
- **HTTP 403 with "rate limited"** in the body = temporarily blocked beyond the soft limit.
- The Python SDK and Terraform provider retry automatically with exponential backoff. For custom scripts: wrap calls with `tenacity` or equivalent and cap concurrency with a semaphore (`automation.md`).
- The default per-token limit is **1200 / 5min**; certain endpoints (Pages deploy, R2 PUT) have separate limits.

## Common footguns

1. **Proxied vs DNS-only** (`proxied: true|false`). DNS-only records bypass Cloudflare entirely - no WAF, no cache, no analytics. Defaults to proxied for A/AAAA/CNAME pointing to public IPs.
2. **TTL=1 means automatic**, not "1 second". Cloudflare picks the TTL (usually 5min for proxied, 300s for DNS-only).
3. **Wildcard certificates** require an explicit `cloudflare_certificate_pack` resource on Free/Pro plans (Business+ auto-issues).
4. **Workers Routes vs Custom Domains**: Routes (zone-attached patterns) are flexible but require manual DNS. Custom Domains (worker-attached) auto-manage DNS but only one per hostname.
5. **R2 free egress** but you pay for class-A (PUT/POST/LIST) operations. List with `--limit` and `--prefix` to avoid blanket scans.
6. **D1 is SQLite** - single-writer. Bursty writes need queuing.
7. **KV is eventually consistent** to ~60s. Don't read-after-write inside the same request if correctness matters.
8. **Compatibility date drives the Workers runtime version.** Bumping it can break old workers. Keep `compatibility_flags` in mind for incremental Node compat.
9. **Workers Static Assets serve HTML from a per-PoP cache, ignoring your cache-control.** A static-assets deploy (wrangler `assets` block, no worker script) emits `cf-cache-status: HIT` on HTML even at `max-age=0, must-revalidate`, and a client `no-cache` request still gets the HIT - one PoP can hold the previous deploy for 20+ minutes while cache-busted URLs are already fresh (seen on erfi.dev). Fix: purge the zone after every deploy (`POST /zones/{id}/purge_cache` with `{"purge_everything":true}`), wired into BOTH the local deploy script and CI - a `wrangler-action` `command: deploy` step bypasses package.json hooks, and the deploy token needs `Zone:Cache Purge` or the purge 401s.
10. **Worker subrequests to a same-zone hostname resolve against the CF zone's DNS records, never public DNS.** If the zone is active on Cloudflare (e.g. kept for a Workers custom domain while authoritative NS lives elsewhere, like the erfi.io -> Knot delegation), a `fetch()` to any hostname on that zone needs a DNS record *in the CF zone* - DNS-only (grey) is fine and preferred for direct-to-origin. No record => error 1016 => HTTP 530 "Origin DNS error" surfaced to the Worker. The zone's authoritative DNS serving the name correctly is irrelevant; CF never consults it for subrequests. (Distinct from the inbound-routes rule, which needs a *proxied* placeholder like `AAAA 100::`.) Bit minio-cache after the Knot cutover: `cdn.erfi.io` had only its auto HTTPS/ECH record in the CF zone - adding a grey A record fixed it. Docs: `error-1016.md` in the `cloudflare` topic.

## Docs

- Docs mirror topics: `cloudflare` (full developer docs - limits, pricing, runtime APIs, product guides) and `cloudflare-api` (OpenAPI spec). pi: `docs_search(source="cloudflare-api", query="<endpoint>")`; Claude Code: erfi-toolkit `docs` tool with `action=search`, `source=cloudflare-api`.
- **Wrangler reference**: `wrangler help <subcommand>` - comprehensive and version-exact.
- **Workers runtime**: `developers.cloudflare.com/workers/runtime-apis/`.
- **Terraform provider docs**: `registry.terraform.io/providers/cloudflare/cloudflare/latest/docs`.

## Topics this skill does NOT cover (and where to go)

This skill is the **operator / API / IaC** angle plus the bindings you are most likely to use (`bindings.md`). For deep **dev-platform build** topics Cloudflare publishes an official skill bundle at **`github.com/cloudflare/skills`** (install: `npx skills add https://github.com/cloudflare/skills`, or clone into `~/.pi/agent/skills/` - their top-level skill is named `cloudflare`, which is why this one is `cloudflare-ops`). Claude Code already carries it, plus `wrangler`, `durable-objects`, `cloudflare-one` and `workers-best-practices`. It has dedicated references for: **Agents SDK** (stateful AI agents, MCP servers, streaming chat), **Workflows** (durable step execution), **Workers AI / Vectorize / AI Gateway / AI Search**, **Browser Rendering**, **Containers**, **Sandbox SDK**, **Bot Management / API Shield / DDoS / Turnstile**, **Pipelines / R2 SQL / R2 Data Catalog**, **Observability / Analytics Engine / GraphQL Analytics API**, **Pulumi**, and many more product references. Reach for it when building *on* the Workers platform beyond what is here.

## Related skills

- **`terraform`** - module structure + state backends for the cf-terraforming workflow (`automation.md`).
- **`infrastructure-stack`** - Caddy in host mode behind Cloudflare for the user's compose stacks.
- **`supabase`** - Workers BFF pattern uses Cloudflare + Supabase together (Hyperdrive notes in `bindings.md`).
