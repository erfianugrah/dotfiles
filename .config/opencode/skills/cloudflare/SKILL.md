---
name: cloudflare
description: Drive Cloudflare via the API (REST), `wrangler` CLI (Workers / Pages / R2 / D1 / KV / Tunnels), and bulk Python automation. Covers token auth (account vs zone scoping), the resource model (zones / DNS / rulesets / Workers / R2 / Pages / Zero Trust), rate-limit handling, and the import-existing-state-into-Terraform workflow via `cf-terraforming`. Pairs with the `terraform` skill for IaC and with `infrastructure-stack` (Caddy in front of compose stacks behind Cloudflare). Use when working against the Cloudflare API directly, writing wrangler-deployed Workers/Pages, debugging DNS/cache/WAF behaviour, or scripting bulk operations across multiple zones.
---

# Cloudflare

## Core principles

1. **API token, not API key.** Global API keys are deprecated for new work. Always mint a scoped token with the minimum permissions (account-level vs zone-level vs user-level resources).
2. **Two scopes, two endpoints.** Zone-level resources (`/zones/{id}/...`) and account-level resources (`/accounts/{id}/...`) take different token permissions. Read the resource path before scoping the token.
3. **Rate limits are real.** Default 1,200 req / 5 min per token. `wrangler`, the Python SDK, and the Terraform provider all retry with backoff — your custom scripts must too.
4. **Cache headers matter.** When debugging unexpected responses, check `cf-cache-status`, `cf-ray`, and `cf-bgj` headers. Cloudflare's cache is aggressive; bypass with `Cache-Control: no-cache` from the origin or purge via API.
5. **Match the resource taxonomy in code.** A "page rule" is legacy. The current model is: rulesets → rules → expressions. Don't write code against deprecated endpoints unless you're maintaining old TF state.

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

Multiple tokens beat one mega-token. For automation that touches both Workers + DNS, mint two.

### Legacy: API key + email (avoid)

```sh
export CLOUDFLARE_API_KEY="..."
export CLOUDFLARE_EMAIL="..."
```

Only use this when working with truly ancient API endpoints. Most v4 endpoints accept token-only.

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

## Common API patterns

### DNS records

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

### Cache purge (per-URL or full)

```sh
# Selective purge by URL (preferred)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files":["https://<host>/path1","https://<host>/path2"]}'

# Full zone purge (use sparingly — flushes everything)
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

### Rulesets (new firewall / WAF / cache rules)

Page rules are legacy. Modern model: ruleset → rules → expressions.

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

### Workers + Pages secrets

```sh
# Set Worker secret (gets baked into env on next deploy)
wrangler secret put OPENAI_API_KEY
# (paste value at prompt)

# List secrets
wrangler secret list --name <worker-name>

# Pages env vars (via API since wrangler doesn't manage Pages env yet)
curl -sS -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/<project>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deployment_configs":{"production":{"env_vars":{"KEY":{"value":"...","type":"secret_text"}}}}}'
```

### Zero Trust (Access apps + Tunnels)

```sh
# List Access applications
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, domain, type}'

# Cloudflared tunnel list
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel?is_deleted=false" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, status, connections: (.connections | length)}'
```

## `wrangler` CLI workflow

### Worker dev → deploy

```sh
# Scaffold
wrangler init my-worker
cd my-worker

# Local dev (full Workers runtime via miniflare)
wrangler dev
# → opens http://localhost:8787

# Remote dev (against actual Cloudflare edge — useful for routes/DNS testing)
wrangler dev --remote

# Deploy
wrangler deploy

# Tail prod logs in real time
wrangler tail
# Filter: wrangler tail --format=pretty --status=error
```

### `wrangler.toml` (modern: `wrangler.jsonc` also supported)

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# Routes (zone-scoped)
[[routes]]
pattern = "api.<host>/*"
zone_name = "<host>"

# Workers KV
[[kv_namespaces]]
binding = "CACHE"
id = "<kv-id>"

# Workers R2
[[r2_buckets]]
binding = "ASSETS"
bucket_name = "<bucket-name>"

# Workers D1 (SQLite at edge)
[[d1_databases]]
binding = "DB"
database_name = "<db-name>"
database_id = "<d1-id>"

# Queues
[[queues.producers]]
binding = "TASKS"
queue = "task-queue"

[[queues.consumers]]
queue = "task-queue"
max_batch_size = 25
max_batch_timeout = 30
```

