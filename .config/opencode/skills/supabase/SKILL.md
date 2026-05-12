---
name: supabase
description: "Use when doing ANY task involving Supabase. Triggers: Supabase products (Database, Auth, Edge Functions, Realtime, Storage, Vectors, Cron, Queues); client libraries and SSR integrations (supabase-js, @supabase/server, @supabase/ssr) in Next.js, React, SvelteKit, Astro, Remix; auth issues (login, logout, sessions, JWT, cookies, getSession, getUser, getClaims, RLS); Supabase CLI or MCP server; schema changes, migrations, security audits, Postgres extensions (pg_graphql, pg_cron, pg_vector)."
metadata:
  author: supabase
  version: "0.4.0"
---

# Supabase

## Core Principles

1. **Verify against current docs first.** Training data stale. Fn signatures, config.toml, API conventions change between versions. Look up before implementing.

2. **Verify work.** Run test query after every fix. Unverified fix = incomplete.

3. **Verify against upstream source before claiming SDK violations.** When a function "must take parameter X", read `node_modules/@supabase/.../<file>.js` to confirm. The May 2026 pastebin audit had two findings that were wrong because they assumed SDK contracts that didn't match the actual implementation — five minutes of source-reading would have caught both.

4. **Recover, don't loop.** If approach fails 2-3 attempts, stop. Try different method, check docs, inspect error, review logs.

5. **RLS by default.** Enable RLS on every table in exposed schemas. Private schemas: RLS as defense-in-depth. Create policies matching actual access model, not blanket `auth.uid()`.

## Picking the right Supabase library

| Use case | Library |
|---|---|
| **Edge Function / Worker / Vercel Function / Hono / Bun** with **header-based** auth (Bearer JWT) | **`@supabase/server`** ← default since May 2026 |
| **Next.js / SvelteKit / Astro / Remix** with **cookie-based** auth | `@supabase/ssr` |
| **Browser client** (frontend, queries via PostgREST/Realtime) | `@supabase/supabase-js` |
| **Worker BFF with HttpOnly cookies** (browser → Worker → Supabase, browser never sees JWT) | Hand-rolled with `@supabase/supabase-js` + `getServiceRoleClient` cache. `@supabase/server` is header-only and doesn't replace this. |

If you're hand-rolling auth verification, JWT parsing, two clients (user-scoped + admin), CORS, env-var wiring, or `_shared/*.ts` files inside an Edge Function or Worker — **stop and use `@supabase/server`** instead.

## `@supabase/server` quickstart (default for backend code)

```ts
import { withSupabase } from 'npm:@supabase/server' // or '@supabase/server' on Workers/Bun

export default {
	fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
		const { supabase, supabaseAdmin, userClaims, jwtClaims, authMode, authKeyName } = ctx;
		// supabase       — RLS-scoped (user or anon depending on auth mode)
		// supabaseAdmin  — bypasses RLS (service role)
		// userClaims     — JWT-derived identity (id, email, role). null when not user-auth
		// jwtClaims      — full JWT claims. null when not user-auth
		// authMode       — 'user' | 'publishable' | 'secret' | 'none' (which mode matched)
		// authKeyName    — when an apikey was used, the name from the plural env map (omitted for 'user' / 'none')
		const { data } = await supabase.from('todos').select();
		return Response.json(data);
	}),
};
```

**Auth modes** (declarative, single line tells you the security model):

```ts
withSupabase({ auth: 'user' }, …)               // valid user JWT required (default)
withSupabase({ auth: 'none' }, …)               // unauthenticated OK (webhooks, health)
withSupabase({ auth: 'secret' }, …)             // server-to-server, validates secret key
withSupabase({ auth: 'publishable' }, …)        // validates publishable key — apikey header
withSupabase({ auth: 'publishable:web_app' }, …) // named-key variant (specific entry in plural env map)
withSupabase({ auth: 'secret:cron' }, …)        // named-key variant for secret keys
withSupabase({ auth: ['user', 'secret'] }, …)   // first match wins
```

**Array fall-through semantics**: "first match wins. An absent credential falls through to the next mode; a present-but-invalid JWT rejects the request (no silent downgrade)." Important security property — a tampered JWT won't slip past `'user'` and quietly succeed as `'secret'`.

**Publishable-key auth is anonymous, not admin.** `ctx.supabase` is the **anon-role** client (RLS still applies); `userClaims` and `jwtClaims` are `null`. Use it for client-key-gated public endpoints (catalog, marketing pages) where you want a "request came from a known client" check but still rely on RLS for what's visible. Different from `'secret'` where `ctx.supabaseAdmin` bypasses RLS.

