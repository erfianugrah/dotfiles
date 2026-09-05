---
name: arr-stack
description: "Use when operating the servarr media stack - sonarr, radarr, lidarr, bazarr, prowlarr, sabnzbd, qbittorrentvpn, slskd/soularr/beets, recyclarr, decluttarr, tracearr, jellyfin, seerr, navidrome. Fires on those names; on TRaSH guides, custom formats; on 'No files found are eligible for import', 'remote path mapping', 'No valid Arr instances found', SAB queue auto-pause, NVENC/GPU sharing, Seerr requests not grabbing. NOT for compose authoring (infrastructure-stack) or deploy (composer)."
---

# arr-stack

Compose project `servarr` on the `servarr` NAS (NixOS + ZFS since 2026-08-26), composer-managed from the router. Live compose: `~/infra/servarr-compose/docker-compose.yml` (about 20 services). Its `AGENTS.md` has a "2026-08-26 NixOS cutover - READ FIRST" section plus per-service notes and `runbooks/` (`arr-stack-ops.md`, `music-pipeline.md`, `soularr-architecture.md`, `music-collection-recovery.md`, `2026-08-29-arr-fixes-and-rustnzb.md`, `lan-macvlan.md`). Those auto-load when cwd is the repo; this skill is the cross-cwd subset. Where the AGENTS.md prose still says `/rpool/cache/data/<svc>`, trust the compose file: that path was destroyed 2026-09-03 and the live hot tier is `/appdata/<svc>`.

## Storage - the TRaSH layout on ZFS

| Tier | Host path | Mounted as |
|---|---|---|
| Hot (NVMe) | `/appdata/<svc>/config` (or `/data`, `/app` per service) | `/config` - DB, queue state, plugins |
| Bulk (HDD raidz2) | `/tank/media` (`tv/ movies/ music/ torrents/ usenet/`) | `/data` in sonarr, radarr, lidarr, bazarr, decluttarr (roots `/data/tv`, `/data/movies`); `/data/media:ro` in jellyfin; `/media` + `/torrents` in qbit; `/data` in SAB |
| Bulk | `/tank/anugrah` | `/anugrah` (jellyfin, read-only personal stash) |
| Scratch (NVMe) | `/scratch/downloads/usenet/incomplete`, `/scratch/slskd-dl` | SAB unpack / par2 (shadow-mounted over `/data/usenet/incomplete`), slskd downloads |

Everything media-touching sits on the single `tank/media` filesystem, so download -> import is an atomic hardlink (`copyUsingHardlinks: true` is correct; torrents keep seeding after import). Tier decisions and snapshots are the `zfs-storage` skill.

## Service quick reference

Edge Caddy on the router proxies `<svc>.erfi.io` to each service's macvlan LAN IP (`10.0.71.x`) or host-published port; the servarr-local Caddy is retired.

| Service | `servarr` IP | LAN IP | Port | External |
|---|---|---|---|---|
| Radarr | 172.19.1.2 | 10.0.71.22 | 7878 | `radarr.erfi.io` |
| Sonarr | 172.19.1.3 | 10.0.71.23 | 8989 | `sonarr.erfi.io` |
| Bazarr | 172.19.1.4 | 10.0.71.24 | 6767 | `bazarr.erfi.io` |
| Lidarr | 172.19.1.7 | 10.0.71.27 | 8686 | `lidarr.erfi.io` |
| Soularr | 172.19.1.8 | 10.0.71.28 | 8265 | `soularr.erfi.io` |
| Beets | 172.19.1.9 | 10.0.71.29 | 8337 | - |
| Prowlarr | 172.19.1.10 | 10.0.71.30 | 9696 | `prowlarr.erfi.io` |
| FlareSolverr | 172.19.1.18 | - | 8191 | internal only |
| slskd (in `wg-pia-slskd` netns) | 172.19.1.16 | host `10.0.71.2:5030` | 5030 | `slskd.erfi.io` |
| SABnzbd | 172.19.1.19 | 10.0.71.39 | 8080 | `sabnzbd.erfi.io` |
| qBittorrent (VPN) | 172.19.1.22 | host `10.0.71.2:8180` | 8080 | `qbit.erfi.io` |
| Tracearr | 172.19.1.23 (+172.19.2.2) | 10.0.71.45 | 3000 | `tracearr.erfi.io` |
| tracearr-db / tracearr-redis | 172.19.2.3 / 172.19.2.4 | - | - | `tracearr_backend` only |
| Recyclarr | 172.19.1.5 | - | - | `sleep infinity`; composer `docker_exec` target |
| Decluttarr | 172.19.1.12 | - | - | - |
| Jellyfin | 172.19.1.15 (+172.19.30.2) | 10.0.71.35 | 8096 | `jellyfin.erfi.io` |
| Seerr | 172.19.1.21 (+172.19.30.3) | 10.0.71.41 | 5055 | `seerr.erfi.io` |
| Navidrome | 172.19.1.17 (+172.19.30.4) | 10.0.71.37 | 4533 | `navidrome.erfi.io` |

