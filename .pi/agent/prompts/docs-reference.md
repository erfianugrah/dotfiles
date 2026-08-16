# docs.erfi.io reference - full source list + groupings

This file is loaded on-demand (via `read` or `docs_*` tool calls). It was
moved out of the main AGENTS.md to reduce per-turn system-prompt tokens
(~1000 tokens saved). The instructional content (workflow, tools, output
markers, token tips) remains in AGENTS.md.

Regenerated from src/application/{sources,source-tags}.ts - do not hand-edit.

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

adguard-home, age, airgradient, akamai, alloy, amass, ansible, apache-traffic-server, archwiki, argocd, astro, asuswrt-merlin, athom, authentik, authentik-api, aws-api, aws-apigateway, aws-aurora, aws-cloudformation, aws-cloudfront, aws-cognito, aws-dms, aws-dynamodb, aws-ec2, aws-ecs, aws-eks, aws-elb, aws-eventbridge, aws-glue, aws-iam, aws-kinesis, aws-lambda, aws-rds, aws-redshift, aws-s3, aws-secretsmanager, aws-sns, aws-sqs, aws-step-functions, aws-systems-manager, aws-vpc, aws-waf, azure, azure-aks, azure-container-instances, azure-entra, azure-key-vault, azure-monitor, azure-virtual-machines, bazarr, bbot, better-auth, beyla, bind9, bitwarden, borgbackup, btrfs, bun, bunnycdn, cachyos, caddy, caddy-cache-handler, ceph-rgw, citus, clerk, cloudflare, cloudflare-api, cloudflare-blog, cloudflare-changelog, cockroachdb, curl, cypress, d2, ddwrt, debezium, debian-handbook, debian-reference, deno, diataxis, docker, docker-api, drizzle, duckdb, effect, electric, erfi-personal-blog, erfi-technical-blog, eslint, esphome, excalidraw, exiftool, expo, faro, fastapi, fastly, flutter, flyio, flyio-api, freshtomato, garage, gcp-api, gitea, gitea-api, github, gitlab, glinet, gluetun, go, grafana, graphql, graphql-spec, helm, home-assistant, hono, htmx, http-caching-rfcs, http-caching-tutorial, httpie, idratherbewriting, ietf-rfc, index-advisor, iptables, jellyfin, jellyseerr, jest, k3s, k6, kea, keycloak, keycloak-api, knot-dns, kubernetes, kubernetes-api, letsencrypt, liftosaur, linux-fs, logflare, loki, maigret, matter, mcp, mdn, mermaid, microsoft-style-guide, miekg-dns, miekg-dns-v2, mimir, mise, modern-sql, multigres, multigres-dev, mysql, neon, neovim, nextjs, nftables, nginx, nix, nixos, nixos-turing-rk1, npm, nsd, ntfy, ohmyzsh, oncall, opencode, openid, opentelemetry, openthread, openvpn, openwrt, openzfs, opnsense, overseerr, paradedb, patroni, pfsense, pg-cron, pg-graphql, pg-net, pganalyze-blog, pgbouncer, pgloader, pgmustard, pgpool, pgrx, pgvector, pi, pihole, pikvm, planet-postgres, planetscale, playwright, pnpm, postgis, postgres, postgres-weekly, postgres-wiki, postgrest, powerdns, powerlevel10k, powershell, prettier, prisma, projectdiscovery, prometheus, pyroscope, python, qbittorrent, quarto, rclone, react, react-native, recon-ng, recyclarr, redis, resend, restic, rhel9-basic-system-settings, rhel9-containers, rhel9-dnf, rhel9-file-systems, rhel9-firewalls, rhel9-kernel, rhel9-lvm, rhel9-network-infrastructure-services, rhel9-networking, rhel9-performance, rhel9-security-hardening, rhel9-selinux, rhel9-storage, rhel9-systemd, ripgrep, rspack, rust-book, rustfs, sabnzbd, samba, saml, searxng, seaweedfs, servarr, shadcn, sherlock, silo, slskd, sops, souin, spiderfoot, sqlite, sqlstyle, squid, sst, starlight, steamdeckhq, steamos, stripe, stripe-api, strongswan, supabase, supabase-api, supabase-auth-api, supabase-blog, supabase-changelog, supabase-cli, supabase-etl, supabase-grafana, supabase-server, supabase-status, supabase-wrappers, supavisor, svelte, tailwindcss, talos, tanstack-form, tanstack-query, tanstack-router, tanstack-table, tauri, tempo, terraform, theharvester, timescaledb, tmux, traefik, trash-guides, turborepo, turingpi, turingpi-help-center, turingpi-rk1, turris, typescript, ubuntu-server, unraid, use-the-index-luke, valkey, varnish, vaultwarden, vercel, vercel-blog, vercel-changelog, versitygw, vite, vitest, vyos, wails, wezterm, windows-server, wireguard, writethedocs-guide, wsl, yacy, yugabytedb, zigbee2mqtt, zinit, zod, zsh, zwave-js

