---
name: cloudflare
description: Drive Cloudflare via the API (REST), `wrangler` CLI (Workers / Pages / R2 / D1 / KV / Queues / Hyperdrive / Durable Objects / Tunnels / Email), and bulk Python automation. Covers token auth (account vs zone scoping), the resource model (zones / DNS / rulesets / Workers / R2 / Pages / Zero Trust), Durable Object patterns (sharding, alarms, hibernation, SQLite storage), Queues producer/consumer, Hyperdrive Postgres pooling, Email Routing + Workers, Zero Trust (Access / Gateway / WARP / Tunnels), rate-limit handling, and the import-existing-state-into-Terraform workflow via `cf-terraforming`. Pairs with the `terraform` skill for IaC and with `infrastructure-stack` (Caddy in front of compose stacks behind Cloudflare). Use when working against the Cloudflare API directly, writing wrangler-deployed Workers/Pages, building stateful Durable Objects, debugging DNS/cache/WAF behaviour, or scripting bulk operations across multiple zones.
---

# Cloudflare

## Core principles

1. **API token, not API key.** Global API keys are deprecated for new work. Always mint a scoped token with the minimum permissions (account-level vs zone-level vs user-level resources).
2. **Two scopes, two endpoints.** Zone-level resources (`/zones/{id}/...`) and account-level resources (`/accounts/{id}/...`) take different token permissions. Read the resource path before scoping the token.
3. **Rate limits are real.** Default 1,200 req / 5 min per token. `wrangler`, the Python SDK, and the Terraform provider all retry with backoff — your custom scripts must too.
4. **Cache headers matter.** When debugging unexpected responses, check `cf-cache-status`, `cf-ray`, and `cf-bgj` headers. Cloudflare's cache is aggressive; bypass with `Cache-Control: no-cache` from the origin or purge via API.
5. **Match the resource taxonomy in code.** A "page rule" is legacy. The current model is: rulesets → rules → expressions. Don't write code against deprecated endpoints unless you're maintaining old TF state.
6. **Prefer retrieval over baked-in knowledge for limits/pricing/signatures.** Cloudflare ships changes weekly. Before quoting a numeric limit, pricing tier, type signature, or new binding shape, check the live docs (`docs_search source="cloudflare"` — 6121 files — or `source="cloudflare-api"` for the OpenAPI spec). When this skill and the docs disagree, trust the docs.

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

### Zero Trust / Cloudflare One (Access + Gateway + Tunnels + WARP)

Zero Trust resources are **all account-scoped** under `/accounts/{id}/`. Token needs `Access: Apps and Policies:Edit`, `Zero Trust:Edit`, `Cloudflare Tunnel:Edit` as appropriate.

```sh
# --- Access (identity-aware app gating) ---
# List Access applications
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, domain, type}'

# Access policies for an app (allow/deny/bypass decisions + rules)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, decision}'

# Service tokens (for machine-to-machine Access — CI, scripts)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/service_tokens" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, client_id}'

# --- Gateway (DNS / HTTP / network filtering for WARP-enrolled devices) ---
# Gateway DNS-filtering rules
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/gateway/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, action, enabled}'

# Gateway locations (which networks map to which DoH endpoint)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/gateway/locations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, doh_subdomain}'

# --- Tunnels (cloudflared) ---
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel?is_deleted=false" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, name, status, connections: (.connections | length)}'

# Tunnel ingress config (which hostname → which local service)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result.config.ingress'
```

**Tunnel vs your homelab Caddy**: Tunnels expose a local service without opening ports / public IP (origin connects *outbound* to the edge). They're an alternative to the `caddy` + public-DNS pattern when you can't take inbound. **Locally-managed** tunnels (config in `~/.cloudflared/config.yml` + `cloudflared tunnel run`) and **remotely-managed** tunnels (ingress JSON above, set in dashboard/API) are mutually exclusive per tunnel — don't mix.

