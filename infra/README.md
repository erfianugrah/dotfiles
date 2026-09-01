# ~/infra - infrastructure repo family

One repo per domain. All private GitHub under `erfianugrah/` unless noted.
Non-repo entries: `docs/` (loose notes + plans), `knotea-build/` (knotea
source/build trees), `storage-migration-tracker.md` (live servarr storage
migration state).

## NixOS hosts & fleet

| Repo | What |
|---|---|
| `router/` | MS-01 edge router NixOS config (flake). Deploy: edit, commit, `make deploy` |
| `servarr-nixos/` | NixOS host config for the NAS box (replaces Unraid) |
| `hearth/` | NixOS host config for erfipie (RPi 4B) - home IoT hub (Home Assistant + ESPHome, native services) |
| `nixos-fleet/` | Shared NixOS profiles - a LIBRARY the hosts import as a flake input |

## Network & edge

| Repo | What |
|---|---|
| `eaves/` | Read-only ops CLI for the router (`show`/`monitor`/`doctor`) |
| `xikectl/` | Operator CLI for the XikeStor SKS8300 switch |
| `vyos/` | VyOS router config - SG site (erfiyos, incl. Magic WAN) |
| `vyos-nl/` | VyOS router config - NL site |
| `openwrt/` | Clone of upstream `openwrt/openwrt` (origin upstream, `fork` remote at erfianugrah/openwrt) |
| `wifi7-ap/` | Spec + bring-up plan for a DIY Wi-Fi 7 (802.11be) access point |
| `pylon/` | Self-hosted tunnel platform - single Go binary (server, client, CLI) |
| `gps-clock/` | GPS-disciplined master clock for the bench |

## DNS

| Repo | What |
|---|---|
| `knotea/` | Authoritative + recursive DNS monorepo (erfi.io etc.) |
| `knot-fly/` | Authoritative Knot DNS on Fly.io behind a Cloudflare-shaped REST API |
| `gloryhole/` | DNS resolver: ad-blocking + policy engine + Astro/React dashboard |

(`knotea-build/` next door holds knotea's source/build trees; not a repo.)

## Cluster & platform tooling

| Repo | What |
|---|---|
| `composer/` | composerd GitOps agent source + CLI (deploys the compose stacks below) |
| `bombe/` | Greenfield RK1 cluster rebuild (4x RK1 on Turing Pi 2). Talos-vs-NixOS pending, see docs/research/. LOCAL ONLY, no remote |
| `k3s/` | RETIRED 2026-08 - old k3s manifests, porting reference only |
| `drawbridge/` | Access gate in front of the Docker daemon |
| `secretctl/` | Compare, move, and use credentials without printing them |
| `migctl/` | Bulk data migration with proof (migration as a state machine) |
| `vfctl/` | GPU voltage/frequency curve tool for NVIDIA (NVAPI, telemetry, stability tests) |

## AI / ML & agents

| Repo | What |
|---|---|
| `ai/llm-compose/` | llama.cpp + ComfyUI + lora-train stack, GPU mode-switching proxy (`llmc`). PUBLIC |
| `ai/whisper-transcribe/` | WhisperX transcription service + bot + video-review pipeline |
| `ai/pi-mcp-bridge/` | Bridge that runs local stdio MCP servers for pi |
| `chat/` | SUPERSEDED by `gumshoe` - the open-webui container on servarr now runs under the gumshoe compose project (verified 2026-09-01); chat's own AGENTS.md is stale |
| `chatscope/` | Reading environment for chat corpora |
| `gumshoe/` | Local AI research assistant on servarr's RTX 3080 Ti (chat.erfi.io; consolidated the former chat stack) |
| `research/` | Self-hosted web search + crawler + OSINT toolkit, exposed as MCP server |
| `memledger/` | One Postgres for every agent client's memory (pi, claude, session ledger) |
| `mnemosyne/` | Personal knowledge graph over the document archive. NO REMOTE yet |

## Apps & services

| Repo | What |
|---|---|
| `crier/` | Self-hosted E2EE pub/sub push notifications |
| `deno-edge/` | Self-hosted Deno edge functions + static-site platform |
| `shortr/` | URL shortener - single Go binary on Fly.io, SQLite |
| `servarr/` | nzb360-compatible dashboard for the servarr host |
| `slskarr/` | Unified Soulseek music pipeline (replaces soularr + slskd + beets) |
| `lockstep/` | Synchronized watch-party playback for Jellyfin. NO REMOTE yet |

## ergo workspace

`ergo/` is a Go workspace (its own AGENTS.md inside is canonical):

| Repo | What |
|---|---|
| `ergo/caddy-compose/` | Edge Caddy + WAF + wafctl + dashboard compose stack |
| `ergo/caddy-body-matcher/` | Caddy plugin: request body matching |
| `ergo/caddy-policy-engine/` | Caddy plugin: WAF policy engine + JA4 + PoW challenge |
| `ergo/caddy-ddos-mitigator/` | Caddy plugin: adaptive DDoS mitigation |
| `ergo/coraza-caddy/` | Fork of the OWASP Coraza WAF Caddy module |
| `ergo/souin/` | Fork of darkweak/souin (edge HTTP cache patches) |
| `ergo/vigil/` | Fleet vulnerability sweeps (trivy + CISA KEV) |

## Compose stacks (composer-managed unless the repo's AGENTS.md says otherwise)

| Repo | Service | Host |
|---|---|---|
| `servarr-compose/` | The *arr media stack + Jellyfin (the big one, has runbooks/) | servarr |
| `atuin/` | Atuin shell-history sync | |
| `copyparty-compose/` | copyparty file server | |
| `draw/` | Self-hosted Excalidraw (realtime collab, no Firebase) | |
| `forgejo-compose/` | Forgejo git hosting + runner (replaced gitea-compose) | router |
| `gh-runner/` | GitHub Actions self-hosted runner | router |
| `httpbun-compose/` | httpbun echo/debug service | |
| `immich-compose/` | Immich photos | |
| `joplin-compose/` | Joplin notes | |
| `keycloak-compose/` | Keycloak IdP | |
| `matrix-server/` | Matrix Synapse stack (Cloudflare Tunnel) | RPi |
| `mnemosyne-compose/` | pgvector Postgres for mnemosyne | servarr |
| `monitoring-compose/` | THE monitoring stack - Prometheus + Grafana (grafana.erfi.io) | servarr |
| `silo-compose/` | Silo S3 (MinIO fork) | |
| `standardnotes-compose/` | Standard Notes | |
| `vaultwarden-compose/` | Vaultwarden passwords | |

NOT here: `~/dotfiles` (pi/shell config), `~/cf-stuff/erfianugrah-cf-tf`
(Cloudflare Terraform), `~/work` (Supabase work repos).

Sibling pi skills pointing into this tree: `eaves`, `xikectl`, `knotctl`,
`knot-dns`, `gloryhole`, `caddy`, `composer`, `arr-stack`, `jellyfin`,
`tailscale-homelab`, `waf-api`, `souin`, `drawbridge`, `nixos`, `memledger`,
`llm-compose`, `whisper`, `comfyui`, `lora-train`, `compose-backups`.

Plan + verification harness that produced the original layout:
`~/infra/servarr-compose/docs/plans/2026-08-08-infra-repo-reorg.md`
(path updated after servarr-compose itself moved here 2026-08-08).