Networks: `servarr` 172.19.1.0/24, `tracearr_backend` 172.19.2.0/24, `media` 172.19.30.0/24 (consumer cross-stack link), `lan` macvlan 10.0.71.0/24 on `enp36s0f1`.

API-key extraction (arr products are XML, SAB is ini; qBit auth is by `WEBUI_PASSWORD` env and the `servarr` subnet is whitelisted):

```bash
ssh servarr 'grep -oP "ApiKey>\K[^<]+" /appdata/<svc>/config/config.xml'
ssh servarr 'grep "^api_key" /appdata/sabnzbd/config/sabnzbd.ini | awk "{print \$3}"'
```

Decluttarr / recyclarr read `SONARR_API_KEY` / `RADARR_API_KEY` from the stack's SOPS-encrypted `.env` (never print them - `secret-handling` skill).

## Load-bearing rules

1. Composer-managed deploy: edit the compose, push (webhook -> sync + `up`), or `POST /api/v1/stacks/servarr/up` - never `restart`, which reuses old config. Quirks in the `composer` skill.
2. GPU: RTX 3080 Ti, claimed with CDI `devices: [nvidia.com/gpu=all]` - NOT `runtime: nvidia` (NixOS dockerd has no nvidia runtime registered). Shared by jellyfin (live transcode) and bazarr (Whisper subtitles); a single NVENC card, so heavy subtitle batches degrade live playback. tdarr is gone (removed 2026-06-15).
3. Hardlink convention: every media-touching service mounts `/tank/media` and the arrs see it as `/data`. Anything that mounts a subdirectory under a different container path needs a remote path mapping in every arr that uses it.
4. qBit auth: WebUI user is `anugrah`, not `admin`; `172.19.1.0/24` bypasses auth via `AuthSubnetWhitelist`; five failed logins ban the IP for 1h in memory (`docker restart qbittorrentvpn` clears).
5. Decluttarr `remove_orphans` stays OFF: Sonarr returns `seriesId: null` for legit season packs at queue-write time, so the job deletes real downloads. The other jobs run. Decluttarr v2 uses a `config.yaml`, not the v1 env vars - v1 keys are silently ignored and the container exits every 30s with `No valid Arr instances found in the config`.
6. SAB `download_free = 200G` stays set (Folders -> Minimum Free Disk Space). Without it par2/unrar can hit ENOSPC mid-write and the queue auto-pauses with `pause_reason: null`.
7. Download clients in every arr MUST have a category (`tv` / `movies` / `music`). A client without one lands single-file grabs bare in the save path; the arr then reports `No files found are eligible for import` and re-grabs forever, while manual import works (the tell).
8. Composer pipeline `docker_exec` step config field is `cmd` (not `command`, `args`, `argv`) - wrong field = pipeline runs that "succeed" in 0.0s. Reference: the `recyclarr-sync` pipeline.
9. Bash quoting trap on arr/Prowlarr JSON payloads: indexer `helpText` contains `(` `)`; inline `-d "$PAYLOAD"` breaks. Tempfile + `--data-binary @file`, or use `arrctl`.

## DNS - containers resolve via knotea

Every NixOS host pins `networking.nameservers = ["10.0.10.5"]` (knotea on the router) with tailscale `accept-dns=false`, and servarr-nixos pins `virtualisation.docker.daemon.settings.dns = ["10.0.10.5"]` so Docker's embedded resolver forwards there regardless of restart order. If `*.erfi.io` resolves to public Cloudflare IPs from a container, or containers SERVFAIL on everything, tailscale has rewritten resolv.conf or dockerd is holding a stale resolver - fix the pin, restart dockerd.

## Remote path mappings

qBit reports `/media/torrents/...`; the arrs see the same tree as `/data/torrents/...`. Each of sonarr / radarr / lidarr needs `remotePath: /media/torrents/` -> `localPath: /data/torrents/` keyed to the EXACT host string the download client is configured with (currently `172.19.1.22`). Sonarr/Radarr match mappings by that field, so a mapping keyed to a hostname never applies to a client configured by IP and vice versa - the symptom is "directory does not exist inside the container" although the path exists. SAB and the arrs share `/data`, so SAB needs no mapping.

