## Documentation

Docs server at `docs.erfi.io` — 62 sources (docs + API specs), searchable markdown over SSH. Check docs before implementing/debugging.

**Always use custom `docs_search`, `docs_read`, `docs_grep`, `docs_find`, `docs_summary`, `docs_sources` tools.** No raw `ssh` or `Bash` for docs access.

### Sources

age, ansible, astro, authentik, aws, bun, caddy, cloudflare, cloudflare-blog, cloudflare-changelog, d2, docker, drizzle, erfi-personal-blog, erfi-technical-blog, flyio, gitea, hono, k3s, keycloak, kubernetes, mcp, mdn, mermaid, neovim, nextjs, ohmyzsh, opencode, openid, postgres, powerlevel10k, python, react, rust-book, saml, shadcn, sops, starlight, supabase, supabase-blog, tailwindcss, terraform, tmux, traefik, typescript, vercel, vercel-blog, vercel-changelog, wezterm, zinit, zod, zsh

### API Reference Sources

OpenAPI specs converted to per-endpoint-group markdown. Each has `api/overview.md` (endpoint index) + `api/{tag}.md` files.

authentik-api, aws-api, cloudflare-api, docker-api, flyio-api, gitea-api, keycloak-api, kubernetes-api, supabase-api, supabase-auth-api

**API lookup pattern:**
1. `docs_search(query="create zone", source="cloudflare-api")` — find endpoint group
2. `docs_grep(query="POST /zones", path="/docs/cloudflare-api/")` — find exact endpoint
3. `docs_read(path="/docs/cloudflare-api/api/zones.md")` — read full endpoint group

### Workflow: search -> summary -> targeted read

1. **Search** index for relevant files:
   `docs_search(query="RLS policies", source="postgres")`

2. **Outline** promising file:
   `docs_summary(path="/docs/postgres/row-security.md")`

3. **Read only needed section** (e.g. lines 45-80):
   `docs_read(path="/docs/postgres/row-security.md", offset=45, lines=35)`

### Tools

| Tool | Purpose | When |
|------|---------|------|
| `docs_search` | Search titles+summaries | First step — find files fast (index ~15x smaller than raw docs) |
| `docs_summary` | Headings/outline of file | Before reading — find right section |
| `docs_read` | Read file or line range | After summary — read only what needed |
| `docs_grep` | Regex search + context lines | Find content within files |
| `docs_find` | Find files by name pattern | Know part of filename |
| `docs_sources` | List sources + file counts | Check what available |

### Token tips

- `docs_search` searches index (~15x smaller than raw docs)
- `docs_summary` before `docs_read` — find right line range first
- `offset+lines`: 35 lines = ~140 tokens vs ~2K for full file
- `docs_grep` with source path: `docs_grep(query="RLS", path="/docs/postgres/")` faster than searching all
- `source` param: `docs_search(query="auth", source="supabase")` filters to one source
- API specs: `docs_read(path="/docs/{source}-api/api/overview.md")` for endpoint index

### Related source groups

When searching one source, check related sources for cross-referencing:

- **Auth & identity**: supabase, keycloak, authentik, openid, saml
- **Databases**: postgres, supabase, drizzle
- **Infrastructure**: docker, kubernetes, k3s, terraform, ansible, flyio
- **Reverse proxy & networking**: cloudflare, caddy, traefik
- **Frontend frameworks**: nextjs, react, astro, hono, tailwindcss, shadcn
- **Languages & runtimes**: typescript, python, rust-book, bun, zod
- **Cloud platforms**: aws, cloudflare, vercel, flyio
- **Secrets & encryption**: age, sops
- **Terminal & editor**: neovim, tmux, wezterm, zsh, ohmyzsh
- **Docs & diagrams**: mdn, d2, mermaid, starlight, mcp