### R2 (S3-compatible object storage)

```sh
# Buckets
wrangler r2 bucket create <bucket>
wrangler r2 bucket list

# Objects
wrangler r2 object put <bucket>/<key> --file ./file.bin
wrangler r2 object get <bucket>/<key> --file ./out.bin
wrangler r2 object list <bucket> --prefix "images/"
wrangler r2 object delete <bucket>/<key>

# S3-compatible (use aws-cli with R2 endpoint)
aws s3 ls --endpoint-url "https://$ACCOUNT_ID.r2.cloudflarestorage.com" s3://<bucket>/
```

### D1 (SQLite at edge)

```sh
wrangler d1 create <db-name>
wrangler d1 execute <db-name> --command "SELECT * FROM users LIMIT 10"
wrangler d1 execute <db-name> --file=./migrations/001_init.sql
wrangler d1 migrations create <db-name> add_index
wrangler d1 migrations apply <db-name> --remote   # prod
wrangler d1 migrations apply <db-name> --local    # local miniflare
```

### KV (eventually-consistent key-value)

```sh
# Up to ~60s replication lag worldwide. NOT for primary state.
wrangler kv key put --namespace-id=<id> "key" "value" --ttl=3600
wrangler kv key get --namespace-id=<id> "key"
wrangler kv key list --namespace-id=<id> --prefix="session:"
wrangler kv bulk put --namespace-id=<id> ./batch.json   # [{"key":"k","value":"v"}, ...]
```

## Python automation (bulk operations across many zones)

For operations that touch 10+ zones or need async (e.g. bulk DNS export, custom-hostname audit), use the official Python SDK with concurrency. Pattern:

```python
import asyncio, os
from cloudflare import AsyncCloudflare

cf = AsyncCloudflare(api_token=os.environ["CLOUDFLARE_API_TOKEN"])

async def per_zone(zone):
    records = []
    async for rec in cf.dns.records.list(zone_id=zone.id, per_page=100):
        records.append(rec)
    return zone.name, records

async def main():
    zones = [z async for z in cf.zones.list(per_page=50)]
    # Bounded concurrency to stay under rate limit
    sem = asyncio.Semaphore(8)
    async def bounded(z):
        async with sem:
            return await per_zone(z)
    results = await asyncio.gather(*(bounded(z) for z in zones))
    for name, recs in results:
        print(f"{name}: {len(recs)} records")

asyncio.run(main())
```

**Why async + semaphore**: blanket-`gather` on 100+ zones will trip rate limits. `asyncio.Semaphore(8)` caps concurrent requests.

**Retry pattern** (the SDK retries built-in, but for raw HTTP):

```python
import httpx, tenacity

@tenacity.retry(
    retry=tenacity.retry_if_exception_type(httpx.HTTPStatusError),
    wait=tenacity.wait_exponential(multiplier=2, min=2, max=30),
    stop=tenacity.stop_after_attempt(5),
)
async def cf_get(client, url):
    r = await client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})
    r.raise_for_status()
    return r.json()
```

## Importing existing resources into Terraform

When you have hand-managed Cloudflare and want IaC:

```sh
# 1. Install
go install github.com/cloudflare/cf-terraforming@latest

# 2. Generate .tf for an existing resource type
cf-terraforming generate \
  --resource-type "cloudflare_record" \
  --zone $ZONE_ID > dns.tf

# 3. Generate import commands (one per resource)
cf-terraforming import \
  --resource-type "cloudflare_record" \
  --zone $ZONE_ID > dns.imports.sh

# 4. Run the imports (one terraform import call per resource)
bash dns.imports.sh

# 5. Verify drift is zero
terraform plan   # should report "no changes"
```

