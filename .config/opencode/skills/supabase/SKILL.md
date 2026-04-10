---
name: supabase
description: "Use when doing ANY task involving Supabase. Triggers: Supabase products (Database, Auth, Edge Functions, Realtime, Storage, Vectors, Cron, Queues); client libraries and SSR integrations (supabase-js, @supabase/ssr) in Next.js, React, SvelteKit, Astro, Remix; auth issues (login, logout, sessions, JWT, cookies, getSession, getUser, getClaims, RLS); Supabase CLI or MCP server; schema changes, migrations, security audits, Postgres extensions (pg_graphql, pg_cron, pg_vector)."
metadata:
  author: supabase
  version: "0.1.0"
---

# Supabase

## Core Principles

1. **Verify against current docs first.** Training data stale. Fn signatures, config.toml, API conventions change between versions. Look up before implementing.

2. **Verify work.** Run test query after every fix. Unverified fix = incomplete.

3. **Recover, don't loop.** If approach fails 2-3 attempts, stop. Try different method, check docs, inspect error, review logs.

4. **RLS by default.** Enable RLS on every table in exposed schemas (especially `public`) — reachable through Data API. Private schemas: RLS as defense-in-depth. Create policies matching actual access model, not blanket `auth.uid()`.

5. **Security checklist** — run through when touching auth/RLS/views/storage/user data:

- **Auth/session security**
   - Never use `user_metadata` (`raw_user_meta_data`) for authorization — user-editable, unsafe in RLS/`auth.jwt()`. Use `raw_app_meta_data`/`app_metadata`.
   - Deleting user doesn't invalidate tokens. Sign out/revoke first, keep JWT expiry short, validate `session_id` against `auth.sessions` for strict guarantees.
   - `app_metadata`/`auth.jwt()` claims not fresh until token refresh.

- **API key exposure**
   - Never expose `service_role`/secret key in public clients. Use publishable keys for frontend. `NEXT_PUBLIC_` env vars sent to browser.

- **RLS/views/privileged code**
   - Views bypass RLS by default. Postgres 15+: `CREATE VIEW ... WITH (security_invoker = true)`. Older: revoke access from `anon`/`authenticated` roles or use unexposed schema.
   - UPDATE needs SELECT policy. Without it, updates silently return 0 rows.
   - No `security definer` fns in exposed schemas.

- **Storage**
   - Upsert needs INSERT + SELECT + UPDATE. INSERT alone = replacement silently fails.

More: `https://supabase.com/docs/guides/security/product-security.md`

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

## MCP Server

Setup: [MCP setup guide](https://supabase.com/docs/guides/getting-started/mcp).

**Troubleshooting connection:**

1. Check reachability: `curl -so /dev/null -w "%{http_code}" https://mcp.supabase.com/mcp` — `401` = up, timeout = down.
2. Check `.mcp.json` in project root. Missing? Create with URL `https://mcp.supabase.com/mcp`.
3. Server reachable + config correct but no tools? User needs OAuth auth flow in agent → browser → reload session.

## Docs Access

Before implementing, find relevant docs. Priority:

1. MCP `search_docs` tool (preferred — returns snippets directly)
2. Fetch docs as markdown — append `.md` to URL path
3. Web search for Supabase topics

## Schema Changes

**Use `execute_sql` (MCP) or `supabase db query` (CLI) for schema changes.** Run SQL directly, no migration history entries. Iterate freely, generate clean migration when ready.

Do NOT use `apply_migration` for local schema changes — writes migration history entry every call. Can't iterate. `supabase db diff`/`supabase db pull` produce empty/conflicting diffs.

**Commit workflow:**

1. Run advisors → `supabase db advisors` (CLI v2.81.3+) or MCP `get_advisors`. Fix issues.
2. Review Security Checklist if changes involve views/fns/triggers/storage.
3. Generate migration → `supabase db pull <descriptive-name> --local --yes`
4. Verify → `supabase migration list --local`
