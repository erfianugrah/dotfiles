---
name: servarr-nixos
description: Use when changing, evaluating, or deploying the servarr NAS NixOS host config (repo ~/infra/servarr-nixos, flake #servarr, NAS at 10.0.71.3, tank/rpool/scratch ZFS pools), running its acceptance checks, or nixos-rebuilding the NAS. Fires on 'deploy to the NAS', 'servarr-nixos', 'nixos-rebuild servarr', 'NAS NixOS config'. NOT for the router's NixOS (eaves skill), Unraid arr containers (arr-stack), or cutover data migration (docs/plans in that repo).
---

# servarr-nixos - NixOS host config for the NAS

## Overview

Repo `~/infra/servarr-nixos` (github.com/erfianugrah/servarr-nixos) holds the
flake-based NixOS config for the new servarr NAS box (ASRock X570D4U, static
`10.0.71.3`, root ssh key-only). Flake output: `.#servarr`. The NAS builds its
own system natively - the dev WSL box has nix 2.35.2 for eval but NO
`nixos-rebuild` (NixOS-only activation tool). Never hunt for one here.

## Eval gate (before any deploy)

```bash
cd ~/infra/servarr-nixos && .pi/check-acceptance.sh
```

Tar-syncs the repo to the edge router (10.0.69.1, which has nix) and evaluates
`.pi/acceptance.nix` - must print all-true. `.pi/sync-edge.sh` is the sync half
alone. Repo `AGENTS.md` + `docs/plans/2026-08-19-nas-cutover-plan.md` are
canonical where older docs disagree.

## Deploy (tar-sync + rebuild on the NAS)

The NAS does NOT git-clone its config - `/etc/nixos` stays empty. Each deploy
tar-syncs the working tree over and rebuilds from the copy:

```bash
# 1. from the dev box: push (so origin/main matches what you deploy)
git push

# 2. tar-sync the repo to the NAS and rebuild from the copy
tar cz --exclude=.git -C ~/infra/servarr-nixos . \
  | ssh root@10.0.71.3 'rm -rf /tmp/sne-rebuild && mkdir /tmp/sne-rebuild && tar xz -C /tmp/sne-rebuild'
ssh root@10.0.71.3 'nixos-rebuild switch --flake /tmp/sne-rebuild#servarr'
```

The flake path `/tmp/sne-rebuild` is the established landing dir (same shape
as `.pi/sync-edge.sh` uses for the edge eval). Deployed generations live in
the normal system profile - rollback below. The nixos-rebuild leg hits the
dangerous-cmd-guard `nixos_rebuild` confirm prompt - intended, don't work
around it.

## Rollback

- `ssh root@10.0.71.3 'nixos-rebuild switch --rollback'`
- Bad boot: pick the previous generation in the systemd-boot menu at the console.
- Check generation history: `ssh root@10.0.71.3 'nix-env --list-generations --profile /nix/var/nix/profiles/system'`

## Hard rules

- Never edit anything directly on the NAS - the repo is the source of truth;
  the NAS only ever receives a disposable tar-copy (`/tmp/sne-rebuild`, wiped
  and rewritten each deploy).
- No secrets in the repo (sops-nix + a NAS-dedicated age key at
  /var/lib/sops-nix/key.txt, escrowed in Bitwarden - see .sops.yaml).
- `tank` pool was created BY HAND at cutover - mounts/policy in storage.nix,
  never add it to disko.nix.
- Rsync migration runs may be in flight - check for rsync procs before any
  reboot-class operation on the NAS.

## Not this skill

Router NixOS -> eaves. Arr/Jellyfin containers on Unraid -> arr-stack /
jellyfin. Deployment of compose stacks -> composer.