**Header convention**: `'user'` reads the JWT from the `Authorization: Bearer` header. `'publishable'` / `'secret'` read the key from the `apikey` header. Both can be present; `withSupabase` picks the mode that matches.

**Hono adapter** (community-maintained, ships with the core package):

```ts
import { Hono } from 'hono';
import { withSupabase } from '@supabase/server/adapters/hono';

const app = new Hono();
app.use('*', withSupabase({ auth: 'user' }));
app.get('/todos', async (c) => {
	const { supabase } = c.var.supabaseContext;
	const { data } = await supabase.from('todos').select();
	return c.json(data);
});
export default { fetch: app.fetch };
```

**H3 / Nuxt adapter** also shipped: `@supabase/server/adapters/h3`.

**Primitives** from `@supabase/server/core` when one handler needs multiple routes with different auth modes, custom response headers, or you're building an MCP/middleware/adapter:

```ts
import {
	verifyAuth,           // (req, opts) → { data: { token, … } | error }
	verifyCredentials,    // low-level: raw credentials instead of Request (SSR adapter use)
	extractCredentials,   // pulls Authorization / apikey from a Request
	createContextClient,  // (token?) → RLS-scoped client (user-token or anon)
	createAdminClient,    // → service-role client
	createSupabaseContext,// (req, opts) → full ctx in one call (verifyAuth + clients)
	resolveEnv,           // (overrides?) → resolved env or error
} from '@supabase/server/core';
```

### Config

```ts
withSupabase(
	{
		auth: 'user',     // who can call this function
		cors: false,      // disable CORS (default: standard supabase-js CORS headers)
		env: { url: '…' },// env overrides (optional)
	},
	handler,
);
```

`cors` accepts `Record<string, string>` for custom headers, or `false` to disable (e.g. when a framework handles CORS separately). `env` overrides per-request env-var resolution (useful for tests and per-tenant routing).

### Env-vars (read by `@supabase/server`)

Plural map form (Supabase Edge Functions auto-injects these):

| Variable | Format | Description |
|---|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Project URL |
| `SUPABASE_PUBLISHABLE_KEYS` | **JSON map**: `{"default":"sb_publishable_…","web":"sb_publishable_…"}` | Named publishable keys |
| `SUPABASE_SECRET_KEYS` | **JSON map**: `{"default":"sb_secret_…","cron":"sb_secret_…"}` | Named secret keys |
| `SUPABASE_JWKS` | `{"keys":[…]}` or `[…]` | Inline JWKS for local JWT verification |

Singular fallback form (local dev, self-hosted):

| Variable | Format |
|---|---|
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` |
| `SUPABASE_JWKS_URL` | `https://…` (remote JWKS endpoint; used when `SUPABASE_JWKS` unset) |

**Plural takes priority** when both are set. Old singular names (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) are **not** read — rename or wire via the `env` config option.

### Runtime notes

- **Supabase Edge Functions** — env-vars auto-injected, zero config. **But** if you use `auth: 'publishable' | 'secret' | 'none'`, you MUST disable the platform-level JWT check in `supabase/config.toml`:
  ```toml
  [functions.my-function]
  verify_jwt = false
  ```
  Otherwise the Edge Functions platform rejects the request before `@supabase/server` sees it.
- **Cloudflare Workers** — enable `nodejs_compat` in `wrangler.toml`/`wrangler.jsonc` or pass env overrides via the `env` config option.
- **Deno / Bun / Node** — works out of the box with `export default { fetch }`.

### What it gives you for free

- **Local JWT verification via JWKS.** No `auth.getUser(token)` network round-trip per request. Asymmetric JWT Signing Keys + JWKS endpoint resolved internally.
- **Two pre-wired clients** in `ctx`: user-scoped (RLS respected) and admin (service role). No `createClient` boilerplate.
- **CORS** handled before your handler runs (configurable per the table above).
- **Named-key validation** — rotate the `cron` key without touching the `web_app` key.

### Status

**v1.0.0 stable** since May 6, 2026 — first SemVer release. Breaking changes only ship as major bumps. Adapters and ergonomic improvements ship in minor releases.

Docs:
- `docs_read(path="/docs/supabase-server/README.md")` — API surface
- `docs_read(path="/docs/supabase-server/MIGRATION.md")` — **v0 → v1 rename map** (`allow` → `auth`, `'public'` → `'publishable'`, `authType` → `authMode`, `claims` → `jwtClaims`)
- `docs_read(path="/docs/supabase-server/docs/auth-modes.md")` — array syntax, named keys, error cases
- `docs_read(path="/docs/supabase-server/docs/environment-variables.md")` — full env-var reference
- `docs_read(path="/docs/supabase-server/docs/ssr-frameworks.md")` — composing with `@supabase/ssr` for Next.js / SvelteKit / Remix