**Access ↔ Authelia**: Access is Cloudflare's equivalent of the `(forward_auth)` Authelia snippet in your Caddy stack. Use Access when the app sits *behind a Tunnel*; use Authelia forward-auth when it sits behind host-mode Caddy. Don't double-gate.

### Email Routing + Email Workers

Email Routing forwards `*@<zone>` to real inboxes (or to a Worker) with zero mail-server hosting. Zone-scoped; token needs `Email Routing Addresses:Edit` + `Zone:Edit`.

```sh
# Enable + check status
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result | {enabled, status, name}'

# Destination addresses must be verified before routing to them
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"me@real-inbox.com"}'   # → triggers a verification email

# Routing rule: forward hi@<zone> → verified destination
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"hi","enabled":true,"matchers":[{"type":"literal","field":"to","value":"hi@<zone>"}],"actions":[{"type":"forward","value":["me@real-inbox.com"]}]}'
```

**Email Workers** — process inbound mail in a Worker (the `email()` handler) instead of forwarding. Bind in `wrangler.jsonc` and set the routing rule action to `worker`:

```ts
export default {
  async email(message, env, ctx) {
    // message.from, message.to, message.headers, message.raw (ReadableStream)
    const subject = message.headers.get("subject") ?? "";
    if (subject.includes("spam")) { message.setReject("No thanks"); return; }
    // Re-forward (destination must still be a verified address)
    await message.forward("me@real-inbox.com");
    // Or send a new message via a send_email binding (env.SEB.send(...))
  },
};
```

**Gotchas**: Email Routing adds its own MX + SPF records — they conflict with self-hosted mail on the same zone. `message.forward()` targets must be pre-verified destinations. Outbound *send* needs a `send_email` binding with an allowed `destination_address`, not arbitrary recipients.

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

### `wrangler.jsonc` (recommended since Wrangler v3.91.0)

Cloudflare recommends `wrangler.jsonc` for all new projects. Some newer Wrangler features are **only available in JSON config** — don't start new projects with `wrangler.toml`.

**Pure static assets** (no Worker script — just serve a `dist/` directory):

```jsonc
{
  "name": "my-site",
  // Set this to today's date
  "compatibility_date": "2026-06-15",
  "assets": {
    "directory": "./dist",
  },
}
```

No `main`, no `binding` — omit `binding` when there is no Worker script (`main`), since binding is only useful for `env.ASSETS.fetch()` inside Worker code.

**Worker + static assets** (API routes + frontend in one Worker):

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  // Set this to today's date
  "compatibility_date": "2026-06-15",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",           // required only when main is set
    // "not_found_handling": "single-page-application",  // SPA fallback to index.html
    // "run_worker_first": ["/api/*", "!/api/docs/*"],  // selective Worker-first routing
  },
  // Routes (zone-scoped)
  "routes": [
    { "pattern": "api.<host>/*", "zone_name": "<host>" }
  ],
  // Workers KV
  "kv_namespaces": [
    { "binding": "CACHE", "id": "<kv-id>" }
  ],
  // Workers R2
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "<bucket-name>" }
  ],
  // Workers D1 (SQLite at edge)
  "d1_databases": [
    { "binding": "DB", "database_name": "<db-name>", "database_id": "<d1-id>" }
  ],
  // Queues
  "queues": {
    "producers": [{ "binding": "TASKS", "queue": "task-queue" }],
    "consumers": [{ "queue": "task-queue", "max_batch_size": 25, "max_batch_timeout": 30 }]
  },
}
```

**`assets` key reference**:

| Field | Default | Notes |
|---|---|---|
| `directory` | — | Build output folder (`./dist`, `./public`, `./build`) |
| `binding` | — | Only set when `main` is present; enables `env.ASSETS.fetch()` |
| `not_found_handling` | `"none"` | `"single-page-application"` → 200+index.html; `"404-page"` → nearest 404.html |
| `run_worker_first` | `false` | `true` = always invoke Worker; array of glob patterns for selective routing |

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

## Durable Objects (stateful coordination)

Workers are stateless; Durable Objects (DOs) are **single-threaded, globally-unique, strongly-consistent** compute+storage. Reach for a DO when you need coordination (chat rooms, multiplayer), strong consistency (booking, inventory), per-entity storage (per-user/tenant DB), persistent WebSockets, or per-entity scheduled work. For stateless request handling, stay in a plain Worker.

```jsonc
// wrangler.jsonc — SQLite-backed DO (recommended for all new DOs)
{
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "ChatRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }]
}
```

```ts
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject<Env> {
  // Constructor runs on EVERY wake (incl. after hibernation). Keep it light.
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup only — blockConcurrencyWhile gates requests until done.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY, body TEXT)");
    });
  }
  // RPC method — call directly from the Worker (no fetch()), compat date >= 2024-04-03.
  async post(body: string) {
    this.ctx.storage.sql.exec("INSERT INTO msgs (body) VALUES (?)", body);
  }
}

