---
name: compose-backups
description: Add or review an automated backup sidecar for any of the user's docker-compose stacks. Encodes the validated offen/docker-volume-backup pattern - cron schedule, DB dumps via lifecycle labels into a shared staging volume, age client-side encryption with the shared infra recipient, S3-compatible upload (R2 or MinIO), retention pruning, and shoutrrr email-on-failure. Use when adding backups to a stack, debugging a backup sidecar, restoring from one of these backups, or reviewing backup coverage. Fires on "backup this stack", "offen", "docker-volume-backup", "restore drill", "pg_dump to R2/MinIO". Sibling to infrastructure-stack (stack conventions), composer (deploy path).
---

# Compose stack backups (offen/docker-volume-backup pattern)

Validated end-to-end on vaultwarden-compose 2026-08-09 (encrypted upload, restore drill with byte-identical row counts, failure-notification e2e). Canonical live example: `~/infra/vaultwarden-compose/deploy/edge/compose.yaml`.

## The standard sidecar

```yaml
  backup:
    image: offen/docker-volume-backup:v2.48.2   # pin; check oci_tags for current
    container_name: <stack>_backup
    restart: unless-stopped
    environment:
      - BACKUP_CRON_EXPRESSION=*/15 * * * *     # or @daily for less critical stacks
      - BACKUP_FILENAME=<stack>-backup-%Y-%m-%dT%H-%M-%S.tar.gz
      - BACKUP_EXCLUDE_REGEXP=icon_cache         # see typo trap below
      - BACKUP_RETENTION_DAYS=30
      - BACKUP_PRUNING_PREFIX=<stack>-backup-    # MANDATORY, see below
      - AGE_PUBLIC_KEYS=age1yd6fnsq24uz4rx3rk7srrazqh6xkjnaxl44g9jrraa4d69034usqkmp8zs
      - AWS_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID}
      - AWS_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY}
      - AWS_ENDPOINT=<host-only-no-scheme>
      - AWS_S3_BUCKET_NAME=<bucket>
      - AWS_S3_PATH=<prefix-no-leading-slash>
      - EXEC_LABEL=<stack>
      - NOTIFICATION_URLS=${BACKUP_NOTIFICATION_URLS}
      - NOTIFICATION_LEVEL=error
      - TZ=Asia/Singapore
    volumes:
      - <host-data-path>:/backup/data:ro
      - <stack>_backup_staging:/backup/pg:ro      # if a DB dump is needed
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

## DB dumps via lifecycle labels (no DB client in the backup image)

The offen image is Alpine + one Go binary - no pg_dump, no awscli. Dumps run
INSIDE the database container via labels, writing to a shared staging volume
that the backup container also mounts:

```yaml
  postgres_<stack>:
    volumes:
      - <stack>_backup_staging:/tmp/backups
    labels:
      - docker-volume-backup.exec-label=<stack>   # must match EXEC_LABEL on the backup svc
      - docker-volume-backup.archive-pre=/bin/sh -c 'pg_dump -Fc --no-owner --no-acl -U <user> -d <db> -f /tmp/backups/<db>.pgdump'
      - docker-volume-backup.archive-post=/bin/sh -c 'rm -f /tmp/backups/<db>.pgdump'
```

- Official postgres images use trust auth on the local socket, so the label
  command needs NO password (verified live on postgres:17). Verify per-image
  with `docker exec <pg> pg_dump -U <user> -d <db> -Fc -f /tmp/t.pgdump`.
  Fallback if peer/trust fails: `PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 ...`
  (reads the container's own env; keeps the password out of the label).
- No redirection works in labels unless wrapped in `/bin/sh -c '...'`.
- docker.sock in the backup container is root-equivalent on the host -
  accepted on the user's single-purpose hosts; flag it when the host is shared.

## Hard-won footguns (all hit or verified 2026-08-09)

1. **Unrecognised env vars are SILENTLY IGNORED.** `BACKUP_EXCLUDE_REGEX`
   (wrong) vs `BACKUP_EXCLUDE_REGEXP` (correct) shipped a full icon_cache in
   the first tarball with zero warnings. After ANY config change, download the
   next artifact and inspect its contents (`tar -tzf`) - never trust the
   config render. Check exact names against the configuration reference:
   https://offen.github.io/docker-volume-backup/reference/
2. **Pruning without a prefix deletes EVERYTHING in the target dir.**
   `BACKUP_RETENTION_DAYS` applies to all files in the bucket/prefix unless
   `BACKUP_PRUNING_PREFIX` limits scope. Always set it to the non-parametrised
   part of `BACKUP_FILENAME`. Legacy files not matching the prefix linger
   forever - clean them up manually at cutover.
3. **shoutrrr SMTP URL**: the `@` in a Gmail username must be `%40` in the
   userinfo part: `smtp://user%40gmail.com:<app-password>@smtp.gmail.com:587/?fromAddress=<addr>&toAddresses=<addr>`.
   Test before wiring with
   `docker run --rm ghcr.io/nicholas-fedor/shoutrrr send --url "$URL" --message test`.