**Official skill**: Supabase ships a dedicated AI coding skill — `npx skills add supabase/server` — that an agent can install for fuller API context. Use it instead of (or in addition to) this skill's section when generating actual `@supabase/server` code.

### When NOT to use `@supabase/server` alone

- **Cookie-based session management** (browser-direct flows in Next.js, SvelteKit, Remix) — use `@supabase/ssr` as the cookie+refresh-rotation layer and **compose** with `@supabase/server` on top for verified claims + typed RLS/admin clients. See `docs/ssr-frameworks.md`. They're not replacements; they coexist.
- **Worker-BFF flows** where the browser sends an HttpOnly cookie that the Worker translates into a server-side Supabase JWT before forwarding — the cookie management isn't `@supabase/server`'s problem, but you can still use `@supabase/server`'s primitives (`createContextClient(jwt)`, `verifyCredentials`) once you've extracted the JWT.
- **PKCE OAuth bridges** with a custom `storage` shim. Hand-rolled `createClient` is still needed for the per-request storage shim.

The hand-rolled patterns below still apply to these cases.

## Security checklist (any flavour of integration)

- **Auth/session security**
  - Never use `user_metadata` (`raw_user_meta_data`) for authorization — user-editable. Use `raw_app_meta_data`/`app_metadata`.
  - Deleting user doesn't invalidate tokens. Sign out/revoke first, keep JWT expiry short, validate `session_id` against `auth.sessions` for strict guarantees.
  - `app_metadata`/`auth.jwt()` claims not fresh until token refresh.
  - **`admin.signOut(jwt, scope)` takes a JWT, not a user UUID.** Internally posts `/logout?scope=…` with the JWT as bearer. Pass `'global'` to revoke every refresh token. Confirmed in `auth-js/dist/main/GoTrueAdminApi.js`.
  - **`{{ .EmailActionType }}` does NOT work in most email templates** (confirmation, recovery, magic_link, invite, email_change) — renders empty. **Hardcode `type=` per template** (`type=signup`, `type=recovery`, etc.) using the `token_hash` flow, then `auth.verifyOtp({ token_hash, type })` server-side.
  - **Anti-enumeration on signup**: Supabase returns success-shaped response with `user.identities = []` when email already exists. Detect and convert to HTTP 409 `email_taken` when threat model allows (public signup OK; medical/financial not).
  - **Login error distinction**: `email_not_confirmed` (HTTP 403) only returned on correct password — anti-enumeration preserved for wrong-password guesses. Distinguish from `invalid_credentials` (HTTP 401) in your UI.

- **API key exposure**
  - Never expose `service_role`/secret key in public clients. Use publishable keys for frontend. `NEXT_PUBLIC_` env vars sent to browser.
  - **Never log secrets via query strings.** Cloudflare logpush captures every log line. Reject sensitive query keys at the endpoint AND redact a known allowlist (`token`, `token_hash`, `code`, `access_token`, `refresh_token`) in the request logger. Body-only for secrets.
  - **Open redirect defence**: never validate `next=` with `startsWith('/') && !startsWith('//')`. The WHATWG URL parser maps `\` to `/` for special schemes — `/\evil.com` becomes `https://evil.com/`. Use `new URL(next, request.url)` and assert `candidate.origin === request.origin`.

- **RLS/views/privileged code**
  - Views bypass RLS by default. Postgres 15+: `CREATE VIEW ... WITH (security_invoker = true)`. Older: revoke from `anon`/`authenticated` or use unexposed schema.
  - UPDATE needs SELECT policy. Without it, updates silently return 0 rows.
  - No `security definer` fns in exposed schemas.
  - **`(SELECT auth.uid())` not bare `auth.uid()`** in policy predicates. The subquery emits `initPlan` so the value is computed once per statement instead of once per row. 94–99% latency improvement at scale per Supabase benchmarks.

- **Storage**
  - Upsert needs INSERT + SELECT + UPDATE. INSERT alone = replacement silently fails.

More: `https://supabase.com/docs/guides/security/product-security.md`

## Hand-rolled patterns (when `@supabase/server` doesn't fit)

Skip this section if you're using `@supabase/server`. Below covers Worker BFF with HttpOnly cookies, PKCE OAuth bridges, and other custom flows.

### Server-side `createClient()` config

Always pass these auth flags outside a browser:

```ts
createClient(url, key, {
	auth: {
		autoRefreshToken: false,   // no setTimeout in a Worker
		persistSession: false,     // no localStorage in a Worker
		detectSessionInUrl: false, // no window.location to parse
	},
});
```

