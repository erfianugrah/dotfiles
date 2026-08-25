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

## Deploy (push-rebuild loop)

One-time bootstrap (first deploy): clone the repo ON the NAS into /etc/nixos:

```bash
ssh root@10.0.71.3 'git clone git@github.com:erfianugrah/servarr-nixos.git /etc/nixos'
```

(NAS /etc/nixos is currently empty; root there has an id_ed25519 - verify
GitHub key auth works before relying on it.)

Every deploy after that:

1. Commit + `git push` from the dev box.
2. `ssh root@10.0.71.3 'git -C /etc/nixos pull && nixos-rebuild switch --flake /etc/nixos#servarr'`

Both the local and remote legs now hit the dangerous-cmd-guard `nixos_rebuild`
confirm prompt - that prompt is intended, don't work around it.

## Rollback

- `ssh root@10.0.71.3 'nixos-rebuild switch --rollback'`
- Bad boot: pick the previous generation in the systemd-boot menu at the console.

## Hard rules

- Never edit /etc/nixos directly on the NAS - the repo is the source of truth.
- No secrets in the repo (sops-nix is wired; age key lives on the NAS).
- `tank` pool was created BY HAND at cutover - mounts/policy in storage.nix,
  never add it to disko.nix.
- First-generation note: earlier config changes may be "committed but not
  deployed" until the bootstrap deploy lands; check `git -C /etc/nixos log -1`.

## Not this skill

Router NixOS -> eaves. Arr/Jellyfin containers on Unraid -> arr-stack /
jellyfin. Deployment of compose stacks -> composer.
