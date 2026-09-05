---
name: nixos
description: Use when changing, evaluating, or deploying any of the user's NixOS hosts - router/edge (~/infra/router), hearth/erfipie Pi (~/infra/hearth), servarr NAS (~/infra/servarr-nixos) - or the shared nixos-fleet profile library. Fires on 'deploy the router/NAS/Pi', 'nixos-rebuild', 'flake update', 'add a module to <host>', 'NixOS config', 'fleet profile'. NOT for read-only router ops (eaves), the RK1 cluster (Talos, ~/infra/bombe), compose stacks on the hosts (composer), or ZFS policy (zfs-storage).
---

# NixOS fleet

Three hosts, one set of conventions. The dev box (WSL) is NOT NixOS: it has
`nix` 2.35.2 for **eval only** - single-user, no daemon socket, no
`nixos-rebuild`. Never hunt for `nixos-rebuild` here; every host builds its
own system natively.

## Hosts

| Host | Repo | Flake | Clone on host | Runs as | Gate |
|---|---|---|---|---|---|
| router (MS-01 edge) | `~/infra/router` | `.#router` | `/etc/nixos` | root | `eaves doctor` |
| servarr (NAS, X570D4U) | `~/infra/servarr-nixos` | `.#servarr` | `/etc/nixos` | root | `.pi/check-acceptance.sh` |
| hearth (erfipie, Pi, aarch64) | `~/infra/hearth` | `.#erfipie` | `/home/erfi/hearth` | erfi + sudo | none yet |

Addresses: router `10.0.69.1`, servarr `10.0.71.2`, hearth `10.0.69.7`.

**The turing-pi RK1 cluster is NOT a fleet host.** `~/infra/bombe/docs/research/talos.md`
settled on OpenTofu + `siderolabs/talos`, not NixOS. If that is ever revisited
the upstream flake is `github:GiyoMoon/nixos-turing-rk1` (aarch64-only builds
today - x86_64 cross-compilation unsupported, needs binfmt).

## Deploy - always `make`, never hand-rolled ssh

```bash
cd ~/infra/<repo>
make deploy   # gate -> git push -> host fetch+reset (hearth: pull --ff-only) -> nixos-rebuild switch
make diff     # same but dry-build / dry-activate: no activation
make check    # eval-only smoke (servarr-nixos, hearth; the router repo has `make doctor` instead)
```

Same verbs across the three repos, with two exceptions: the router Makefile has
no `check` (its gate is `eaves doctor`, run after the switch and standalone via
`make doctor`), and hearth's on-host step is `git pull --ff-only` as `erfi` then
`sudo nixos-rebuild`, so a diverged clone stops the deploy instead of being
reset. servarr's `deploy` runs `.pi/check-acceptance.sh` first. `make deploy`
refuses a dirty tree on router and servarr.

The `nixos-rebuild` leg trips the dangerous-cmd-guard `nixos_rebuild` confirm
prompt. That is intended - answer it, don't engineer around it.

## Conventions (each one earned from a real incident)

1. **Declare MTU explicitly, even at the default 1500.** networkd and the
   NixOS activation manage MTU *only when the option is present*. Deleting
   `MTUBytes`/`mtu` does not restore the default - it stops managing the
   value and the last-set MTU lives on the interface forever - a jumbo revert
   once left both router and servarr NICs at 9000+ through green rebuilds
   until a manual `ip link set ... mtu 1500`. Same class of trap applies to
   any "absence means default" option.
2. **The host clone is a cache, never an edit surface.** router and servarr
   deploys `git fetch && git reset --hard origin/main`, so anything edited on
   the box is destroyed silently; hearth's `pull --ff-only` fails instead.
   Source of truth is `origin/main`, always.
3. **Per-host GitHub deploy key, never copied off the host.** Pattern:
   key `id_gh_<host>` + ssh alias `gh-<host>` in that user's `~/.ssh/config`
   + remote `git@gh-<host>:erfianugrah/<repo>.git`. Read-only deploy key
   registered via `gh repo deploy-key add`. Regenerating is ~30s, so these
   are not escrow-worthy; the sops age keys ARE.
   - Verify: `ssh <host> 'ssh -T git@gh-<host>'` -> "successfully authenticated".
   - A remote of plain `git@github.com` is a bug: it works only by
     default-key probing and breaks the moment a second key appears.
4. **Eval before activate.** `make check` locally, or the host's own gate.
   Never let a syntax/type error be discovered by the activation.
5. **Secrets: sops-nix, per-host age key on the box.** No plaintext in any
   repo. Each host's age private key lives only on that host (escrow and
   custody rules: `secret-handling` skill); `.sops.yaml` in the repo lists
   recipients. Key paths are in the host's own module - look there, don't
   hardcode them in notes.

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

## nixos-fleet: a shared LIBRARY, not a monorepo

`~/infra/nixos-fleet` (private GitHub) exports reusable profiles as
`nixosModules`. It owns NO host - no `nixosConfigurations`, no deploy target.
Each host repo keeps its own config, deploy path and nixpkgs pin:

```nix
inputs.fleet = {
  url = "git+ssh://git@gh-fleet/erfianugrah/nixos-fleet";
  inputs.nixpkgs.follows = "nixpkgs";   # profiles build against the HOST's pin
};
modules = [ fleet.nixosModules.default ./configuration.nix ];
# then: fleet.admin.keys = [...]; fleet.admin.rootSsh = true;  # hearth: false
```

