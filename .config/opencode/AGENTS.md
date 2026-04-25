## Documentation

Docs server at `docs.erfi.io` — 139 sources (docs + API specs), searchable markdown over SSH. Check docs before implementing/debugging.

**Always use custom `docs_search`, `docs_read`, `docs_grep`, `docs_find`, `docs_summary`, `docs_sources` tools.** No raw `ssh` or `Bash` for docs access.

### Sources

age, ansible, argocd, astro, authentik, aws, bitwarden, bun, caddy, citus, cloudflare, cloudflare-blog, cloudflare-changelog, cockroachdb, curl, cypress, d2, deno, docker, drizzle, effect, electric, erfi-personal-blog, erfi-technical-blog, eslint, excalidraw, expo, fastapi, flutter, flyio, gitea, github, gitlab, go, grafana, graphql, graphql-spec, helm, hono, htmx, httpie, index-advisor, jest, k3s, keycloak, kubernetes, letsencrypt, mcp, mdn, mermaid, mise, modern-sql, multigres, multigres-dev, neon, neovim, nextjs, nix, ohmyzsh, opencode, openid, opentelemetry, paradedb, patroni, pg-cron, pg-graphql, pg-net, pgbouncer, pglocks, pgpool, pgrx, pgvector, playwright, pnpm, postgis, postgres, postgres-wiki, powerlevel10k, prettier, prisma, prometheus, python, rclone, react, react-native, redis, resend, ripgrep, rspack, rust-book, saml, shadcn, sops, sqlite, sqlstyle, sst, starlight, supabase, supabase-blog, supabase-grafana, supavisor, svelte, tailwindcss, tanstack-form, tanstack-query, tanstack-router, tanstack-table, tauri, terraform, timescaledb, tmux, traefik, turborepo, typescript, use-the-index-luke, valkey, vaultwarden, vercel, vercel-blog, vercel-changelog, vite, vitest, wails, wezterm, wireguard, yugabytedb, zinit, zod, zsh

### API Reference Sources

OpenAPI specs converted to per-endpoint-group markdown. Each has `api/overview.md` (endpoint index) + `api/{tag}.md` files.

authentik-api, aws-api, cloudflare-api, docker-api, flyio-api, gitea-api, keycloak-api, kubernetes-api, supabase-api, supabase-auth-api

**API lookup pattern:**
1. `docs_search(query="dns record", source="cloudflare-api")` — find endpoint group
2. `docs_grep(query="POST.*dns_records", path="/docs/cloudflare-api/")` — find exact endpoint
3. `docs_read(path="/docs/cloudflare-api/api/dns-records-for-a-zone.md")` — read full endpoint group

### Workflow: search -> summary -> targeted read

1. **Search** index for relevant files:
   `docs_search(query="row security", source="postgres")`

2. **Outline** promising file:
   `docs_summary(path="/docs/postgres/ddl-rowsecurity.md")`

3. **Read only needed section** (e.g. lines 27-61):
   `docs_read(path="/docs/postgres/ddl-rowsecurity.md", offset=27, lines=35)`

### Tools

| Tool | Purpose | When |
|------|---------|------|
| `docs_search` | Search titles+summaries | First step — find files fast (index ~15x smaller than raw docs) |
| `docs_summary` | Headings/outline of file | Before reading — find right section |
| `docs_read` | Read file or line range | After summary — read only what needed |
| `docs_grep` | Regex search + context lines | Find content within files |
| `docs_find` | Find files by name pattern | Know part of filename |
| `docs_sources` | List sources + file counts | Check what available |

### Reading the output

Tool output uses stable markers the agent should recognise:

- `[file] N lines, M bytes` — prefix on full `docs_read` results. Use this to decide whether to re-read with `offset`/`lines` next time.
- `**matched text**` — `docs_grep` wraps matched substrings in bold so match positions are visible without re-scanning.
- `(showing X of Y)` — truncation notice in `docs_search` / `docs_grep`. Narrow the query or raise `maxResults`.
- `[truncated N chars — use docs_read with offset/lines or docs_summary ...]` — output hit the 51K char cap. Follow the hint.
- `[error] command timed out ...` — server killed the command at 60s. Narrow path/regex; don't retry the same query.
- `[error] SSH connection failed: ...` — network issue. Retry after a short delay.
- `[no results for "..."]` — search found nothing after index + filename + content fallback. Try a different term or `docs_grep` across `/docs/`.

### Token tips

- `docs_search` searches index (~15x smaller than raw docs)
- `docs_summary` before `docs_read` — find right line range first
- `offset+lines`: 35 lines = ~140 tokens vs ~2K for full file
- `docs_read` with only `offset`: reads from that line to EOF (bat open range)
- `docs_grep` with source path: `docs_grep(query="RLS", path="/docs/postgres/")` faster than searching all
- `source` param: `docs_search(query="auth", source="supabase")` filters to one source
- API specs: `docs_read(path="/docs/{source}-api/api/overview.md")` for endpoint index

### Related source groups

When searching one source, check related sources for cross-referencing:

- **API specs**: aws-api, cloudflare-api, docker-api, kubernetes-api, supabase-api, supabase-auth-api, flyio-api, gitea-api, authentik-api, keycloak-api
- **APIs & specs**: openid, saml, graphql, graphql-spec, mcp
- **Auth & identity**: supabase, keycloak, authentik, openid, saml, bitwarden, vaultwarden
- **Blogs & changelogs**: supabase-blog, cloudflare-blog, cloudflare-changelog, vercel-blog, vercel-changelog, erfi-technical-blog, erfi-personal-blog
- **Build tools**: vite, vitest, turborepo, rspack, eslint, prettier, pnpm, opencode
- **CLI tools**: curl, ripgrep, httpie, rclone
- **Cloud platforms**: supabase, neon, flyio, sst, cloudflare, aws, vercel
- **Databases & SQL**: supabase, postgres, postgres-wiki, drizzle, prisma, sqlite, redis, valkey, modern-sql, use-the-index-luke, sqlstyle, pglocks
- **Docs & diagrams**: mcp, mdn, d2, mermaid, starlight, excalidraw
- **Email & services**: resend, letsencrypt
- **Frontend frameworks**: nextjs, react, astro, hono, tailwindcss, shadcn, svelte, htmx, tanstack-query, tanstack-router, tanstack-table, tanstack-form, effect, fastapi
- **Git forges**: github, gitlab, gitea
- **Infrastructure**: docker, kubernetes, k3s, terraform, ansible, flyio, helm, argocd, sst
- **Languages & runtimes**: effect, typescript, python, rust-book, bun, deno, go, zod, nix, fastapi
- **Mobile & desktop**: react-native, flutter, expo, tauri, wails
- **Monitoring & observability**: supabase-grafana, prometheus, opentelemetry, grafana
- **Reverse proxy & networking**: cloudflare, caddy, traefik, wireguard
- **Postgres-compatible**: neon, cockroachdb, yugabytedb, paradedb, timescaledb, electric
- **Postgres ecosystem**: postgres-wiki, pgvector, postgis, pgbouncer, pg-cron, pgrx, citus, pg-graphql, pg-net, index-advisor, supavisor, supabase-grafana, multigres, multigres-dev
- **Postgres HA & ops**: patroni, pgpool
- **Secrets & encryption**: bitwarden, vaultwarden, age, sops
- **Supabase ecosystem**: pg-graphql, pg-net, index-advisor, supavisor, supabase-grafana
- **Terminal & editor**: neovim, tmux, wezterm, zsh, ohmyzsh, zinit, powerlevel10k, mise
- **Testing**: vitest, jest, playwright, cypress
