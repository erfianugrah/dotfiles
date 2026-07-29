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

age, alloy, amass, ansible, apache-traffic-server, archwiki, argocd, astro, authentik, aws-apigateway, aws-aurora, aws-cloudformation, aws-cloudfront, aws-cognito, aws-dms, aws-dynamodb, aws-ec2, aws-ecs, aws-eks, aws-elb, aws-eventbridge, aws-glue, aws-iam, aws-kinesis, aws-lambda, aws-rds, aws-redshift, aws-s3, aws-secretsmanager, aws-sns, aws-sqs, aws-step-functions, aws-systems-manager, aws-vpc, aws-waf, azure, azure-aks, azure-container-instances, azure-entra, azure-key-vault, azure-monitor, azure-virtual-machines, bazarr, bbot, better-auth, beyla, bind9, bitwarden, borgbackup, btrfs, bun, bunnycdn, cachyos, caddy, caddy-cache-handler, citus, clerk, cloudflare, cloudflare-blog, cloudflare-changelog, cockroachdb, curl, cypress, d2, debezium, debian-handbook, debian-reference, deno, docker, drizzle, duckdb, electric, erfi-personal-blog, erfi-technical-blog, eslint, excalidraw, exiftool, expo, faro, fastapi, fastly, flutter, flyio, gitea, github, gitlab, gluetun, go, grafana, graphql, graphql-spec, helm, hono, htmx, http-caching-rfcs, http-caching-tutorial, httpie, index-advisor, jellyfin, jellyseerr, jest, k3s, k6, keycloak, knot-dns, kubernetes, letsencrypt, liftosaur, linux-fs, logflare, loki, maigret, mcp, mdn, mermaid, miekg-dns, miekg-dns-v2, mimir, mise, modern-sql, multigres, multigres-dev, neon, neovim, nextjs, nginx, nix, nixos, npm, nsd, ntfy, ohmyzsh, oncall, opencode, openid, opentelemetry, openzfs, overseerr, paradedb, patroni, pg-cron, pg-graphql, pg-net, pgbouncer, pgloader, pgpool, pgrx, pgvector, pi, planetscale, playwright, pnpm, postgis, postgres, postgres-wiki, postgrest, powerdns, powerlevel10k, prettier, prisma, projectdiscovery, prometheus, pyroscope, python, qbittorrent, quarto, rclone, react, react-native, recon-ng, recyclarr, redis, resend, restic, rhel9-basic-system-settings, rhel9-containers, rhel9-dnf, rhel9-file-systems, rhel9-firewalls, rhel9-kernel, rhel9-lvm, rhel9-network-infrastructure-services, rhel9-networking, rhel9-performance, rhel9-security-hardening, rhel9-selinux, rhel9-storage, rhel9-systemd, ripgrep, rspack, rust-book, sabnzbd, samba, saml, searxng, servarr, shadcn, sherlock, slskd, sops, souin, spiderfoot, sqlite, sqlstyle, squid, sst, starlight, steamos, stripe, supabase, supabase-blog, supabase-changelog, supabase-cli, supabase-etl, supabase-grafana, supabase-server, supabase-status, supabase-wrappers, supavisor, svelte, tailwindcss, tanstack-form, tanstack-query, tanstack-router, tanstack-table, tauri, tempo, terraform, theharvester, timescaledb, tmux, traefik, trash-guides, turborepo, typescript, ubuntu-server, unraid, use-the-index-luke, valkey, varnish, vaultwarden, vercel, vercel-blog, vercel-changelog, vite, vitest, vyos, wails, wezterm, wireguard, yacy, yugabytedb, zinit, zod, zsh

---

### Related source groups

When searching one source, check related sources for cross-referencing:

