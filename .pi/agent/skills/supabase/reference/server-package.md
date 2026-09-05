# @supabase/server: adapters, primitives, config

Read when generating `@supabase/server` code beyond the `withSupabase`
quickstart in SKILL.md, or migrating from v0. Check
`npm view @supabase/server version` before citing a version; the docs mirror
`/docs/supabase-server/` mirrors `github.com/supabase/server`.

## Framework adapters

Community-maintained, shipped inside the core package (no separate install):

| Framework | Import | Access pattern |
|---|---|---|
| Hono | `@supabase/server/adapters/hono` | `c.var.supabaseContext` |
| H3 / Nuxt | `@supabase/server/adapters/h3` | `event.context.supabaseContext` |
| Elysia | `@supabase/server/adapters/elysia` | `supabaseContext` in handler ctx (scoped resolve) |
| NestJS | `@supabase/server/adapters/nestjs` | `withSupabase` guard + `SupabaseCtx` param decorator |

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

**No adapter handles CORS** - the `cors` config option is excluded from every
adapter's config type. Use the framework's own CORS middleware (`hono/cors`,
`@elysiajs/cors`, NestJS `enableCors`, ...). Adapter auth failures throw the
framework's native exception (`HTTPException` in Hono, `HttpException` in
NestJS) with the original `AuthError` on `.cause`.

**Typed clients**: thread the generated `Database` type through the generic -
`withSupabase<Database>({ auth: 'user' })` - and `ctx.supabase` /
`c.var.supabaseContext.supabase` become `SupabaseClient<Database>`
(`/docs/supabase-server/docs/typescript-generics.md`).

## Primitives (`@supabase/server/core`)

For one handler with multiple routes and different auth modes, custom response
headers, or when building an MCP/middleware/adapter:

```ts
import {
	verifyAuth,           // (req, opts) -> { data: { token, ... } | error }
	verifyCredentials,    // low-level: raw credentials instead of Request (SSR adapter use)
	extractCredentials,   // pulls Authorization / apikey from a Request
	createContextClient,  // (token?) -> RLS-scoped client (user-token or anon)
	createAdminClient,    // -> service-role client
	createSupabaseContext,// (req, opts) -> full ctx in one call (verifyAuth + clients)
	resolveEnv,           // (overrides?) -> resolved env or error
} from '@supabase/server/core';
```

## Config

```ts
withSupabase(
	{
		auth: 'user',       // who can call this function
		cors: 'disabled',   // 'default' | 'disabled' | { headers }
		env: { url: '...' },// env overrides (optional)
	},
	handler,
);
```

`cors` accepts `'default'` (standard supabase-js CORS headers), `'disabled'`,
or `{ headers }` for custom headers. The boolean and bare
`Record<string, string>` forms are deprecated but still accepted. `env`
overrides per-request env-var resolution (tests, per-tenant routing).

## Docs (docs mirror paths)

- `/docs/supabase-server/README.md` - API surface
- `/docs/supabase-server/MIGRATION.md` - v0 to v1 rename map (`allow` -> `auth`,
  `'public'` -> `'publishable'`, `authType` -> `authMode`, `claims` -> `jwtClaims`)
- `/docs/supabase-server/docs/auth-modes.md` - array syntax, named keys, error cases
- `/docs/supabase-server/docs/environment-variables.md` - full env-var reference
- `/docs/supabase-server/docs/ssr-frameworks.md` - composing with `@supabase/ssr`

**Official skill**: `npx skills add supabase/server` installs Supabase's own
agent skill with fuller API context; use it alongside this one when generating
real `@supabase/server` code.
