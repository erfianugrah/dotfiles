---
name: supabase
description: "Use when building on or operating Supabase - wiring supabase-js, @supabase/server or @supabase/ssr; getClaims vs getUser vs getSession; reaching a project database without a DB password; the supabase CLI or MCP; schema iteration and migrations; RLS policy design; Edge Functions, Realtime, Storage, Auth, branching, pooler ports. NOT for a Postgres performance report (pg-analyser), a logical-replication migration (sbshift), or SQL/index/RLS-predicate tuning (supabase-postgres-best-practices)."
metadata:
  author: supabase
  version: "0.6.0"
---

# Supabase

## Core Principles

1. **Verify against current docs first.** Training data is stale. Function
   signatures, `config.toml` keys and API conventions change between versions.
   Look up before implementing (Docs Access below).
2. **Verify work.** Run a test query after every fix. An unverified fix is
   incomplete.
3. **Read the SDK source before claiming a contract violation.** When a
   function "must take parameter X", read
   `node_modules/@supabase/.../<file>.js` to confirm. Findings built on an
   assumed SDK contract have been wrong; five minutes of source-reading
   catches them.
4. **Recover, don't loop.** If an approach fails 2-3 attempts, stop. Try a
   different method, check docs, inspect the error, review logs.
5. **RLS by default.** Enable RLS on every table in exposed schemas. Private
   schemas: RLS as defence-in-depth. Policies match the actual access model,
   not a blanket `auth.uid()`. Predicate performance
   (`(SELECT auth.uid())`, join minimisation) is in the
   `supabase-postgres-best-practices` skill.

## Picking the right Supabase library

| Use case | Library |
|---|---|
| **Edge Function / Worker / Vercel Function / Hono / Bun** with **header-based** auth (Bearer JWT) | **`@supabase/server`** - the default for backend code |
| **Next.js / SvelteKit / Astro / Remix** with **cookie-based** auth | `@supabase/ssr` |
| **Browser client** (frontend, queries via PostgREST/Realtime) | `@supabase/supabase-js` |
| **Worker BFF with HttpOnly cookies** (browser -> Worker -> Supabase, browser never sees the JWT) | Hand-rolled `@supabase/supabase-js` + `getServiceRoleClient` cache. `@supabase/server` is header-only and does not replace this. |

If you are hand-rolling auth verification, JWT parsing, two clients
(user-scoped + admin), CORS, env-var wiring, or `_shared/*.ts` files inside an
Edge Function or Worker - stop and use `@supabase/server`.

## Server-side identity: getClaims / getUser / getSession

From the docs mirror `/docs/supabase/guides/auth/server-side/creating-a-client.md`:

- `getClaims()` protects pages and data. It verifies the access token locally
  (WebCrypto + cached JWKS) when the project uses asymmetric signing keys (the
  default for new projects); with symmetric keys it calls `getUser` solely to
  validate. Claims come from the JWT, never from a user lookup.
- `getUser()` when you need a fresh, server-confirmed user record; it costs a
  network call to Auth.
- `getSession()` only when you need the raw access/refresh token to forward.
  It is read from storage and not re-validated, so never trust its user
  object for authorisation in server code (middleware, proxies, loaders).

## `@supabase/server` quickstart (default for backend code)

```ts
import { withSupabase } from 'npm:@supabase/server' // or '@supabase/server' on Workers/Bun

export default {
	fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
		const { supabase, supabaseAdmin, userClaims, jwtClaims, authMode, authKeyName } = ctx;
		// supabase - RLS-scoped (user or anon depending on auth mode)
		// supabaseAdmin - bypasses RLS (service role)
		// userClaims - JWT-derived identity (id, email, role). null when not user-auth
		// jwtClaims - full JWT claims. null when not user-auth
		// authMode - 'user' | 'publishable' | 'secret' | 'none' (which mode matched)
		// authKeyName - when an apikey was used, the name from the plural env map
		const { data } = await supabase.from('todos').select();
		return Response.json(data);
	}),
};
```

**Auth modes** (declarative, one line states the security model):

```ts
withSupabase({ auth: 'user' }, ...)               // valid user JWT required (default)
withSupabase({ auth: 'none' }, ...)               // unauthenticated OK (webhooks, health)
withSupabase({ auth: 'secret' }, ...)             // server-to-server, validates secret key
withSupabase({ auth: 'publishable' }, ...)        // validates publishable key - apikey header
withSupabase({ auth: 'publishable:web_app' }, ...) // named-key variant (entry in plural env map)
withSupabase({ auth: 'secret:cron' }, ...)        // named-key variant for secret keys
withSupabase({ auth: ['user', 'secret'] }, ...)   // first match wins
```