- **API specs**: aws-api, gcp-api, cloudflare-api, docker-api, kubernetes-api, supabase-api, supabase-auth-api, flyio-api, gitea-api, authentik-api, keycloak-api, stripe-api
- **APIs & specs**: openid, saml, http-caching-rfcs, graphql, graphql-spec, mcp, stripe, liftosaur
- **Auth & identity**: supabase, keycloak, authentik, better-auth, clerk, openid, saml, bitwarden, vaultwarden, aws-cognito, azure-entra, supabase-server
- **Backups**: restic, borgbackup
- **Blogs & changelogs**: supabase-blog, supabase-changelog, cloudflare-blog, cloudflare-changelog, vercel-blog, vercel-changelog, erfi-technical-blog, erfi-personal-blog
- **Build tools**: vite, vitest, turborepo, rspack, eslint, prettier, pnpm, npm, opencode, pi
- **HTTP caching**: caddy-cache-handler, souin, varnish, squid, nginx, apache-traffic-server, http-caching-rfcs, http-caching-tutorial
- **CLI tools**: curl, ripgrep, httpie, rclone, recyclarr
- **Cloud platforms**: supabase, clerk, planetscale, neon, flyio, sst, cloudflare, akamai, fastly, bunnycdn, aws-lambda, aws-s3, aws-cloudfront, aws-iam, aws-dynamodb, aws-cloudformation, aws-vpc, aws-ec2, aws-rds, aws-dms, aws-aurora, aws-redshift, aws-glue, aws-kinesis, aws-sqs, aws-sns, aws-ecs, aws-eks, aws-secretsmanager, aws-systems-manager, aws-cognito, aws-apigateway, aws-eventbridge, aws-step-functions, aws-waf, aws-elb, vercel, stripe, azure, azure-aks, azure-virtual-machines, azure-container-instances, azure-key-vault, azure-monitor, azure-entra
- **Databases & SQL**: supabase, postgres, mysql, debezium, postgres-wiki, drizzle, prisma, sqlite, redis, valkey, modern-sql, use-the-index-luke, sqlstyle, duckdb, planetscale, supabase-wrappers, supabase-etl, pgloader, aws-dynamodb, aws-rds, aws-dms, aws-aurora, aws-redshift, aws-glue
- **Docs & diagrams**: mcp, mdn, d2, mermaid, quarto, starlight, excalidraw
- **DNS servers**: nsd, knot-dns, powerdns, bind9, miekg-dns, miekg-dns-v2
- **Email & services**: resend, letsencrypt
- **Filesystems**: openzfs, btrfs, linux-fs, samba, unraid
- **Frontend frameworks**: nextjs, react, astro, hono, tailwindcss, shadcn, svelte, htmx, tanstack-query, tanstack-router, tanstack-table, tanstack-form, effect, fastapi
- **Git forges**: github, gitlab, gitea
- **Infrastructure**: docker, kubernetes, k3s, terraform, ansible, flyio, helm, argocd, sst, aws-eks, azure-aks, azure-virtual-machines, azure-container-instances, unraid
- **Languages & runtimes**: miekg-dns, miekg-dns-v2, effect, typescript, python, rust-book, bun, deno, go, zod, nix, liftosaur, fastapi
- **Linux distros**: cachyos, archwiki, nixos, debian-handbook, debian-reference, ubuntu-server, vyos, steamos, steamdeckhq, rhel9-basic-system-settings, rhel9-dnf, rhel9-networking, rhel9-network-infrastructure-services, rhel9-security-hardening, rhel9-selinux, rhel9-firewalls, rhel9-storage, rhel9-lvm, rhel9-file-systems, rhel9-performance, rhel9-kernel, rhel9-systemd, rhel9-containers, linux-fs
- **Media servers & automation**: servarr, trash-guides, recyclarr, bazarr, jellyfin, overseerr, jellyseerr, qbittorrent, sabnzbd, slskd, gluetun
- **Mobile & desktop**: react-native, flutter, expo, tauri, wails
- **Monitoring & observability**: supabase-grafana, prometheus, opentelemetry, grafana, loki, tempo, mimir, pyroscope, alloy, beyla, k6, oncall, faro, ntfy, supabase-status, azure-monitor, logflare
- **NAS & home server**: openzfs, samba, unraid
- **Reverse proxy & networking**: cloudflare, akamai, fastly, bunnycdn, caddy, caddy-cache-handler, souin, varnish, squid, nginx, apache-traffic-server, traefik, wireguard, nsd, knot-dns, powerdns, bind9, aws-waf, aws-elb, vyos, rhel9-networking, rhel9-network-infrastructure-services, rhel9-firewalls, samba, gluetun
- **OSINT & reconnaissance**: searxng, projectdiscovery, amass, spiderfoot, theharvester, recon-ng, sherlock, maigret, bbot, exiftool, yacy
- **Postgres-compatible**: neon, cockroachdb, yugabytedb, paradedb, timescaledb, electric
- **Postgres ecosystem**: postgres-wiki, pgvector, postgis, pgbouncer, pg-cron, pgrx, citus, pg-graphql, pg-net, index-advisor, supavisor, supabase-grafana, supabase-wrappers, supabase-etl, postgrest, pgloader, multigres, multigres-dev
- **Postgres HA & ops**: patroni, pgpool
- **Secrets & encryption**: bitwarden, vaultwarden, aws-secretsmanager, age, sops, azure-key-vault
- **Supabase ecosystem**: pg-graphql, pg-net, index-advisor, supavisor, supabase-grafana, supabase-wrappers, supabase-etl, supabase-cli, postgrest, supabase-changelog, supabase-status, supabase-server, logflare
- **Terminal & editor**: neovim, tmux, wezterm, zsh, ohmyzsh, zinit, powerlevel10k, mise
- **Testing**: vitest, jest, playwright, cypress