Profiles: `base` (tz/locale incl. the en_GB ssh-LANG workaround, nix+gc),
`shell` (zsh+tmux+atuin+direnv+fzf+zoxide+nvim+delta+modern-CLI - BINARIES
only; the stow dotfiles and zinit/omz/p10k/TPM do the rest), `admin` (sshd
key-only, erfi+wheel, opt-in root key backstop, tailscale), `net`
(`fleet.net.defaultMtu` + explicit-MTU doctrine), `tailnet` (DNS doctrine:
`accept-dns=false` on tailscale, knotea 10.0.10.5 as fleet resolver,
/etc/hosts tailnet node map replacing MagicDNS).

**A monorepo was tried and rejected.** Almost
nothing in these configs is reusable - hearth's `iot.nix` is 2266 lines of HA
templates/dashboards, the router's value is nftables/kea/VLANs, servarr's is
ZFS/disko/nvidia. `nixpkgs.follows` also dissolves the shared-lock blocker:
the router keeps the commit it pins for a no-op closure diff, and per-host
inputs (`eaves`, `nixpkgs-tailscale`, `disko`, `sops-nix`) stay put. Per-host
skew becomes the feature - the Pi wanting a CLI tool cannot drag the router
into a rebuild.

**Adoption**: all three hosts import the fleet input. Hosts take profiles as
a subset (router: `shell` only; router/network/debug + lazydocker stay
inline). Each host reaches the private fleet repo with its own extra deploy
key (`/root/.ssh/id_gh_fleet` + `gh-fleet` Host alias, since
`nixos-rebuild` runs as root).

Fleet-repo commands: `make check` (eval both arches), **`make cache`**
(aarch64 substitute check - run this whenever `shell.nix` gains a package),
`make attrs`, `make fmt`.

### Tailnet profile

The `tailnet` profile is the fleet DNS doctrine: knotea resolves, MagicDNS
does not. It sets `services.tailscale.extraSetFlags = [ "--accept-dns=false" ]`
on every host, pins `networking.nameservers = [ "10.0.10.5" ]` (knotea on the
router), and writes an /etc/hosts entry for every tailnet node (name +
FQDN) so MagicDNS-only names still resolve without MagicDNS. New tailnet
devices are a one-line addition to `fleet.tailnet.nodes`.

Why: `tailscaled` with `accept-dns=true` (the default) rewrites
`/etc/resolv.conf` to 100.100.100.100, bypassing knotea's 44 split-horizon
erfi.io overrides. On servarr this meant arrs connected to public Cloudflare
IPs instead of the edge Caddy (10.0.10.1). The profile pairs with knotea's
split-horizon NODATA behaviour (AAAA queries for local-A-only names return
NODATA instead of leaking the public CDN AAAA).

Docker on servarr additionally pins `daemon.settings.dns = [ "10.0.10.5" ]`
(servarr-nixos `modules/docker.nix`) because Docker's embedded DNS
(127.0.0.11) caches the host resolver at daemon start - a post-boot
resolv.conf change leaves containers forwarding to the stale resolver.

### Adoption gotchas

- **`nixos-rebuild` runs as root**, so a `git+ssh` input needs the `gh-fleet`
  alias in `/root/.ssh/config`, not just the login user's. First deploy died
  on `Could not resolve hostname gh-fleet`.
- **GitHub deploy keys are unique per repo** - a host with a key for its own
  repo needs a SECOND key for nixos-fleet.
- **Use `lib.mkDefault`** for anything a host may tighten (hearth sets
  `PermitRootLogin = "no"` over the profile; otherwise it is a conflict).
- **aarch64 source-builds are a real gate.** A package with no aarch64
  substitute gets compiled on the Pi, and a failing upstream test suite then
  kills `nixos-rebuild` - while `nix flake check`, both eval arches AND a
  whole-host eval were green (`make cache` in the fleet repo catches this). Arch inventory: x86_64 = router + servarr,
  aarch64 = hearth + RK1 nodes; both permanent.
- **Eval cannot catch a wrong package attr**: `git-delta` evaluates fine in a
  list, fails at build. The attr is `delta`. Nor can it catch
  `programs.zsh.package` (does not exist - use `users.defaultUserShell`),
  though that one at least fails at eval.

### Dotfiles on an adopted host

The `shell` profile ships BINARIES; config comes from `~/dotfiles` cloned on
the host. Two traps:

- Clone over **https**, not `git@github.com:`. A host's existing keys are
  repo-scoped GitHub DEPLOY keys and cannot be reused for another repo;
  dotfiles is public so no key is needed anyway.
- **Never `stow .` on a fleet host.** dotfiles carries `.ssh`, `.kube`,
  `.gnupg`, `.pi`, `.claude`; stowing `.ssh` replaces the host's real
  `~/.ssh/config` and destroys the `gh-fleet` alias that
  `nix flake update fleet` depends on. Link only `.zshrc .p10k.zsh
  .tmux.conf .vimrc .gitconfig`, then `zsh -i -c exit` once to let zinit
  bootstrap (omz snippets + p10k) and
  `~/.tmux/plugins/tpm/bin/install_plugins` for tmux. Verify afterwards that
  `~/.ssh/config` is still a real file.

## Not this skill

Read-only router ops queries (DHCP leases, NAT, conntrack) -> `eaves`.
Compose stacks running ON these hosts -> `composer` /
`infrastructure-stack`. Switch/VLAN config -> `xikectl`. ZFS/NAS storage
policy -> `zfs-storage`. SSH transport/tailnet -> `tailscale-homelab`.
