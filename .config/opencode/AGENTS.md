## Documentation

Docs server at `docs.erfi.io` — 158 sources (docs + API specs), searchable markdown over SSH. Check docs before implementing/debugging.

**Always use custom `docs_search`, `docs_read`, `docs_grep`, `docs_find`, `docs_summary`, `docs_sources` tools.** No raw `ssh` or `Bash` for docs access.

### Sources

age, ansible, argocd, astro, authentik, aws-apigateway, aws-cloudformation, aws-cloudfront, aws-cognito, aws-dynamodb, aws-ec2, aws-ecs, aws-eks, aws-elb, aws-eventbridge, aws-iam, aws-lambda, aws-rds, aws-s3, aws-secretsmanager, aws-sns, aws-sqs, aws-step-functions, aws-systems-manager, aws-vpc, aws-waf, bitwarden, bun, caddy, citus, cloudflare, cloudflare-blog, cloudflare-changelog, cockroachdb, curl, cypress, d2, deno, docker, drizzle, effect, electric, erfi-personal-blog, erfi-technical-blog, eslint, excalidraw, expo, fastapi, flutter, flyio, gitea, github, gitlab, go, grafana, graphql, graphql-spec, helm, hono, htmx, httpie, index-advisor, jest, k3s, keycloak, kubernetes, letsencrypt, mcp, mdn, mermaid, mise, modern-sql, multigres, multigres-dev, neon, neovim, nextjs, nix, ohmyzsh, opencode, openid, opentelemetry, paradedb, patroni, pg-cron, pg-graphql, pg-net, pgbouncer, pgpool, pgrx, pgvector, playwright, pnpm, postgis, postgres, postgres-wiki, powerlevel10k, prettier, prisma, prometheus, python, rclone, react, react-native, redis, resend, ripgrep, rspack, rust-book, saml, shadcn, sops, sqlite, sqlstyle, sst, starlight, supabase, supabase-blog, supabase-grafana, supavisor, svelte, tailwindcss, tanstack-form, tanstack-query, tanstack-router, tanstack-table, tauri, terraform, timescaledb, tmux, traefik, turborepo, typescript, use-the-index-luke, valkey, vaultwarden, vercel, vercel-blog, vercel-changelog, vite, vitest, wails, wezterm, wireguard, yugabytedb, zinit, zod, zsh

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
- **Auth & identity**: supabase, keycloak, authentik, openid, saml, bitwarden, vaultwarden, aws-cognito
- **Blogs & changelogs**: supabase-blog, cloudflare-blog, cloudflare-changelog, vercel-blog, vercel-changelog, erfi-technical-blog, erfi-personal-blog
- **Build tools**: vite, vitest, turborepo, rspack, eslint, prettier, pnpm, opencode
- **CLI tools**: curl, ripgrep, httpie, rclone
- **Cloud platforms**: supabase, neon, flyio, sst, cloudflare, aws-lambda, aws-s3, aws-cloudfront, aws-iam, aws-dynamodb, aws-cloudformation, aws-vpc, aws-ec2, aws-rds, aws-sqs, aws-sns, aws-ecs, aws-eks, aws-secretsmanager, aws-systems-manager, aws-cognito, aws-apigateway, aws-eventbridge, aws-step-functions, aws-waf, aws-elb, vercel
- **Databases & SQL**: supabase, postgres, postgres-wiki, drizzle, prisma, sqlite, redis, valkey, modern-sql, use-the-index-luke, sqlstyle, aws-dynamodb, aws-rds
- **Docs & diagrams**: mcp, mdn, d2, mermaid, starlight, excalidraw
- **Email & services**: resend, letsencrypt
- **Frontend frameworks**: nextjs, react, astro, hono, tailwindcss, shadcn, svelte, htmx, tanstack-query, tanstack-router, tanstack-table, tanstack-form, effect, fastapi
- **Git forges**: github, gitlab, gitea
- **Infrastructure**: docker, kubernetes, k3s, terraform, ansible, flyio, helm, argocd, sst, aws-eks
- **Languages & runtimes**: effect, typescript, python, rust-book, bun, deno, go, zod, nix, fastapi
- **Mobile & desktop**: react-native, flutter, expo, tauri, wails
- **Monitoring & observability**: supabase-grafana, prometheus, opentelemetry, grafana
- **Reverse proxy & networking**: cloudflare, caddy, traefik, wireguard, aws-waf, aws-elb
- **Postgres-compatible**: neon, cockroachdb, yugabytedb, paradedb, timescaledb, electric
- **Postgres ecosystem**: postgres-wiki, pgvector, postgis, pgbouncer, pg-cron, pgrx, citus, pg-graphql, pg-net, index-advisor, supavisor, supabase-grafana, multigres, multigres-dev
- **Postgres HA & ops**: patroni, pgpool
- **Secrets & encryption**: bitwarden, vaultwarden, aws-secretsmanager, age, sops
- **Supabase ecosystem**: pg-graphql, pg-net, index-advisor, supavisor, supabase-grafana
- **Terminal & editor**: neovim, tmux, wezterm, zsh, ohmyzsh, zinit, powerlevel10k, mise
- **Testing**: vitest, jest, playwright, cypress

## General computer use

Tool outputs become next-turn input tokens. Extract, don't dump. Probe before reading.

### Deciding question

- Static file → Read / specialized extractor
- Command output or stream → bash text utils fine

### Bash text utilities (cat/head/tail/sed/awk)

System prompt forbids these for file ops. They're fine on streams.