With these flags the client is stateless. Memoise by `(url, key)` for many-requests-per-isolate runtimes:

```ts
const cache = new Map<string, SupabaseClient>();
export function getServiceRoleClient(url: string, key: string) {
	const k = `${url}::${key}`;
	return cache.get(k) ?? cache.set(k, createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } })).get(k)!;
}
```

`createClient()` is non-trivial per-request cost. Caching turns 3 calls/request into 1 per isolate.

**Per-request handler classes are safe.** Constructing a `class AuthHandlers` that owns the cached client on every request does NOT race across concurrent fetches in the same isolate — `this.client` is its own field on its own object. The "concurrent setSession race" trap only fires if you store the client at module scope AND call `setSession` (which mutates).

**Do NOT cache PKCE-flow clients.** `signInWithOAuth` and `exchangeCodeForSession` need a custom `storage` shim (per-request capture/seed) that is not safe to share.

### Worker BFF cookie pattern

Browser → Worker → Supabase. Browser never sees JWT.

- Auth flows: Worker sets `HttpOnly; Secure; SameSite=Strict` `sb-access-token` (1h) + `sb-refresh-token` (7d) cookies on success.
- Session reads: `GET /api/auth/session` reads cookie, calls `auth.getUser(token)`, refreshes via `auth.refreshSession({ refresh_token })` when expired. Rate-limit this endpoint — it's a stolen-JWT validity oracle otherwise.
- Single Worker endpoint owns all refresh — no multi-tab race possible.
- PKCE OAuth: inject capture-only `storage` shim during `signInWithOAuth` to extract the `code_verifier`. Stash in a `sb-pkce-verifier` HttpOnly cookie. **MUST be `SameSite=Lax` not `Strict`** — the OAuth redirect is a cross-site top-level navigation; `Strict` drops the cookie.
- Logout: `auth.admin.signOut(accessToken, 'global')` revokes every refresh token; cookie-clear is in addition.

### CF Workers Rate Limiting binding

```jsonc
"ratelimits": [
	{ "name": "RL_AUTH_WRITE", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }
]
```

```ts
const { success } = await env.RL_AUTH_WRITE.limit({ key: clientIp });
if (!success) return c.json({ error: { code: 'rate_limited' }}, 429, { 'Retry-After': '60' });
```

- `period` MUST be 10 or 60 (Cloudflare-enforced).
- `namespace_id` unique within account; different per env (e.g. 1001-1004 dev, 2001-2004 prod).
- Key on `CF-Connecting-IP` → first `X-Forwarded-For` token → `'unknown'`. Scope per endpoint.
- **Fail open** on binding error (log warn, pass request) — never block real traffic on infra issues. **No-op** when binding undefined (vitest, local astro dev) so tests don't need a stub.

In-memory per-isolate maps don't coordinate across the 200+ CF colos. Always use the binding.

## PostgREST error handling

- **`PGRST116`** ("Cannot coerce the result to a single JSON object") on `.single()` = zero rows. **Not** an error. Short-circuit:
  ```ts
  if (error?.code === 'PGRST116') return null;
  ```
- **RLS-blocked DELETE** returns `{ error: null, count: 0 }` — indistinguishable from "no row with that id" unless you check the count:
  ```ts
  const { count, error } = await client.from('x').delete({ count: 'exact' }).eq('id', id);
  return !error && (count ?? 0) > 0;
  ```
- **Unique-violation TOCTOU**: pre-check then insert is a race. Catch Postgres error code `23505` and translate to HTTP 409 in your app layer; don't let the raw Postgres message propagate as 500.

## Zod schema defence

- **Length-cap every string** that flows into a `tsvector` / GIN-indexed column. `language: z.string().max(50)`, `title: z.string().max(100)`. Unbounded strings bloat indexes and waste storage.
- **Strip server-side fields that should be client-only.** Encryption passwords, raw decryption keys, etc. should never appear in the server-side schema — even if you don't persist them, they transit through Worker memory and risk leakage via future logging middleware.

## CSP gotchas for Realtime / `wss://`

CSP `connect-src 'self'` **physically blocks** WebSocket to `wss://<ref>.supabase.co`. Before designing for browser-side Realtime, verify the frontend CSP allows it (`connect-src 'self' wss://<ref>.supabase.co`).

If CSP is locked to `'self'` (Worker BFF stack), **don't install Realtime triggers** — they'll burn message quota with no subscriber. Two ways to end up with dead infrastructure:

1. Trigger installed before frontend subscribes — every insert costs a quota message.
2. CSP locked before Realtime subscriber added — subscriber can never connect.