Supported resource types: `cloudflare_record`, `cloudflare_zone_settings_override`, `cloudflare_ruleset`, `cloudflare_access_application`, `cloudflare_tunnel`, `cloudflare_pages_project`, `cloudflare_worker_script`, ~80 more. Run `cf-terraforming -h` for the full list.

**Pair with the `terraform` skill** for module structure + state backends.

## BIND zone file → Cloudflare DNS

For migrating from a traditional DNS host that exports BIND:

```sh
# 1. Get the BIND file from the old provider (export feature)
# 2. Convert via dnscontrol, octodns, or a custom Python script
# 3. Push via terraform OR direct API bulk-create

# Or via Cloudflare's import endpoint (zone-level)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/import" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "file=@zone.bind"
```

## Headers cheat-sheet for debugging

| Header | What it tells you |
|---|---|
| `cf-cache-status` | `HIT` / `MISS` / `BYPASS` / `EXPIRED` / `REVALIDATED` / `DYNAMIC` / `STALE` |
| `cf-ray` | Request ID + datacenter (last 3 chars). Search dashboard logs by ray ID. |
| `cf-bgj` | Background go-just response trigger; `imgq`/`h2pri` etc. |
| `cf-mitigated` | Set if WAF / DDoS / bot management blocked something. Value indicates which. |
| `server-timing: cdn-cache;desc=HIT` | Modern equivalent of cf-cache-status. |
| `x-content-source` | Worker-set, can identify which Worker handled the request. |

```sh
curl -sI "https://<host>/path" | rg -i 'cf-|server-timing'
```

## Rate-limit handling

- **HTTP 429** = your limit. Read `retry-after` header (seconds).
- **HTTP 403 with "rate limited"** in body = you've been temporarily blocked beyond the soft limit.
- The Python SDK and Terraform provider retry automatically with exponential backoff.
- For custom scripts: wrap calls with `tenacity` or equivalent; cap concurrency with a semaphore.
- The default per-token limit is **1200 / 5min**; certain endpoints (Pages deploy, R2 PUT) have separate limits.

## Common footguns

1. **Proxied vs DNS-only** (`proxied: true|false`). DNS-only records bypass Cloudflare entirely — no WAF, no cache, no analytics. Defaults to proxied for A/AAAA/CNAME pointing to public IPs.
2. **TTL=1 means automatic**, not "1 second". Cloudflare picks the TTL (usually 5min for proxied, 300s for DNS-only).
3. **Wildcard certificates** require explicit `cloudflare_certificate_pack` resource on Free/Pro plans (Business+ auto-issues).
4. **Workers Routes vs Custom Domains**: Routes (zone-attached patterns) are flexible but require manual DNS. Custom Domains (worker-attached) auto-manage DNS but only one per hostname.
5. **R2 free egress** but you pay for class-A (PUT/POST/LIST) operations. List with `--limit` and `--prefix` to avoid blanket scans.
6. **D1 is SQLite** — single-writer. Bursty writes need queuing.
7. **KV eventually-consistent** to ~60s. Don't read-after-write inside the same request if correctness matters.
8. **Compatibility date drives Workers runtime version.** Bumping it can break old workers. Keep `compatibility_flags` in mind for incremental Node compat.

## Docs

- **OpenAPI spec** mirrored at docs.erfi.io: `docs_search(source="cloudflare-api", query="<endpoint>")`.
- **Wrangler reference**: `wrangler help <subcommand>` — comprehensive.
- **Workers runtime**: `developers.cloudflare.com/workers/runtime-apis/`.
- **Terraform provider docs**: `registry.terraform.io/providers/cloudflare/cloudflare/latest/docs`.

## Related skills

- **`terraform`** — module structure + state backends for the cf-terraforming workflow above.
- **`infrastructure-stack`** — Caddy in host mode behind Cloudflare for the user's compose stacks.
- **`supabase`** — Workers BFF pattern uses Cloudflare + Supabase together.