4. **Composer-managed stack .env files are SOPS ciphertext at rest on the
   host** (`/var/lib/composer/stacks/<stack>/.../.env` yields `ENC[...]` values
   to grep). Composer decrypts in-memory only during deploy. To read live
   values on the host: `docker exec <container> printenv <VAR>`.
5. **What to exclude**: re-derivable caches (icon_cache, thumbnails). Beyond
   size, vaultwarden's icon_cache filenames are plaintext `<domain>.png` -
   they leak which sites have vault entries. With client-side age encryption
   the leak is mitigated at rest, but exclusion is still correct.
6. **Failure-notification e2e test** (do this at rollout, not when it matters):
   one-shot run with a deliberately wrong bucket -
   `docker run --rm ... -e AWS_S3_BUCKET_NAME=definitely-wrong --entrypoint backup offen/docker-volume-backup:v2 ...`
   and confirm the email arrives. A one-shot uses `--entrypoint backup` (no
   `-foreground`); set `BACKUP_CRON_EXPRESSION="0 0 5 31 2 ?"` (never-fires)
   for safety.
7. **Alpine/busybox**: no GNU date in these images - use epoch math
   (`date -d @$(( $(date +%s) - 2592000 ))`), not `date -d '30 days ago'`.
8. **servarr_lan macvlan IPs**: before assigning a static IP to a new sidecar,
   list occupancy first -
   `ssh servarr 'docker network inspect servarr_lan --format "{{range .Containers}}{{.Name}} {{.IPv4Address}} {{end}}"'`.
   Guessing collides (10.0.71.58 was revista; gitea_backup landed on .61).
   MAC convention is `02:42:0a:00:47:<last-octet-in-hex>`.
9. **`cap_drop: ALL` breaks reads of non-root-owned data** (hit on gitea
   2026-08-10): capability-less root has CapEff=0, so the tar walk gets EACCES
   on uid-1000-owned 0770/0600 files (rootless-image data dirs on Unraid,
   e.g. `open /backup/config: permission denied`). If you harden the sidecar
   with `cap_drop: ALL`, also add `cap_add: [DAC_READ_SEARCH]` - read/search
   bypass only, no write (mounts are `:ro` anyway). Verify after rollout with
   `docker exec <stack>_backup ls /backup/<each-mount>`; the walk error only
   names the FIRST unreadable dir, siblings fail too. vaultwarden never hit
   this because its sidecar has no cap_drop at all.

## Storage policy (user's, 2026-08-09)

- Cloudflare R2 bucket `vault` is VAULTWARDEN-ONLY. Everything else backs up to
  self-hosted MinIO at `https://cdn.erfi.io` (on servarr).
- Router-hosted (MS-01) bridge-attached containers CANNOT reach MinIO
  (bridge->LAN 10.0.0.0/8 is policy-dropped). R2 works because bridges get WAN
  egress. A router-local stack that must reach MinIO needs `network_mode: host`.
- age recipient above is the shared infra key; private half lives in
  `~/.config/sops/age/keys.txt` (dev box) + MS-01 composer + Vaultwarden item.

## Rollout checklist

1. Pre-flight: pull image on the target host; verify the in-container dump
   command; test the shoutrrr URL with a real email.
2. Wire the sidecar + labels + staging volume; `docker compose config --quiet`.
3. Deploy via composer (sync + deploy with `{"pull": true}`; never raw compose
   on managed hosts). Confirm the OLD backup sidecar is gone (dual-writer risk
   if two stacks share a bucket prefix).
4. Watch the first scheduled run's logs end-to-end (dump -> tar -> age ->
   upload -> prefix-scoped prune).
5. **Restore drill, every time**: fetch artifact, `age -d -i ~/.config/sops/age/keys.txt`,
   extract, `pg_restore` into a scratch postgres container, compare row counts
   against live (`select count(*) from <biggest table>`). A backup chain that
   has never been restored is a hypothesis.
6. Failure-notification e2e (footgun 6).
7. Clean up legacy artifacts from the previous mechanism (keep 2 newest as a
   bridge under a separate prefix, e.g. `legacy/`; delete after the new chain
   has 30 days of depth).
8. Update the stack's AGENTS.md (mechanism, bucket layout, restore pointer).

## Known gap (accepted)

No dead-man switch: email fires on in-process failure, but a dead container /
dead host sends nothing. Parked until the centralized monitoring stack lands;
the hook is an offen `copy-post` label running busybox wget (present in the
image) against a ping URL.
