---
name: arr-stack
description: Use when working with the *arr stack on `servarr` — radarr / sonarr / bazarr / prowlarr (the four arrs), sabnzbd / qbittorrentvpn / flaresolverr (download infra), recyclarr / decluttarr / tdarr / tracearr (ops + transcode + tracing). Triggers on these service names; on TRaSH guides / quality profiles / custom formats / release profiles; on errors like "database disk image is malformed", "remove_orphans destroying downloads", "Episode N was unexpected considering folder name", EXDEV / ENOSPC in download paths, "No valid Arr instances found"; on indexer hygiene (Prowlarr API), manual import via API, hardlink-on-shfs questions, decluttarr v1→v2 schema migration, SAB queue auto-pauses. Stack runs in compose project `servarr` on Unraid, composer-managed. Sibling to `jellyfin` (consumer-side), `composer` (deploy), `caddy` (proxy), `tailscale-homelab` (ssh).
---

# arr-stack

Single Unraid host (`servarr`), single docker-compose project (`servarr`), composer-managed. 14 services on `172.19.1.0/24`; `tracearr_backend` (172.19.2.0/24) for Tracearr's internal Postgres+Redis.

The stack repo (when checked out) ships its own AGENTS.md + runbooks/ — those auto-load when cwd is inside the repo. The rules below are the cross-cwd subset: facts the agent should respect even when working from elsewhere.

## Service quick reference

| Service | Static IP | Port | External |
|---|---|---|---|
| Radarr | 172.19.1.2 | 7878 | `radarr.erfi.io` |
| Sonarr | 172.19.1.3 | 8989 | `sonarr.erfi.io` |
| Bazarr | 172.19.1.4 | 6767 | `bazarr.erfi.io` |
| Prowlarr | 172.19.1.10 | 9696 | `prowlarr.erfi.io` |
| SABnzbd | 172.19.1.19 | 6666 / 8080 | `sabnzbd.erfi.io` |
| qBittorrent (VPN) | 172.19.1.22 | 8080 | `qbit.erfi.io` |
| FlareSolverr | 172.19.1.18 | 8191 | (internal only) |
| Tdarr | 172.19.1.6 | 8265 | `tdarr.erfi.io` |
| Tracearr | 172.19.1.23 | 3000 | `tracearr.erfi.io` |
| Recyclarr | (sleep daemon, no port) | — | — |
| Decluttarr | (no port) | — | — |

API-key extraction (servarr does not ship `rg` — use `grep`/`awk`):

```bash
# arr products (radarr / sonarr / prowlarr / bazarr — XML-config based, ApiKey element)
ssh servarr 'grep -oP "ApiKey>\K[^<]+" /mnt/user/data/<svc>/config/config.xml'

# SABnzbd (ini format)
ssh servarr 'grep "^api_key" /mnt/user/data/sabnzbd/config/sabnzbd.ini | awk "{print \$3}"'

# qBit — auth via WEBUI_PASSWORD env (subnet 172.19.1.0/24 is whitelisted, bypasses auth)
```

For decluttarr / recyclarr, `SONARR_API_KEY` / `RADARR_API_KEY` come from the stack's gitignored `.env`.

## Load-bearing rules — do not violate

1. **Composer-managed deploy**: edit the stack's `docker-compose.yml`, push, then `POST /api/v1/stacks/servarr/up` (NOT `restart` — restart reuses old config). Sibling **composer** skill has the full deploy quirks (sync vs up, WAF + UA gating, pipeline `cmd` field, response shape).

2. **GPU contention on the GTX 1070**: Pascal NVENC gen 6, single chip. Three services share it via `runtime: nvidia`: jellyfin (live transcode), tdarr (background re-encode), bazarr (Whisper subtitle gen). Don't queue Tdarr work while Jellyfin is actively transcoding.

3. **Hardlinks on shfs are structurally broken**: `torrents/X/file.mkv` and `media/X/file.mkv` only land on the same physical disk by luck (shfs spreads files across `/mnt/diskN/` based on Unraid's allocator). Sonarr/Radarr fall through to non-atomic move on `EXDEV`. **Torrents lose seeding after import — expected** until storage migrates to mergerfs or single-disk. Do not "fix" by toggling `copyUsingHardlinks`; the setting is correct (true).

4. **qBit auth quirks**: WebUI username is `anugrah`, NOT `admin`. Subnet `172.19.1.0/24` is whitelisted via `AuthSubnetWhitelist` so servarr-internal callers bypass auth. After 5 failed auths, IP-banned for 1h (in-memory; `docker restart qbittorrentvpn` clears).

5. **Decluttarr `remove_orphans` is OFF** for cause (false-positive on legit season packs / underscore-format releases): decluttarr defines "orphan" as items where Sonarr returns `seriesId: null`, which fires on legit season packs that Sonarr can't enumerate at queue-write time. Other 6 jobs run. Do not re-enable without an upstream fix.

6. **SAB on `/mnt/cache/` direct, not `/mnt/user/`** (slamanna pattern, 2026-05-24): keeps unpacks off shfs. `download_free: 200G` MANDATORY — without it, par2/unrar hits ENOSPC mid-write and the queue auto-pauses with `pause_reason: null`.

7. **Composer pipeline `docker_exec` step config field is `cmd`** — not `command`, `argv`, `args`, `Cmd`. Wrong field = silent no-op pipeline run. Reference example: `recyclarr-sync` pipeline (id `pl_18b158c83eeb82a5_f2f0384c`).

8. **Bash quoting trap on Prowlarr/arr API payloads**: indexer JSON contains `(` `)` in helpText. Inline `-d "$PAYLOAD"` triggers "syntax error near unexpected token `('`". Always tempfile + `--data-binary @file`.

## Sibling skills

- **`jellyfin`** — consumer-side (jellyfin/jellyseerr/navidrome). Jellyseerr requests upstream into Sonarr/Radarr via API integration.
- **`composer`** — GitOps deploy mechanism. `sync` ≠ `up` ≠ `restart`. WAF on composer.erfi.io blocks bare-curl mutations — internal-network workaround documented.
- **`caddy`** — `*.erfi.io` reverse proxy + TSIG ACME path against Knot.
- **`tailscale-homelab`** — `ssh servarr` access; the `docker exec / docker logs / docker restart` triple that runs everything else.
- **`infrastructure-stack`** — bridge-net + static-IP + expose-only-no-ports conventions this stack exemplifies.
- **`research`** — the `osint_*` / `web_research` tools for indexer reputation lookups.
