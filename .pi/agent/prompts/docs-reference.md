# docs.erfi.io reference — full source list + groupings

This file is loaded on-demand (via `read` or `docs_*` tool calls). It was
moved out of the main AGENTS.md to reduce per-turn system-prompt tokens
(~1000 tokens saved). The instructional content (workflow, tools, output
markers, token tips) remains in AGENTS.md.

## When to read this file

- You need to know which docs source covers a topic and `docs_sources <filter>`
  didn't surface it
- You want to cross-reference related sources (e.g. "sources related to Postgres",
  "sources related to Cloudflare")
- A new project introduces a tech you haven't queried before

For everyday lookup: use `docs_sources <filter>` (returns runtime-current
counts) and `docs_search query=<keyword> source=<source>` directly.

---

### Sources

age, ansible, argocd, astro, authentik, aws-apigateway, aws-cloudformation, aws-cloudfront, aws-cognito, aws-dynamodb, aws-ec2, aws-ecs, aws-eks, aws-elb, aws-eventbridge, aws-iam, aws-lambda, aws-rds, aws-s3, aws-secretsmanager, aws-sns, aws-sqs, aws-step-functions, aws-systems-manager, aws-vpc, aws-waf, bitwarden, bun, caddy, citus, cloudflare, cloudflare-blog, cloudflare-changelog, cockroachdb, curl, cypress, d2, deno, docker, drizzle, effect, electric, erfi-personal-blog, erfi-technical-blog, eslint, excalidraw, expo, fastapi, flutter, flyio, gitea, github, gitlab, go, grafana, graphql, graphql-spec, helm, hono, htmx, httpie, index-advisor, jest, k3s, keycloak, kubernetes, letsencrypt, mcp, mdn, mermaid, mise, modern-sql, multigres, multigres-dev, neon, neovim, nextjs, nix, ohmyzsh, opencode, openid, opentelemetry, paradedb, patroni, pg-cron, pg-graphql, pg-net, pgbouncer, pgpool, pgrx, pgvector, playwright, pnpm, postgis, postgres, postgres-wiki, powerlevel10k, prettier, prisma, prometheus, python, rclone, react, react-native, redis, resend, ripgrep, rspack, rust-book, saml, shadcn, sops, sqlite, sqlstyle, sst, starlight, supabase, supabase-blog, supabase-grafana, supavisor, svelte, tailwindcss, tanstack-form, tanstack-query, tanstack-router, tanstack-table, tauri, terraform, timescaledb, tmux, traefik, turborepo, typescript, use-the-index-luke, valkey, vaultwarden, vercel, vercel-blog, vercel-changelog, vite, vitest, wails, wezterm, wireguard, yugabytedb, zinit, zod, zsh

---

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