- **Array fall-through**: first match wins. An absent credential falls
  through to the next mode; a present-but-invalid JWT rejects the request (no
  silent downgrade). A tampered JWT cannot slip past `'user'` and quietly
  succeed as `'secret'`.
- **Publishable-key auth is anonymous, not admin.** `ctx.supabase` is the
  anon-role client (RLS applies); `userClaims`/`jwtClaims` are `null`. Use it
  for client-key-gated public endpoints. `'secret'` is the mode where
  `ctx.supabaseAdmin` bypasses RLS.
- **Header convention**: `'user'` reads `Authorization: Bearer`;
  `'publishable'`/`'secret'` read the `apikey` header. Both may be present;
  `withSupabase` picks the mode that matches.

**What it gives you**: local JWT verification via JWKS (no per-request
`auth.getUser(token)` round-trip), two pre-wired clients, CORS before the
handler runs, named-key validation (rotate `cron` without touching `web_app`).

Framework adapters (Hono, H3, Elysia, NestJS), the `@supabase/server/core`
primitives, config options and the v0-to-v1 rename map: read
`reference/server-package.md` when generating code beyond the quickstart.

### Env-vars read by `@supabase/server`

Plural map form (Supabase Edge Functions auto-inject these):

| Variable | Format |
|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEYS` | JSON map `{"default":"sb_publishable_...","web":"sb_publishable_..."}` |
| `SUPABASE_SECRET_KEYS` | JSON map `{"default":"sb_secret_...","cron":"sb_secret_..."}` |
| `SUPABASE_JWKS` | `{"keys":[...]}` or `[...]` - inline JWKS for local verification |

Singular fallback (local dev, self-hosted): `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` (used when `SUPABASE_JWKS` unset).
Plural takes priority when both are set. The old names `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` are **not** read - rename, or wire via the `env`
config option.

### Runtime notes

- **Supabase Edge Functions**: env auto-injected. With `auth: 'publishable' |
  'secret' | 'none'` you MUST disable the platform JWT check or the platform
  rejects the request before `@supabase/server` sees it:
  ```toml
  [functions.my-function]
  verify_jwt = false
  ```
- **Cloudflare Workers**: enable `nodejs_compat`, or pass env overrides via
  the `env` config option.
- **Deno / Bun / Node**: `export default { fetch }` works out of the box.

### Status

v1.x, SemVer since 1.0.0; upstream still self-describes it as "Public Beta".
Check `npm view @supabase/server version` before citing a version or a
feature's availability.

### When NOT to use `@supabase/server` alone

- **Cookie-based sessions** (browser-direct Next.js/SvelteKit/Remix): use
  `@supabase/ssr` for cookie + refresh rotation and compose `@supabase/server`
  on top for verified claims + typed clients (`docs/ssr-frameworks.md` in the
  mirror). They coexist.
- **Worker-BFF flows** where the Worker translates an HttpOnly cookie into a
  JWT: cookie handling is yours, but `createContextClient(jwt)` /
  `verifyCredentials` still apply once the JWT is extracted.
- **PKCE OAuth bridges** with a custom `storage` shim: hand-rolled
  `createClient` is still needed.

## Security checklist (any integration)

- **Auth/session**
  - Never use `user_metadata` (`raw_user_meta_data`) for authorisation - it
    is user-editable. Use `raw_app_meta_data` / `app_metadata`.
  - Deleting a user does not invalidate tokens. Sign out / revoke first, keep
    JWT expiry short, validate `session_id` against `auth.sessions` for strict
    guarantees. `app_metadata` / `auth.jwt()` claims are stale until refresh.
  - `admin.signOut(jwt, scope)` takes a JWT, not a user UUID (posts
    `/logout?scope=...` with the JWT as bearer; confirmed in
    `auth-js/dist/main/GoTrueAdminApi.js`). `'global'` revokes every refresh
    token.
  - Email-template `type=` hardcoding, signup anti-enumeration and the
    403-vs-401 login distinction: `reference/auth-flows.md`.
- **API keys and logging**
  - Never expose `service_role`/secret keys in public clients; `NEXT_PUBLIC_`
    vars reach the browser.
  - Never accept secrets in query strings - log pipelines capture every URL.
    Reject sensitive query keys and redact an allowlist (`token`,
    `token_hash`, `code`, `access_token`, `refresh_token`) in the request
    logger. Body-only for secrets. Local secret policy: the `secret-handling`
    skill.
  - **Open redirect**: never validate `next=` with `startsWith('/') &&
    !startsWith('//')`; the WHATWG parser maps `\` to `/`, so `/\evil.com`
    becomes `https://evil.com/`. Use `new URL(next, request.url)` and assert
    `candidate.origin === request.origin`.
