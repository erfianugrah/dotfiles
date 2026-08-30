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

**A monorepo was tried and rejected the same day (2026-08-26).** Almost
nothing in these configs is reusable - hearth's `iot.nix` is 2266 lines of HA
templates/dashboards, the router's value is nftables/kea/VLANs, servarr's is
ZFS/disko/nvidia. `nixpkgs.follows` also dissolves the shared-lock blocker:
the router keeps the commit it pins for a no-op closure diff, and per-host
inputs (`eaves`, `nixpkgs-tailscale`, `disko`, `sops-nix`) stay put. Per-host
skew becomes the feature - the Pi wanting a CLI tool cannot drag the router
into a rebuild.

**Adoption status**: hearth DONE (2026-08-26, verified live: 0 failed units,
HA+ESPHome 200, zsh is the login shell). router DONE (2026-08-28, `shell`
profile only - hosts import base/admin/net as subset; router's inline
fleet-lite `systemPackages` copy removed, router/network/debug + lazydocker
stay inline). Router-side fleet access uses a THIRD router-side deploy key
(`/root/.ssh/id_gh_fleet` + `gh-fleet` Host alias), mirroring the eaves
pattern - the fleet repo stays private. servarr pending, on its own schedule.

Fleet-repo commands: `make check` (eval both arches), **`make cache`**
(aarch64 substitute check - run this whenever `shell.nix` gains a package),
`make attrs`, `make fmt`.

### Tailnet profile (2026-08-30)

The `tailnet` profile is the fleet DNS doctrine: knotea resolves, MagicDNS
does not. It sets `services.tailscale.extraSetFlags = [ "--accept-dns=false" ]`
on every host, pins `networking.nameservers = [ "10.0.10.5" ]` (knotea on the
router), and writes an /etc/hosts entry for every tailnet node (name +
FQDN) so MagicDNS-only names still resolve without MagicDNS. New tailnet
devices are a one-line addition to `fleet.tailnet.nodes`.

Why: `tailscaled` with `accept-dns=true` (the default) rewrites
`/etc/resolv.conf` to 100.100.100.100, bypassing knotea's 44 split-horizon
erfi.io overrides. On servarr this meant arrs connected to public Cloudflare
IPs instead of the edge Caddy (10.0.10.1). The profile pairs with knotea
1.4.9's split-horizon NODATA fix (AAAA queries for local-A-only names
return NODATA instead of leaking the public CDN AAAA).

Docker on servarr additionally pins `daemon.settings.dns = [ "10.0.10.5" ]`
(servarr-nixos `modules/docker.nix`) because Docker's embedded DNS
(127.0.0.11) caches the host resolver at daemon start - a post-boot
resolv.conf change leaves containers forwarding to the stale resolver.

### Adoption gotchas (all paid for on hearth)

- **`nixos-rebuild` runs as root**, so a `git+ssh` input needs the `gh-fleet`
  alias in `/root/.ssh/config`, not just the login user's. First deploy died
  on `Could not resolve hostname gh-fleet`.
- **GitHub deploy keys are unique per repo** - a host with a key for its own
  repo needs a SECOND key for nixos-fleet.
- **Use `lib.mkDefault`** for anything a host may tighten (hearth sets
  `PermitRootLogin = "no"` over the profile; otherwise it is a conflict).
- **aarch64 source-builds are a real gate.** `glances` 4.5.5 has no aarch64
  substitute, so the Pi compiled it and its test suite failed (14 failures),
  killing `nixos-rebuild` - while `nix flake check`, both eval arches AND a
  whole-host eval were green. Arch inventory: x86_64 = router + servarr,
  aarch64 = hearth + RK1 nodes; both permanent.
- **Eval cannot catch a wrong package attr**: `git-delta` evaluates fine in a
  list, fails at build. The attr is `delta`. Nor can it catch
  `programs.zsh.package` (does not exist - use `users.defaultUserShell`),
  though that one at least fails at eval.

### Dotfiles on an adopted host

The `shell` profile ships BINARIES; config comes from `~/dotfiles` cloned on
the host. Two traps, both hit on hearth 2026-08-26:

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
policy -> the servarr repo's own docs. SSH transport/tailnet -> `tailscale-homelab`.
