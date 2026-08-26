---
name: nixos
description: Use when changing, evaluating, or deploying ANY of the user's three NixOS hosts - router/edge (~/infra/router, flake .#router), hearth/erfipie Pi (~/infra/hearth, .#erfipie), servarr NAS (~/infra/servarr-nixos, .#servarr). Covers the uniform `make deploy` interface, per-host GitHub deploy keys, eval gates, rollback, the fleet conventions (explicit MTU, clone-force-reset, never-edit-on-host), and the nixos-fleet monorepo consolidation. Fires on 'deploy the router/NAS/Pi', 'nixos-rebuild', 'flake update', 'add a module to <host>', 'NixOS config'. NOT for read-only router ops queries (eaves), the turing-pi RK1 cluster (that is Talos/OpenTofu - see ~/infra/bombe), compose stacks on those hosts (composer/infrastructure-stack), or non-NixOS boxes.
---

# NixOS fleet

Four hosts, one set of conventions. The dev box (WSL) is NOT NixOS: it has
`nix` 2.35.2 for **eval only** - single-user, no daemon socket, no
`nixos-rebuild`. Never hunt for `nixos-rebuild` here; every host builds its
own system natively.

## Hosts

| Host | Repo | Flake | Clone on host | Runs as | Gate |
|---|---|---|---|---|---|
| router (MS-01 edge) | `~/infra/router` | `.#router` | `/etc/nixos` | root | `eaves doctor` (16 checks) |
| servarr (NAS, X570D4U) | `~/infra/servarr-nixos` | `.#servarr` | `/etc/nixos` | root | `.pi/check-acceptance.sh` |
| hearth (erfipie, Pi, aarch64) | `~/infra/hearth` | `.#erfipie` | `~/hearth` | erfi + sudo | none yet |

Addresses: router `10.0.69.1`, servarr `10.0.71.2`, hearth `10.0.69.7`.

**The turing-pi RK1 cluster is NOT a fleet host.** `~/infra/bombe/docs/research/talos.md`
settled on OpenTofu + `siderolabs/talos`, not NixOS. If that is ever revisited
the upstream flake is `github:GiyoMoon/nixos-turing-rk1` (aarch64-only builds
today - x86_64 cross-compilation unsupported, needs binfmt).

## Deploy - always `make`, never hand-rolled ssh

```bash
cd ~/infra/<repo>
make deploy   # eval/doctor gate -> git push -> host fetch+reset -> nixos-rebuild switch
make diff     # same but dry-build / dry-activate: no activation
make check    # local eval-only smoke (nix eval on the dev box)
```

All three repos expose the same verbs. Internals differ only where the host
forces it (hearth pulls as `erfi` then `sudo`; router adds the doctor gate;
servarr runs the acceptance eval on the router because the dev box is
single-user nix). `make deploy` refuses a dirty or unpushed tree.

The `nixos-rebuild` leg trips the dangerous-cmd-guard `nixos_rebuild` confirm
prompt. That is intended - answer it, don't engineer around it.

## Conventions (each one earned from a real incident)

1. **Declare MTU explicitly, even at the default 1500.** networkd and the
   NixOS activation manage MTU *only when the option is present*. Deleting
   `MTUBytes`/`mtu` does not restore the default - it stops managing the
   value and the last-set MTU lives on the interface forever. On 2026-08-26 a
   jumbo revert left the router trunk at 9014 and servarr's NIC at 9000
   through green rebuilds; both needed manual `ip link set ... mtu 1500`.
   Same class of trap applies to any "absence means default" option.
2. **The host clone is a cache, never an edit surface.** Deploys
   `git fetch && git reset --hard origin/main`, so anything edited on the box
   is destroyed silently. Source of truth is `origin/main`, always.
3. **Per-host GitHub deploy key, never copied off the host.** Pattern:
   key `id_gh_<host>` + ssh alias `gh-<host>` in that user's `~/.ssh/config`
   + remote `git@gh-<host>:erfianugrah/<repo>.git`. Read-only deploy key
   registered via `gh repo deploy-key add`. Regenerating is ~30s, so these
   are not escrow-worthy; the sops age keys ARE.
   - Verify: `ssh <host> 'ssh -T git@gh-<host>'` -> "successfully authenticated".
   - A remote of plain `git@github.com` is a bug: it works only by
     default-key probing and breaks the moment a second key appears (hearth
     had exactly this until 2026-08-26).
4. **Eval before activate.** `make check` locally, or the host's own gate.
   Never let a syntax/type error be discovered by the activation.
5. **Secrets: sops-nix, per-host age key on the box.** No plaintext in any
   repo. Each host's age private key lives only on that host and is escrowed
   in Bitwarden; `.sops.yaml` in the repo lists recipients. Key paths are in
   the host's own module - look there, don't hardcode them in notes.

## Rollback

```bash
ssh <host> 'sudo nixos-rebuild switch --rollback'
ssh <host> 'nix-env --list-generations --profile /nix/var/nix/profiles/system'
```
Bad boot: pick the previous generation in the systemd-boot menu at the
console (router/servarr) or via IPMI/serial.

## Verify a deploy actually landed

A green `switch` does NOT prove the live state changed (see convention 1).
For anything touching networking, assert the runtime value:

```bash
ssh <host> 'ip -o link show <iface> | grep -o "mtu [0-9]*"'
ssh <host> 'cd /etc/nixos && git log --oneline -1'   # clone at the pushed commit?
ssh router 'sudo -n eaves doctor'                    # router only
```

## nixos-fleet monorepo (scaffolded, no host migrated yet)

Repo `~/infra/nixos-fleet` exists with `flake.nix` (mkHost helper, no hosts
declared yet), `Makefile` (`check`/`diff`/`deploy`/`gate`/`rollback` with
`HOST=`), and profiles extracted from real host content: `base` (locale/tz/
nix/gc), `shell` (the zsh+tmux+atuin+direnv+fzf+zoxide + modern-CLI set that
was duplicated router<->servarr and **entirely missing on hearth**), `admin`
(sshd key-only, erfi + root backstop, tailscale), `net` (the explicit-MTU
doctrine as a `fleet.net.defaultMtu` option). `nix flake check` passes.

**Read `~/infra/nixos-fleet/PLAN.md` before migrating anything.** Migration
order is hearth -> servarr -> nixpkgs-pin unification -> router LAST (its
940-line `configuration.nix` holds nftables/kea/VLANs and splits into modules
as part of the move). Until a host's step lands, its ORIGINAL repo is
authoritative and the monorepo must not declare it in `nixosConfigurations`.

Known blocker: the three repos pin different nixpkgs (router a specific
commit chosen for a no-op closure diff, the other two `nixos-26.05`). One
`flake.lock` cannot honour all three, so the router's first monorepo deploy
is a mass rebuild - schedule it as its own step. Per-host inputs that must
survive the merge: `eaves` + `nixpkgs-tailscale` (router), `disko` +
`sops-nix` (servarr).

## Not this skill

Read-only router ops queries (DHCP leases, NAT, conntrack) -> `eaves`.
Compose stacks running ON these hosts -> `composer` /
`infrastructure-stack`. Switch/VLAN config -> `xikectl`. ZFS/NAS storage
policy -> the servarr repo's own docs. SSH transport/tailnet -> `tailscale-homelab`.