- **RLS / views / privileged code**
  - Views bypass RLS by default: `CREATE VIEW ... WITH (security_invoker =
    true)` (Postgres 15+); otherwise revoke from `anon`/`authenticated` or use
    an unexposed schema.
  - UPDATE needs a SELECT policy; without it updates silently return 0 rows.
  - No `security definer` functions in exposed schemas.
- **Storage**: upsert needs INSERT + SELECT + UPDATE policies
  (`reference/storage.md`).

More: `https://supabase.com/docs/guides/security/product-security.md`

## Hand-rolled patterns (when `@supabase/server` does not fit)

Skip if you are on `@supabase/server`. Covers Worker BFF with HttpOnly
cookies, PKCE bridges and other custom flows.

### Server-side `createClient()` config

Outside a browser always pass:

```ts
createClient(url, key, {
	auth: {
		autoRefreshToken: false,   // no setTimeout in a Worker
		persistSession: false,     // no localStorage in a Worker
		detectSessionInUrl: false, // no window.location to parse
	},
});
```

The client is then stateless; memoise by `(url, key)` for
many-requests-per-isolate runtimes - `createClient()` is a non-trivial
per-request cost. Per-request handler classes owning the cached client are
safe; the "concurrent setSession race" only fires with a module-scope client
plus `setSession`. **Do not cache PKCE-flow clients** - `signInWithOAuth` and
`exchangeCodeForSession` need a per-request `storage` shim.

### Worker BFF cookie pattern

Browser -> Worker -> Supabase; the browser never sees the JWT.

- Worker sets `HttpOnly; Secure; SameSite=Strict` `sb-access-token` (1h) +
  `sb-refresh-token` (7d) cookies on success.
- `GET /api/auth/session` reads the cookie, calls `auth.getUser(token)`,
  refreshes via `auth.refreshSession({ refresh_token })` when expired.
  Rate-limit it - otherwise it is a stolen-JWT validity oracle.
- One Worker endpoint owns refresh - no multi-tab race.
- PKCE: capture-only `storage` shim during `signInWithOAuth` to extract the
  `code_verifier`; stash in an `sb-pkce-verifier` HttpOnly cookie that MUST
  be `SameSite=Lax` - the OAuth redirect is a cross-site top-level
  navigation and `Strict` drops the cookie.
- Logout: `auth.admin.signOut(accessToken, 'global')` plus cookie clear.

### Rate limiting on Cloudflare Workers

Use the Rate Limiting binding, never an in-memory map (isolates do not
coordinate across colos). `period` must be 10 or 60; `namespace_id` unique per
account and per environment. Key on `CF-Connecting-IP`, then the first
`X-Forwarded-For` token, then `'unknown'`; scope per endpoint. Fail open on
binding error (log, pass) and no-op when the binding is undefined so tests need
no stub.

### Browser-side encryption caveats

`sessionStorage`, not `localStorage`, for a client-cached master key
(tab-scoped). None of it defends against XSS or storage-reading extensions -
say so in SECURITY.md; an "encrypted" key beside its ciphertext in the same
storage is theatre.

## Platform behaviours measured in supabase-lab