// Worker routes to a DO instance by NAME (stable identity = persisted state).
export default {
  async fetch(req: Request, env: Env) {
    const id = env.ROOM.idFromName("general");   // same name → same instance + state
    const stub = env.ROOM.get(id);
    await stub.post("hello");
    return new Response("ok");
  },
};
```

**Critical rules** (these are the silent-bug generators):

1. **`idFromName(x)` for persistent identity** — same input always maps to the same instance with its memory + storage. `newUniqueId()` makes a fresh, isolated DO every call (use for sharding high-throughput workloads). Forgetting `idFromName` and using `newUniqueId` is the #1 "my state never persists" bug.
2. **SQLite storage, not legacy KV** — configure `new_sqlite_classes` in migrations. `ctx.storage.sql.exec(...)` for queries; sync KV API (`ctx.storage.kv`) also available on SQLite DOs. 10GB/DO.
3. **Persist first, cache second** — always write storage before updating in-memory fields. Hibernation / eviction clears memory; storage survives.
4. **`blockConcurrencyWhile()` is for init only** — never wrap it around `fetch()` or external I/O on every request; it serialises and kills throughput.
5. **One alarm per DO** — `setAlarm()` replaces any existing alarm. For multiple future events use a queue-in-storage pattern and re-arm the single alarm.
6. **WebSocket Hibernation** — use `ctx.acceptWebSocket(ws)` + the `webSocketMessage`/`webSocketClose` handlers (not in-memory `addEventListener`) so idle connections cost nothing and survive eviction.
7. **~1K req/s ceiling per DO** — it's a single thread. Shard with `newUniqueId()` or a hash if you need more.

**Testing**: `@cloudflare/vitest-pool-workers` runs DOs in the real workerd runtime (alarms, storage, isolation all real). Prefer it over mocking.

## Queues (async message processing)

At-least-once delivery, batched consumers, automatic retries + DLQ. Producer and consumer are both Workers.

```jsonc
// wrangler.jsonc
{
  "queues": {
    "producers": [{ "binding": "TASKS", "queue": "task-queue" }],
    "consumers": [{
      "queue": "task-queue",
      "max_batch_size": 25,        // up to 100
      "max_batch_timeout": 30,     // seconds to wait to fill a batch
      "max_retries": 3,
      "dead_letter_queue": "task-dlq"   // failed msgs land here after max_retries
    }]
  }
}
```

```ts
export default {
  // Producer
  async fetch(req: Request, env: Env) {
    await env.TASKS.send({ url: "https://..." });          // single
    await env.TASKS.sendBatch([{ body: {...} }, { body: {...} }]); // batch
    return new Response("queued");
  },
  // Consumer
  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      try { await handle(msg.body); msg.ack(); }   // explicit ack
      catch { msg.retry({ delaySeconds: 60 }); }   // re-deliver later
    }
    // Or batch.ackAll() / batch.retryAll()
  },
};
```

**Gotchas**: at-least-once → handlers must be **idempotent**. Without explicit `ack()`, a thrown error retries the whole batch. `delaySeconds` on send or retry defers delivery. DLQ is itself a queue — give it its own consumer to inspect failures.

## Hyperdrive (pooled access to existing Postgres/MySQL)

Makes a regional database feel local to Workers: connection pooling + query caching at the edge, so each Worker invocation doesn't pay a fresh TCP+TLS handshake to your origin DB. **Directly relevant to fronting a Supabase / self-hosted Postgres with Workers.**

```sh
# Create a Hyperdrive config pointing at your existing DB
wrangler hyperdrive create my-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
wrangler hyperdrive list
```

```jsonc
// wrangler.jsonc
{ "hyperdrive": [{ "binding": "DB", "id": "<hyperdrive-config-id>" }] }
```

```ts
import { Pool } from "pg";   // or postgres / mysql2; needs nodejs_compat
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const pool = new Pool({ connectionString: env.DB.connectionString });
    const { rows } = await pool.query("SELECT 1");
    ctx.waitUntil(pool.end());   // don't leak connections
    return Response.json(rows);
  },
};
```

**Gotchas**: requires `compatibility_flags: ["nodejs_compat"]` + a TCP-socket-capable driver (`pg`, `postgres`, `mysql2`). Caching defaults to on for read queries — disable per-query or via config for write-after-read consistency. The connection string lives in the Hyperdrive config (server-side), not in your Worker secrets. **For Supabase, point Hyperdrive at the Direct connection string — NOT the Supavisor pooled connection strings.** Hyperdrive does its own pooling; stacking it on top of another pooler is the anti-pattern. Connect with `node-postgres`/`Postgres.js` directly, not the `@supabase/supabase-js` client. (Source: `/docs/cloudflare/supabase.md`.)

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

- **OpenAPI spec** mirrored at docs.erfi.io: `docs_search(source="cloudflare-api", query="<endpoint>")` (510 files).
- **Full developer docs** mirrored at docs.erfi.io: `docs_search(source="cloudflare", query="...")` (6121 files) — limits, pricing, runtime APIs, product guides.
- **Wrangler reference**: `wrangler help <subcommand>` — comprehensive.
- **Workers runtime**: `developers.cloudflare.com/workers/runtime-apis/`.
- **Terraform provider docs**: `registry.terraform.io/providers/cloudflare/cloudflare/latest/docs`.

## Topics this skill does NOT cover (and where to go)

This skill is the **operator / API / IaC** angle plus the bindings you're most likely to use (DO, Queues, Hyperdrive, Email, Zero Trust). For deep **dev-platform build** topics it deliberately doesn't vendor, Cloudflare publishes an official Pi-compatible skill bundle at **`github.com/cloudflare/skills`** (install: `npx skills add https://github.com/cloudflare/skills`, or clone into `~/.pi/agent/skills/` — rename their `cloudflare` skill to avoid colliding with this one). It carries dedicated references for: **Agents SDK** (stateful AI agents, MCP servers, streaming chat), **Workflows** (durable step execution), **Workers AI / Vectorize / AI Gateway / AI Search** (RAG + inference), **Browser Rendering**, **Containers**, **Sandbox SDK**, **Bot Management / API Shield / DDoS / Turnstile**, **Pipelines / R2 SQL / R2 Data Catalog**, **Observability / Analytics Engine / GraphQL Analytics API**, **Pulumi**, and ~50 more product references. Reach for it when building *on* the Workers platform beyond what's here.

## Related skills

- **`terraform`** — module structure + state backends for the cf-terraforming workflow above.
- **`infrastructure-stack`** — Caddy in host mode behind Cloudflare for the user's compose stacks.
- **`supabase`** — Workers BFF pattern uses Cloudflare + Supabase together.
