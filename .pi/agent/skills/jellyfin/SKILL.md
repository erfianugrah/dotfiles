---
name: jellyfin
description: Use when working with the user's media-consumer stack on `servarr` — Jellyfin (media server, NVENC transcoding on GTX 1070), Jellyseerr (request manager that integrates with Sonarr/Radarr via API), Navidrome (Subsonic-compatible music server). Triggers on these service names; on transcoding / hardware acceleration / NVENC / Pascal codec questions; on Jellyseerr request-routing into the arr stack; on Navidrome scrobble / Spotify / Last.fm / `ND_*` env setup; on the cross-stack `media` network (172.19.30.0/24); on Jellyfin library / metadata / playback debugging. Co-deployed in compose project `servarr` on Unraid, composer-managed. Sibling to `arr-stack` (upstream content pipeline), `composer` (deploy), `caddy` (proxy), `tailscale-homelab` (ssh).
---

# jellyfin (consumer-side stack)

Three media-consumer services co-deployed in the `servarr` compose project on Unraid, composer-managed: Jellyfin (video), Jellyseerr (request → arr integration), Navidrome (music).

The stack repo (when checked out) ships its own AGENTS.md — that auto-loads when cwd is inside the repo. The rules below are the cross-cwd subset: facts the agent should respect even when working from elsewhere.

## Service quick reference

| Service | Static IPs | Port(s) | External | Networks |
|---|---|---|---|---|
| Jellyfin | 172.19.1.15, 172.19.30.2 | 8096, 8920 | `jellyfin.erfi.io` | `servarr` + `media` |
| Jellyseerr | 172.19.1.21, 172.19.30.3 | 5055 | `seerr.erfi.io` | `servarr` + `media` |
| Navidrome | 172.19.1.17, 172.19.30.4 | 4533 | `navidrome.erfi.io` | `servarr` + `media` |

**Dual-network topology**: each consumer is on the main `servarr` network (so it can reach Sonarr/Radarr/Prowlarr APIs at `172.19.1.x`) AND the `media` cross-stack network `172.19.30.0/24` (reserved for future consumer-only services that should not see download infrastructure).

## Storage layout (host paths on `servarr`)

| Path | Use |
|---|---|
| `/mnt/user/data/<svc>/config/` | Per-service config (DB, plugins, transcode temp) — bind-mounted to `/config` in the container |
| `/mnt/user/jellyfin/library/` | Jellyfin's own metadata library — **separate mount, heavy** |
| `/mnt/user/data/servarr/media/` | Content directory; same path Sonarr/Radarr write to, so library scans agree |
| `/mnt/user/anugrah/` | Personal stash, Jellyfin read-only mount |

## NVIDIA GPU — the contention rule

**GTX 1070 = Pascal NVENC gen 6** (h264 + hevc encode, **no AV1**). **Single NVENC chip on the card.**

Three services share it via `runtime: nvidia` (CDI-compatible, switched from legacy `NVIDIA_VISIBLE_DEVICES` at servarr-compose commit `d4cb4e9`):

- **`jellyfin`** — live transcode (4K → 1080p, h264 → hevc, etc.)
- **`tdarr`** — background library re-encode (lives in the `arr-stack` skill)
- **`bazarr`** — OpenAI Whisper subtitle generation

**Rule**: queue Tdarr work for off-hours when no live Jellyfin transcoding happens. Concurrent NVENC across all three degrades all of them — single-chip is the bottleneck.

## Jellyseerr → arr integration

Jellyseerr talks directly to Sonarr/Radarr via API key. Settings → Services → Sonarr/Radarr:

- **URL**: `http://172.19.1.3:8989` (Sonarr) / `http://172.19.1.2:7878` (Radarr) — internal IPs, **NOT** the `*.erfi.io` URLs (avoids the WAF + TLS hop).
- **API key**: from each arr's `config.xml` (`/mnt/user/data/<svc>/config/config.xml` → `<ApiKey>` element). The **arr-stack** skill has the extraction snippet.

When Jellyseerr requests fail to grab, the failure is almost always upstream (Sonarr couldn't bind, decluttarr false-positive, indexer offline). See sibling **arr-stack** skill — investigate from Sonarr/Radarr's side, not Jellyseerr's.

Jellyseerr config lives at `/mnt/user/data/jellyseerr/config/settings.json` on the servarr host (key/secret material in plaintext on disk — protect via filesystem permissions / Unraid user shares).

## Navidrome

`deluan/navidrome:latest` — Subsonic-compatible music server. Library mounted from `/mnt/user/anugrah/` or wherever the user's music collection lives.

`ND_*` env vars in `.env` (gitignored): Spotify/Last.fm keys, prometheus password, password encryption key. **Do not hardcode in compose** — env-resolved from `.env` per the rest of the stack.

The password encryption key is irreversible — losing it = all Navidrome user passwords unusable. Back it up to Vaultwarden when setting up.

## Load-bearing rules

1. **Composer-managed deploy**: edit the stack's `docker-compose.yml`, push, then `POST /api/v1/stacks/servarr/up` (not `restart` — restart reuses old config). Sibling **composer** skill for full deploy quirks.

2. **GPU mutex**: see "NVIDIA GPU" section above. The biggest tdarr-vs-jellyfin gotcha.

3. **Jellyseerr should hit arr internal IPs, not Caddy URLs.** Saves a round trip through the public network + WAF and never breaks during a Caddy/cert hiccup.

4. **Public-facing service**: `jellyfin.erfi.io` and `seerr.erfi.io` are exposed without forward-auth (Authelia is reserved for admin tools). Default Jellyfin/Jellyseerr login is the auth boundary — keep admin passwords strong, disable signup if not needed.

5. **Library scans on shfs**: Jellyfin's library scan walks the entire `/data/media/` tree. Under shfs (FUSE union), this can spike I/O across all array disks simultaneously. The `incident-2026-05/` work is pre-condition for any aggressive scanning policy.

## Sibling skills

- **`arr-stack`** — Sonarr/Radarr/Bazarr/Prowlarr + download clients + recyclarr/decluttarr/tdarr/tracearr. Jellyseerr requests flow upstream into this stack.
- **`composer`** — deploy mechanism. `POST /api/v1/stacks/servarr/up` recreates containers; plain `restart` reuses old config.
- **`caddy`** — `*.erfi.io` reverse proxy.
- **`tailscale-homelab`** — `ssh servarr` access path.
- **`infrastructure-stack`** — bridge-net + static-IP + cross-stack `media` network conventions this stack uses.