## Prowlarr

- Sonarr app sync categories must be the 5000-series (`[5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5070, 5080]`), not 2000-series: otherwise every Newznab query carries movie cats and interactive searches return 0 results while Prowlarr finds them fine. Check the `cat=` parameter in Sonarr's debug log.
- The FlareSolverr indexer proxy needs `tags: [1]` matching the `flaresolverr` tag on the Cloudflare-protected indexers (1337x, KickAssTorrents); without the tag the proxy exists but never engages and indexer tests fail with generic connection errors.

## Music pipeline (lidarr -> soularr -> slskd, beets on the side)

Lidarr holds the catalog (`/data/music`), Soularr polls Lidarr's wanted/cutoff-unmet list and drives slskd searches + transfers over the PIA WireGuard netns (`wg-pia-slskd`); downloads land on `/scratch/slskd-dl` and import through Lidarr. Beets runs read-only against `/music` for library hygiene only - it is not in the import path and never re-tags the library. Design and safety rules: `runbooks/music-pipeline.md`, `runbooks/soularr-architecture.md`, `runbooks/music-collection-recovery.md`.

## arrctl - the executable form of these mechanics

`~/infra/arrctl` (Go, stdlib-only, static) encodes the arr operations as tested commands: `import` (the verified `GET /manualimport -> POST ManualImport -> Rename*` flow with the command outcome checked, so "imported 0" is a non-zero exit), `naming set` (TRaSH naming with apply-and-verify, handles the Sonarr nested-audiocodec render bug), `export` / `restore` (0600 config dumps; restore recreates into a fresh instance), `restructure` (destructive folder canonicalisation, dry-run by default, `-execute` + inode-aware guards + `-opslog`), `clients pause/resume` (SAB + nzbget). It is a flake input of `~/infra/servarr-nixos` and installed on the NAS (`nix flake update arrctl` there to bump); details in `~/infra/arrctl/AGENTS.md`. Reach for it instead of hand-rolled curl.

## Consumer side (jellyfin, seerr, navidrome)

Each consumer sits on `servarr` (to reach the arr APIs) and on `media` 172.19.30.0/24 (reserved for consumer-only services that should not see download infrastructure).

| Service | Mounts | Notes |
|---|---|---|
| Jellyfin | `/appdata/jellyfin/library:/config`, `/tank/media:/data/media:ro`, `/tank/anugrah:/anugrah` | GPU via CDI (rule 2). Its library DB stores `/data/media/...` paths, so it keeps the `/data/media` mount while the arrs moved to `/data` |
| Seerr | `/appdata/jellyseerr/config:/app/config` (`settings.json` lives there, holds arr API keys - filesystem perms are the boundary) | Settings -> Services -> Sonarr/Radarr must use internal IPs `http://172.19.1.3:8989` / `http://172.19.1.2:7878`, never the `*.erfi.io` URLs (WAF + TLS hop, breaks on any edge hiccup) |
| Navidrome | `/appdata/navidrome/data:/data`, `/tank/media/music:/music:ro` | `ND_*` env (Spotify / Last.fm keys, password encryption key) come from the SOPS `.env`. The password encryption key is irreversible - losing it makes every Navidrome password unusable; keep it in the encrypted `.env` in git (`secret-handling` skill) |

When a Seerr request never grabs, the failure is upstream (Sonarr/Radarr could not bind a release, decluttarr, indexer offline) - debug from the arr side. `jellyfin.erfi.io` and `seerr.erfi.io` are exposed without forward-auth; their own logins are the boundary, so keep admin passwords strong and signup disabled.

## Sibling skills

- `composer` - deploy mechanism; `sync` vs `up` vs `restart`, pipelines, WAF on the public API.
- `infrastructure-stack` - compose authoring conventions (bridge + static IP, expose-only, macvlan `lan`).
- `zfs-storage` - which tier state belongs on, snapshots, backups.
- `caddy` - the edge proxy for `*.erfi.io`.
- `tailscale-homelab` - `ssh servarr`.
- `research` - indexer reputation lookups.

Docs sources (erfi-toolkit docs tool): `servarr`, `trash-guides`, `sonarr-api-v5`, `radarr-api`, `prowlarr-api`, `sabnzbd`, `qbittorrent`, `recyclarr`, `bazarr`, `lidarr-api`, `jellyfin`, `jellyseerr`, `navidrome`.