Numbers live in the edge-resilience RUNLOG
(<https://github.com/erfianugrah/supabase-lab/tree/main/experiments/edge-resilience>).

- **PostgREST treats unknown query params as column filters and 400s.** Strip
  probe-only params (`?_bust=`) before the origin fetch; keep them only in the
  cache key.
- **The spend cap is not a request-path circuit breaker.** Requests past a
  quota still return 200; enforcement rides the billing path (notification ->
  grace period -> Fair Use restrictions), not the API response at quota+1.
- **Fresh-project Storage lags ACTIVE_HEALTHY** (`TenantNotFound`, then 429
  SlowDown). Retry with backoff for the first minutes.
- **Auth config defaults differ across project generations.** Config-parity
  checks must diff only the keys you set, or record platform drift as
  evidence.
- **`auth.*` and `storage.*` never replicate managed-to-managed** (custom
  schemas do). Standby auth posture = TPA token portability + SQL backfill or
  forced re-login. Migration mechanics: the `sbshift` skill.

## PostgREST error handling (client side)

- `PGRST116` on `.single()` means zero rows, not an error:
  `if (error?.code === 'PGRST116') return null;`
- An RLS-blocked DELETE returns `{ error: null, count: 0 }`. Request
  `{ count: 'exact' }` and treat `count === 0` as "not deleted".
- Catch Postgres `23505` (unique violation) and answer HTTP 409; do not let
  the raw message reach the client as a 500. The SQL-side reasoning (TOCTOU,
  constraint design) is in `supabase-postgres-best-practices`.

**Zod at the edge**: length-cap every string that lands in a `tsvector` / GIN
column (`z.string().max(N)`), and strip client-only fields (encryption
passwords, raw keys) from server-side schemas even if you never persist them.

## Reaching a project's database (access hierarchy)

Read this BEFORE running `supabase link` or asking for a DB password. The most
common failure is burning turns on `supabase link` + "paste me the pooler
string" when `SUPABASE_ACCESS_TOKEN` alone already runs arbitrary SQL.

Tiers, cheapest first - stop at the first that covers the task:

1. **`SUPABASE_ACCESS_TOKEN` set -> Management API.** No DB password, no
   link, no pooler string; covers every project in the account. Default for
   ad-hoc SQL, inspection, one-off DDL/DML.
   - List projects + refs: `supabase projects list`.
   - Run any SQL (as `postgres`):
     ```bash
     REF=<project-ref>
     q(){ curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
       -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
       -H "Content-Type: application/json" \
       -d "$(jq -cn --arg q "$1" '{query:$q}')"; }
     q "select version();"
     ```
   - Read-only variant (as `supabase_read_only_user`, schema-qualify
     everything): `POST /v1/projects/$REF/database/query/read-only`.
   - Multi-statement strings work in one call. Same endpoint backs MCP
     `execute_sql` and (when linked) `supabase db query`.
2. **`supabase` CLI subcommands** (`db`, `inspect`, `snippets`, `storage`,
   `projects`, `config`) - token-only for most operations.
3. **DB password / pooler string (`psql`) - only when tier 1 cannot.** The
   HTTP endpoint is single-request and cannot hold a session; you need a real
   connection for `psql` meta-commands (`\copy`, `\d`), client-streamed
   `COPY ... FROM STDIN`, `pg_dump`/`pg_restore`, `LISTEN`/`NOTIFY`, very
   large result streaming. Get the string from Dashboard -> Connect (pooler
   table below). Only then ask for the password.

Check the token's presence without printing it:
`[ -n "${SUPABASE_ACCESS_TOKEN+x}" ] && echo set || echo unset`.

## CLI

Discover commands via `--help` - never guess flags, and do not gate on
remembered version numbers; `supabase --version` plus `<cmd> --help` is the
check.

```bash
supabase --help
supabase <group> --help
supabase <group> <command> --help
```

- `supabase db query` and `supabase db advisors` fall back to MCP
  `execute_sql` / `get_advisors` (or `psql`) when the installed CLI lacks them.
- Create migrations with `supabase migration new <name>`. Never invent
  filenames.

## Docs Access

Docs tool: in pi `docs_search` / `docs_read` / `docs_grep`; in Claude Code the
erfi-toolkit `docs` tool (action=search|read|grep). Paths below are docs-mirror
paths. Priority:

1. Search the `supabase` topic first; `docs_grep` / action=grep for exact
   strings.
2. `/docs/supabase-server/README.md` - `@supabase/server` API surface
3. `/docs/supabase-server/docs/environment-variables.md` - plural env-var map
4. `/docs/supabase-server/MIGRATION.md` - migrating Edge Functions to
   `@supabase/server`
5. `/docs/supabase-api/api/overview.md` - Management API endpoints
6. `/docs/supabase-auth-api/api/overview.md` - Auth API endpoints
7. Web search when the mirror does not cover it.

## MCP Server (optional, per-project)

Disabled by default. Enable per project when you need action tools
(`execute_sql`, `get_advisors`, project management). Setup:
https://supabase.com/docs/guides/getting-started/mcp

Troubleshooting: `curl -so /dev/null -w "%{http_code}" https://mcp.supabase.com/mcp`
(`401` = up); check `.mcp.json` has URL `https://mcp.supabase.com/mcp`;
reachable + configured but no tools = the user still has to complete the OAuth
flow in the browser and reload the session.

## Schema Changes

Iterate with the Management API `database/query` (token-only), MCP
`execute_sql`, or `supabase db query`: run SQL directly with no migration
history entries, then generate one clean migration.

Do NOT use `apply_migration` for iteration - it writes migration history on
every call and `supabase db diff` / `db pull` then produce empty or
conflicting diffs.

Commit workflow:

1. Advisors: `supabase db advisors` or MCP `get_advisors`. Fix issues.
2. Security checklist if views/functions/triggers/storage changed.
3. `supabase db pull <descriptive-name> --local --yes`
4. `supabase migration list --local`

## Configuration IaC

Project config belongs in `supabase/config.toml` (auth, SMTP, OAuth
providers, email templates via `content_path`, rate limits); secrets via
`env(VAR)` from `.env`; apply with `supabase config push`.

- The Management API (`PATCH /v1/projects/{ref}/config/auth`) is the only way
  to read live state - there is no `config pull`. Git is the source of truth.
- No `config rollback`: revert the toml commit in git, then `config push`.
- **Email rate limit**: raise `email_sent` from the default 2/hr once custom
  SMTP is wired; the default is behind most "email rate limit exceeded"
  reports.

pg_cron cleanup jobs (batched DELETE) are SQL-side: `supabase-postgres-best-practices`.

## Connection pooling (Workers / Edge Functions)

Docs mirror `/docs/supabase/guides/database/connecting-to-postgres.md`. Copy
the exact host from Dashboard -> Connect; the shared-pooler host carries a
numeric segment before the region.

| Path | Host:port | Mode | Use |
|---|---|---|---|
| Direct | `db.<ref>.supabase.co:5432` | session, no pooler | Migrations, `pg_dump`, long-lived backends, `SET`/`LISTEN`. IPv6 unless the IPv4 add-on. NEVER from Workers/Edge Functions. |
| Shared pooler (Supavisor), session | `aws-<n>-<region>.pooler.supabase.com:5432` | session | Persistent backend on an IPv4-only network. |
| Shared pooler (Supavisor), transaction | `aws-<n>-<region>.pooler.supabase.com:6543` | transaction | Serverless / Edge Functions / Workers on IPv4. |
| Dedicated pooler (PgBouncer) | `db.<ref>.supabase.co:6543` | transaction only | Paid plans, co-located with Postgres; preferred for serverless when IPv6 or the IPv4 add-on is available. |

Workers spin up and tear down per request; direct connections exhaust
`max_connections` in minutes under load. Both poolers share one pool-size
setting.

**Prepared statements under transaction pooling**: `pg` (node-postgres)
prepared statements bind to a backend connection the pool will not hand back.
Either disable them, use the `postgres` driver (postgres.js), which
negotiates prepared statements correctly under Supavisor, or use PostgREST
(`supabase.from(...)`) where pooling is not your problem. `@supabase/server`
wires the right config for you.

## Product references (read when the task touches them)

- `reference/realtime.md` - channel modes, Realtime auth, the CSP `wss://`
  gotcha and dead-trigger trap.
- `reference/storage.md` - BFF upload, `storage.objects` policies, signed
  URLs, render-path behaviour.
- `reference/pgvector.md` - embeddings table, HNSW vs IVFFlat, RPC query.
- `reference/pgmq-webhooks.md` - queues behind RLS, `pg_net` webhooks and
  their delivery caveat.
- `reference/branching.md` - branch commands, cost, detaching from a git
  branch.
- `reference/auth-flows.md` - sign-in snippets, PKCE callback, email
  template and enumeration rules.
- `reference/server-package.md` - `@supabase/server` adapters, primitives,
  config, migration map.

## Related skills

- `supabase-postgres-best-practices` - SQL, indexes, RLS predicates, locking,
  pooler config on any Postgres.
- `pg-analyser` - performance report for a project or any Postgres.
- `sbshift` - logical-replication migration and upgrade rehearsal.