---

### Related source groups

When searching one source, check related sources for cross-referencing:

- **API specs**: authentik-api, aws-api, cloudflare-api, docker-api, flyio-api, gcp-api, gitea-api, keycloak-api, kubernetes-api, stripe-api, supabase-api, supabase-auth-api
- **APIs & specs**: graphql, graphql-spec, http-caching-rfcs, idratherbewriting, liftosaur, mcp, openid, saml, stripe
- **Auth & identity**: authentik, aws-cognito, azure-entra, better-auth, bitwarden, clerk, keycloak, openid, saml, supabase, supabase-server, vaultwarden
- **Backups**: borgbackup, restic
- **Blogs & changelogs**: cloudflare-blog, cloudflare-changelog, erfi-personal-blog, erfi-technical-blog, supabase-blog, supabase-changelog, vercel-blog, vercel-changelog
- **Build tools**: eslint, npm, opencode, pi, pnpm, prettier, rspack, turborepo, vite, vitest
- **CLI tools**: curl, httpie, rclone, recyclarr, ripgrep
- **Cloud platforms**: akamai, aws-apigateway, aws-aurora, aws-cloudformation, aws-cloudfront, aws-cognito, aws-dms, aws-dynamodb, aws-ec2, aws-ecs, aws-eks, aws-elb, aws-eventbridge, aws-glue, aws-iam, aws-kinesis, aws-lambda, aws-rds, aws-redshift, aws-s3, aws-secretsmanager, aws-sns, aws-sqs, aws-step-functions, aws-systems-manager, aws-vpc, aws-waf, azure, azure-aks, azure-container-instances, azure-entra, azure-key-vault, azure-monitor, azure-virtual-machines, bunnycdn, clerk, cloudflare, fastly, flyio, neon, planetscale, sst, stripe, supabase, vercel
- **Databases & SQL**: aws-aurora, aws-dms, aws-dynamodb, aws-glue, aws-rds, aws-redshift, debezium, drizzle, duckdb, modern-sql, mysql, pgloader, planetscale, postgres, postgres-wiki, prisma, redis, sqlite, sqlstyle, supabase, supabase-etl, supabase-wrappers, use-the-index-luke, valkey
- **DNS servers**: adguard-home, bind9, kea, knot-dns, miekg-dns, miekg-dns-v2, nsd, pihole, powerdns
- **Docs & diagrams**: d2, excalidraw, mcp, mdn, mermaid, quarto, starlight
- **Email & services**: letsencrypt, resend
- **Filesystems**: btrfs, linux-fs, openzfs, samba, unraid
- **Firewall & packet filtering**: iptables, nftables, opnsense, pfsense
- **Frontend frameworks**: astro, effect, fastapi, hono, htmx, nextjs, react, shadcn, svelte, tailwindcss, tanstack-form, tanstack-query, tanstack-router, tanstack-table
- **Git forges**: gitea, github, gitlab
- **Hardware & SBCs**: airgradient, athom, nixos-turing-rk1, pikvm, turingpi, turingpi-help-center, turingpi-rk1
- **HTTP caching**: apache-traffic-server, caddy-cache-handler, http-caching-rfcs, http-caching-tutorial, nginx, souin, squid, varnish
- **Infrastructure**: ansible, argocd, aws-eks, azure-aks, azure-container-instances, azure-virtual-machines, ceph-rgw, docker, flyio, garage, helm, k3s, kubernetes, rustfs, seaweedfs, silo, sst, talos, terraform, turingpi, unraid, versitygw
- **Languages & runtimes**: bun, deno, effect, fastapi, go, liftosaur, miekg-dns, miekg-dns-v2, nix, powershell, python, rust-book, typescript, zod
- **Linux distros**: archwiki, cachyos, debian-handbook, debian-reference, linux-fs, nixos, nixos-turing-rk1, rhel9-basic-system-settings, rhel9-containers, rhel9-dnf, rhel9-file-systems, rhel9-firewalls, rhel9-kernel, rhel9-lvm, rhel9-network-infrastructure-services, rhel9-networking, rhel9-performance, rhel9-security-hardening, rhel9-selinux, rhel9-storage, rhel9-systemd, steamdeckhq, steamos, talos, ubuntu-server, vyos, wsl
- **Media servers & automation**: bazarr, gluetun, jellyfin, jellyseerr, overseerr, qbittorrent, recyclarr, sabnzbd, servarr, slskd, trash-guides
- **Mobile & desktop**: expo, flutter, react-native, tauri, wails
- **Monitoring & observability**: alloy, azure-monitor, beyla, faro, grafana, k6, logflare, loki, mimir, ntfy, oncall, opentelemetry, prometheus, pyroscope, supabase-grafana, supabase-status, tempo
- **NAS & home server**: openzfs, samba, unraid
- **Object storage (S3-compatible)**: ceph-rgw, garage, rustfs, seaweedfs, silo, versitygw
- **OSINT & reconnaissance**: amass, bbot, exiftool, maigret, projectdiscovery, recon-ng, searxng, sherlock, spiderfoot, theharvester, yacy
- **Postgres ecosystem**: citus, index-advisor, multigres, multigres-dev, pg-cron, pg-graphql, pg-net, pganalyze-blog, pgbouncer, pgloader, pgmustard, pgrx, pgvector, planet-postgres, postgis, postgres-weekly, postgres-wiki, postgrest, supabase-etl, supabase-grafana, supabase-wrappers, supavisor
- **Postgres HA & ops**: patroni, pgpool
- **Postgres-compatible**: cockroachdb, electric, neon, paradedb, timescaledb, yugabytedb
- **Reverse proxy & networking**: adguard-home, akamai, apache-traffic-server, asuswrt-merlin, aws-elb, aws-waf, bind9, bunnycdn, caddy, caddy-cache-handler, cloudflare, ddwrt, fastly, freshtomato, glinet, gluetun, ietf-rfc, iptables, kea, knot-dns, nftables, nginx, nsd, openvpn, openwrt, opnsense, pfsense, pihole, powerdns, rhel9-firewalls, rhel9-network-infrastructure-services, rhel9-networking, samba, souin, squid, strongswan, traefik, turris, varnish, vyos, windows-server, wireguard
- **Router firmware**: asuswrt-merlin, ddwrt, freshtomato, glinet, openwrt, opnsense, pfsense, turris
- **Secrets & encryption**: age, aws-secretsmanager, azure-key-vault, bitwarden, sops, vaultwarden
- **Smart home & IoT**: airgradient, athom, esphome, home-assistant, matter, openthread, zigbee2mqtt, zwave-js
- **Standards & RFCs**: ietf-rfc
- **Supabase ecosystem**: index-advisor, logflare, pg-graphql, pg-net, postgrest, supabase-changelog, supabase-cli, supabase-etl, supabase-grafana, supabase-server, supabase-status, supabase-wrappers, supavisor
- **Technical writing & docs craft**: diataxis, idratherbewriting, microsoft-style-guide, writethedocs-guide
- **Terminal & editor**: mise, neovim, ohmyzsh, powerlevel10k, powershell, tmux, wezterm, zinit, zsh
- **Testing**: cypress, jest, playwright, vitest
- **VPN**: openvpn, strongswan, wireguard
- **Windows**: powershell, windows-server, wsl