Verify the subscriber path works end-to-end before shipping the trigger.

## Browser-side encryption caveats

If you cache decryption keys client-side:

- **`sessionStorage` not `localStorage`** for the master key — tab-scoped, cleared on close.
- **None of this defends against XSS or storage-reading browser extensions.** Document this explicitly in SECURITY.md — co-locating an "encrypted" master key with the ciphertext in the same `localStorage` is theatrical security.

## CLI

Discover commands via `--help` — never guess.

```bash
supabase --help
supabase <group> --help
supabase <group> <command> --help
```

**Gotchas:**
- `supabase db query` needs CLI v2.79.0+ — fallback: MCP `execute_sql` or `psql`
- `supabase db advisors` needs CLI v2.81.3+ — fallback: MCP `get_advisors`
- Always create migrations with `supabase migration new <name>`. Never invent filenames.

Version check: `supabase --version`. Changelogs: [CLI docs](https://supabase.com/docs/reference/cli/introduction), [GitHub releases](https://github.com/supabase/cli/releases).

## Docs Access

Before implementing, find relevant docs. Priority:

1. `docs_search(query="...", source="supabase")` or `docs_grep` — docs-ssh has full Supabase docs
2. `docs_read(path="/docs/supabase-server/README.md")` — `@supabase/server` API surface (mirrors `github.com/supabase/server`)
3. `docs_read(path="/docs/supabase-server/docs/environment-variables.md")` — new plural env-var conventions
4. `docs_read(path="/docs/supabase-server/MIGRATION.md")` — migrating existing Edge Functions to `@supabase/server`
5. `docs_read(path="/docs/supabase-api/api/overview.md")` — Management API endpoints
6. `docs_read(path="/docs/supabase-auth-api/api/overview.md")` — Auth API endpoints
7. Web search for Supabase topics when docs-ssh doesn't cover it

## MCP Server (optional, per-project)

Supabase MCP disabled by default. Enable per-project when you need action tools (`execute_sql`, `get_advisors`, project management). Docs are already in docs-ssh.

Setup if needed: [MCP setup guide](https://supabase.com/docs/guides/getting-started/mcp).

**Troubleshooting connection:**

1. Check reachability: `curl -so /dev/null -w "%{http_code}" https://mcp.supabase.com/mcp` — `401` = up, timeout = down.
2. Check `.mcp.json` in project root. Missing? Create with URL `https://mcp.supabase.com/mcp`.
3. Server reachable + config correct but no tools? User needs OAuth auth flow in agent → browser → reload session.

## Schema Changes

**Use `execute_sql` (MCP) or `supabase db query` (CLI) for iterating on schema changes.** Run SQL directly, no migration history entries. Iterate freely, generate a clean migration when ready.

Do NOT use `apply_migration` for local iteration — writes migration history every call. Can't iterate. `supabase db diff`/`supabase db pull` produce empty/conflicting diffs.

**Commit workflow:**

1. Run advisors → `supabase db advisors` (CLI v2.81.3+) or MCP `get_advisors`. Fix issues.
2. Review security checklist if changes involve views/fns/triggers/storage.
3. Generate migration → `supabase db pull <descriptive-name> --local --yes`
4. Verify → `supabase migration list --local`

## Configuration IaC

Project-level Supabase config belongs in `supabase/config.toml` (auth, SMTP, OAuth providers, email templates referenced by `content_path`, rate limits). Secrets via `env(VAR)` substitution from `.env`. Apply with `supabase config push`.

- The Management API (`PATCH /v1/projects/{ref}/config/auth`) is the only way to **read** live state — there's no `config pull`. Git is your source of truth.
- Email templates: each `.html` file references the type-hardcoded URL pattern. Don't try to share a single template across types.
- Rollback: there is no `config rollback`. `git revert` the toml + `config push`.
- **Email rate limit**: bump `email_sent` from default 2/hr to 30/hr (or higher) once custom SMTP is wired. The default is the bottleneck behind most "email rate limit exceeded" reports.

## pg-cron expiry jobs

**Batched DELETE pattern** — unbounded `DELETE WHERE expires_at < now()` holds row locks across the entire matching set. A spike of 50k+ rows expiring in one window stalls live reads/writes on overlapping rows.

```sql
DELETE FROM public.things
WHERE id IN (
	SELECT id FROM public.things
	WHERE expires_at < now()
	LIMIT 1000
)
```

Batching at 1000 caps lock-hold time; pg-cron picks up the rest on the next cycle. Rows past `expires_at` are not user-visible (every read path should filter `expires_at > now()`) so spreading cleanup across cycles is invisible.
