---
name: zfs-storage
description: Use when deciding which servarr tier app state lives on (hot NVMe /appdata vs bulk HDD /tank/appdata), dataset/recordsize design, or sanoid snapshots, syncoid replication or the nix pg_dump timers (~/infra/servarr-nixos storage.nix + backup.nix). Fires on 'which tier', 'appdata placement', 'sanoid', 'syncoid', 'apphot', 'pg_dump timer', 'recordsize', 'snapshot not freeing space'. NOT for migctl moves (migrating-bulk-data), offen sidecars (compose-backups), or NixOS deploys (nixos).
---

# ZFS + declarative durability - servarr NAS

The host storage + backup layer for the servarr NixOS NAS. Config lives in
`~/infra/servarr-nixos/modules/{storage,backup}.nix`; canonical current state in
`~/infra/servarr-nixos/docs/migration/storage-migration-tracker.md`. Read the
public references for the reasoning: lexicanum `reference/appdata-tiering-zfs`,
`reference/declarative-homelab-backups`, `reference/zfs-on-nixos`.

## The two tiers - the core placement decision

Score each service's state on latency / redundancy / re-derivability; the
dominant axis picks the tier.

- **`/appdata`** (rpool, Samsung 970 NVMe, NON-redundant) = HOT: fsync-heavy
  random IO - all arr SQLite configs, all postgres (`/appdata/pg`, recordsize
  16K), redis/valkey, qbittorrent, beets, atuin, and the Jellyfin LIBRARY (its
  media files stay on `/tank/media`).
- **`/tank/appdata`** (tank raidz2 HDD, redundant) = BULK: large and
  re-pullable/regenerable - MinIO, the Prometheus TSDB, LLM model weights,
  research datasets.

Rules: one canonical path per service; placement follows the data's IO shape,
not the service label. Irreplaceable data still goes on the non-redundant NVMe
deliberately - its safety is snapshots + off-pool replication (below), not pool
redundancy. Full table + reasoning: lexicanum `appdata-tiering-zfs`.

## Pools - 3, by hardware role

- `rpool` (970 NVMe TLC, non-redundant): `/`, `/var/lib/docker`, `/appdata`,
  `/appdata/pg`. ashift left auto at create (effective 9; accepted in
  `docs/plans/2026-09-02-zfs-layout-reconciliation.md` F14). ARC capped 16GiB.
- `tank` (raidz2 HDD): `/tank/{media,anugrah,appdata,data,backups}`. Created by
  hand at cutover (NOT disko); mounts + policy in storage.nix.
- `scratch` (P2 QLC NVMe, `sync=disabled`): downloads + transcode temp.

Mount discipline: put `zfsutil` on every non-legacy fileSystems entry - a rebuild
reexec unmounts non-legacy datasets and cannot remount them without it (live-fired
twice). Detail: lexicanum `zfs-on-nixos`.

## Backups - 3 declarative mechanisms (backup.nix)

| Data | Mechanism | Off-pool copy |
|---|---|---|
| postgres clusters | `pg_dump -Fc` systemd timer, one per cluster -> /tank/backups/pg | logical dump |
| file state (arr/redis/qb/beets/atuin) | sanoid `apphot` snapshot | + syncoid replica |

- pg_dump timers `docker exec` into each cluster and use ITS OWN env creds (so no
  secret is duplicated in nix), stamp a node-exporter textfile metric
  (`backup_pg_last_success_timestamp`), OnCalendar 02:30 + jitter, `OnFailure=
  backup-alert@`. A PARKED cluster (stack down) must be REMOVED from `pgClusters`
  or its timer fails nightly on a dead `docker exec`.
- sanoid `apphot` template: hourly=24 / daily=7 / weekly=4 / monthly=3 on
  rpool/appdata{,/pg} - hot state needs both the ~1h window and the long tail.
- syncoid rpool/appdata -> tank/backups/zfs-repl, `--no-sync-snap` (ships sanoid's
  snaps), and MUST be `After=sanoid.service`: both timers fire at :00 and without
  ordering the replica lags one snapshot. Do NOT add `--no-privilege-elevation` -
  Linux `zfs receive`/mount needs real root.

Full rationale + the untested-restore trap (a dump is not a restore): lexicanum
`declarative-homelab-backups`.

## Gotchas (learned on this box)

- **Deleting data on a snapshotted dataset does not free space** until the
  snapshots holding it age out (tank/backups is on the `default` template).
  `zfs list -o name,used` shows the snapshot-held space; force-prune the snaps
  only if you need the space now.
- **Retire stopgaps.** Temporary sanoid templates/entries (e.g. a `hot` template
  protecting a pre-move path) must be REMOVED once the source is gone, or they
  snapshot the wrong dataset / nothing. Grep storage.nix for TEMPORARY/retire.
- **recordsize=16K on `rpool/appdata/pg`** (postgres 8K pages; balances write-amp
  vs lz4). recordsize only applies to NEW writes, so set it before data lands.
- **Absolute-bind config seeding.** composer runs compose on servarr's dockerd but
  the checkout is on the router, so relative `./` binds resolve on the daemon host,
  not the checkout. Config a stack needs (e.g. copyparty's party.conf) must be
  seeded at an absolute path on servarr (`/appdata/<svc>/config`).

## Related skills

- **migrating-bulk-data** - migctl for the actual cross-dataset/host moves
  (plan/verify/coverage/gate). This skill decides WHERE data lands; that one MOVES it.
- **compose-backups** - compose-level backup SIDECARS (offen/docker-volume-backup);
  this skill is the ZFS + nix-timer layer instead.
- **nixos** - `make deploy` mechanics for servarr-nixos.
- **composer** - deploying the compose stacks that live on these paths.