**Correct uses**:
- Pipeline ops: `cmd | head -20`, `cmd | awk '{print $2}'`
- Live tail: `tail -f log`
- Multi-file concat: `cat f1 f2 > combined`
- Heredoc scripts: `cat <<EOF > file`

**Wrong (always)**:
- Viewing static file → Read
- First/last N lines of known file → Read with `limit`/`offset`
- Piping file into tool → `tool < file` or `tool file`, never `cat file | tool`
- Editing source → Edit / sd / ast-grep --rewrite (never sed/awk)
- Tabular files → mlr / duckdb / dsq

### Editing tool selection

| Case | Tool |
|---|---|
| Single file, surgical change | Edit |
| Single file >~1000 lines or >100KB | `sd` / `sed -i` (Edit risks freeze: opencode#19604, #20471, #16115) |
| Same pattern across 5+ files | `ast-grep --rewrite` (AST-precise) or `sd` (text-only) |
| Simple text substitution, no Read first | `sd 'pattern' 'replace' file` |
| AST-precise rewrite (avoid strings/comments) | `ast-grep --pattern 'foo($X)' --rewrite 'bar($X)' --update-all -l ts` |
| Append to file | `cat <<'EOF' >> file` |
| Insert/delete by line range | `sed -i` with line addressing (GNU sed, no `''`) |
| Whole-file regen | Write |

**GNU sed recipes** (your `sed` is GNU 4.10):

```bash
sd 'old' 'new' big-file.md                              # simple substitution, no Read
ast-grep --pattern 'oldFn($X)' --rewrite 'newFn($X)' --update-all -l ts
sed -i '99a\new content here' file                      # insert after line 99
sed -i '100,200d' file                                  # delete lines 100-200
sed -i '/pattern/d' file                                # delete matching lines
perl -i -pe 's/old/new/g' file                          # complex regex
```

### After editing source code

Run formatter only if project has one configured (check `package.json` scripts, `Makefile`, `pyproject.toml`, `biome.json`, `.eslintrc*`, `.prettierrc*`, `ruff.toml`):

- TS/JS with `biome.json`: `biome check --write`
- TS/JS with `.prettierrc*`: `prettier --write` + `eslint --fix`
- Python with `ruff.toml` or `pyproject.toml` [ruff] section: `ruff check --fix && ruff format`
- Rust: `cargo clippy --fix --allow-dirty && cargo fmt`
- Go: `gofmt -w` (or `make fmt` if Makefile target exists)

### Token discipline

**Probe before reading**:
- Unknown size? `wc -l file` or `stat file` first
- >300 lines? Read with `offset`/`limit`
- Lockfiles (package-lock.json, pnpm-lock.yaml, Cargo.lock, poetry.lock): NEVER full-read — query with `jq`/`yq`/`rg`

**GitHub via gh**:
- `gh api repos/x/y/issues/N --jq '.title,.body'` over `gh issue view N`
- `gh pr view N --json title,body,state,files`
- `gh pr diff N --name-only` first, drill into specific files only when needed

**Git**:
- Recent commits: `git log --oneline -N`
- Subjects only: `git log --pretty=format:'%h %s' -N`
- Diff overview: `git diff --stat` then drill into files
- Status: `git status --short`
- Function history: `git log -L :funcName:file`
- Blame range: `git blame -L start,end file`

### Structured data extraction

| Format | Tool | Example |
|---|---|---|
| JSON known shape | `jq` | `jq '.field' file.json` |
| JSON unknown shape | `gron \| rg key` | `gron file.json \| rg apiKey` |
| YAML/TOML/XML | `yq` | `yq '.spec.replicas' k.yaml` / `yq '.deps' Cargo.toml` (auto-detect by ext) / `yq -p xml '.config' f.xml` |
| HTML | `htmlq` | `htmlq 'h1' --text < page.html` |
| CSV/TSV transforms | `mlr` | `mlr --csv stats1 -a mean -f price data.csv` |
| SQL on heterogeneous files | `dsq` | `dsq users.csv 'SELECT * FROM {} WHERE age > 30'` |
| Large CSV/Parquet/JSON | `duckdb` | `duckdb -c "SELECT col FROM 'f.csv' WHERE x>100 LIMIT 10"` |

### Search & discovery

- Filenames only: `rg -l pattern`
- Match counts: `rg -c pattern`
- Bloat protection: `rg --max-columns 200 --max-count 3`
- File finding with filters: `fd` (size, mtime, type) over Glob
- Inline context: `rg -C 3` (avoids follow-up Read)
- Code symbols: `ast-grep --pattern '...'` or `ctags -R` then query tags
- Directory overview: `eza --tree -L 2 --git-ignore`
- LOC stats: `tokei`
- Verify own edits: `git diff <file>`, not re-Read
- Test/build logs: `rg 'FAIL|Error|ERROR' output`, not Read whole log

### OpenCode-specific gotchas

- **Edit/Write degrade past ~100KB or ~1000 lines** (opencode#20471 O(N²) diff, #19604 silent Write fail, #16115 LSP socket deadlock, #10099 4MB freeze). For large files: `sd` or `sed -i`.
- **`/messages` payload bloat** with many edits on 4MB+ files (#14543) — kills browser. Avoid Edit cycles on bundled JS / generated files.
- **MCP tool timeout default 30s** (`packages/opencode/src/mcp/index.ts:36`). JSON-RPC -32001 = timeout. Bump via `mcp.<name>.timeout` (ms) in `opencode.json`.
