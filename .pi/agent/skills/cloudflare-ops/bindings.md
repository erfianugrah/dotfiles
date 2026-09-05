# cloudflare-ops: wrangler config + bindings (KV, R2, D1, DO, Queues, Hyperdrive, Email)

Supporting reference for the `cloudflare-ops` skill. Read when writing or
reviewing a `wrangler.jsonc`, or wiring a Worker to storage, a Durable Object,
a Queue, Hyperdrive or Email Routing. For deep build topics (Agents SDK,
Workflows, Workers AI) the routing section in SKILL.md points at Cloudflare's
own skill bundle.

Contents: wrangler.jsonc (assets, routes, KV/R2/D1/Queues bindings); R2; D1;
KV; Durable Objects; Queues; Hyperdrive; Email Routing + Email Workers.

## `wrangler.jsonc` (recommended since Wrangler v3.91.0)

Cloudflare recommends `wrangler.jsonc` for all new projects. Some newer Wrangler features are **only available in JSON config** - don't start new projects with `wrangler.toml`.

**Pure static assets** (no Worker script - just serve a `dist/` directory):

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

No `main`, no `binding` - omit `binding` when there is no Worker script (`main`), since binding is only useful for `env.ASSETS.fetch()` inside Worker code.

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
| `directory` | - | Build output folder (`./dist`, `./public`, `./build`) |
| `binding` | - | Only set when `main` is present; enables `env.ASSETS.fetch()` |
| `not_found_handling` | `"none"` | `"single-page-application"` -> 200+index.html; `"404-page"` -> nearest 404.html |
| `run_worker_first` | `false` | `true` = always invoke Worker; array of glob patterns for selective routing |

## R2 (S3-compatible object storage)

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

## D1 (SQLite at edge)

```sh
wrangler d1 create <db-name>
wrangler d1 execute <db-name> --command "SELECT * FROM users LIMIT 10"
wrangler d1 execute <db-name> --file=./migrations/001_init.sql
wrangler d1 migrations create <db-name> add_index
wrangler d1 migrations apply <db-name> --remote   # prod
wrangler d1 migrations apply <db-name> --local    # local miniflare
```

## KV (eventually-consistent key-value)

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
// wrangler.jsonc - SQLite-backed DO (recommended for all new DOs)
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
    // Schema setup only - blockConcurrencyWhile gates requests until done.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY, body TEXT)");
    });
  }
  // RPC method - call directly from the Worker (no fetch()), compat date >= 2024-04-03.
  async post(body: string) {
    this.ctx.storage.sql.exec("INSERT INTO msgs (body) VALUES (?)", body);
  }
}

// Worker routes to a DO instance by NAME (stable identity = persisted state).
export default {
  async fetch(req: Request, env: Env) {
    const id = env.ROOM.idFromName("general");   // same name -> same instance + state
    const stub = env.ROOM.get(id);
    await stub.post("hello");
    return new Response("ok");
  },
};
```

**Critical rules** (these are the silent-bug generators):

1. **`idFromName(x)` for persistent identity** - same input always maps to the same instance with its memory + storage. `newUniqueId()` makes a fresh, isolated DO every call (use for sharding high-throughput workloads). Forgetting `idFromName` and using `newUniqueId` is the #1 "my state never persists" bug.
2. **SQLite storage, not legacy KV** - configure `new_sqlite_classes` in migrations. `ctx.storage.sql.exec(...)` for queries; sync KV API (`ctx.storage.kv`) also available on SQLite DOs. 10GB/DO.
3. **Persist first, cache second** - always write storage before updating in-memory fields. Hibernation / eviction clears memory; storage survives.
4. **`blockConcurrencyWhile()` is for init only** - never wrap it around `fetch()` or external I/O on every request; it serialises and kills throughput.
5. **One alarm per DO** - `setAlarm()` replaces any existing alarm. For multiple future events use a queue-in-storage pattern and re-arm the single alarm.
6. **WebSocket Hibernation** - use `ctx.acceptWebSocket(ws)` + the `webSocketMessage`/`webSocketClose` handlers (not in-memory `addEventListener`) so idle connections cost nothing and survive eviction.
7. **~1K req/s ceiling per DO** - it's a single thread. Shard with `newUniqueId()` or a hash if you need more.

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

**Gotchas**: at-least-once -> handlers must be **idempotent**. Without explicit `ack()`, a thrown error retries the whole batch. `delaySeconds` on send or retry defers delivery. DLQ is itself a queue - give it its own consumer to inspect failures.

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

**Gotchas**: requires `compatibility_flags: ["nodejs_compat"]` + a TCP-socket-capable driver (`pg`, `postgres`, `mysql2`). Caching defaults to on for read queries - disable per-query or via config for write-after-read consistency. The connection string lives in the Hyperdrive config (server-side), not in your Worker secrets. **For Supabase, point Hyperdrive at the Direct connection string - NOT the Supavisor pooled connection strings.** Hyperdrive does its own pooling; stacking it on top of another pooler is the anti-pattern. Connect with `node-postgres`/`Postgres.js` directly, not the `@supabase/supabase-js` client. (Source: the `cloudflare` docs topic, `supabase.md`.)

## Email Routing + Email Workers

Email Routing forwards `*@<zone>` to real inboxes (or to a Worker) with zero mail-server hosting. Zone-scoped; token needs `Email Routing Addresses:Edit` + `Zone:Edit`.

```sh
# Enable + check status
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result | {enabled, status, name}'

# Destination addresses must be verified before routing to them
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"me@real-inbox.com"}'   # -> triggers a verification email

# Routing rule: forward hi@<zone> -> verified destination
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"hi","enabled":true,"matchers":[{"type":"literal","field":"to","value":"hi@<zone>"}],"actions":[{"type":"forward","value":["me@real-inbox.com"]}]}'
```

**Email Workers** - process inbound mail in a Worker (the `email()` handler) instead of forwarding. Bind in `wrangler.jsonc` and set the routing rule action to `worker`:

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

**Gotchas**: Email Routing adds its own MX + SPF records - they conflict with self-hosted mail on the same zone. `message.forward()` targets must be pre-verified destinations. Outbound *send* needs a `send_email` binding with an allowed `destination_address`, not arbitrary recipients.
