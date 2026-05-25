---
name: tailscale-homelab
description: SSH into and operate the user's tailscale-routed homelab — a primary Unraid server (alias `servarr`), site routers, OOB management, ARM SBC compute, edge devices. Covers the per-host identity-file convention (`IdentitiesOnly yes` is load-bearing), the dual `10.0.X.Y` / `10.68.X.Y` alias pattern for primary/backup site-to-site paths, magic-DNS vs IP fallback, subnet router behaviour, exit-node ACL `via:` grants, ssh failure-mode diagnostic order, and the `ssh servarr 'docker exec / docker logs / docker restart'` operator idiom that runs almost everything else in the homelab. Use whenever you need to reach a homelab host, debug a tailscale connectivity issue, or write a remote operation script. Sibling to every other infrastructure skill — `caddy`, `composer`, `infrastructure-stack`, `knot-dns`, and `gloryhole` all assume `ssh <alias>` works.
---

# tailscale-homelab — operate the user's homelab over tailscale

The user's homelab is a multi-site mesh stitched together by **Tailscale**. Canonical access: `ssh <alias>`, where `~/.ssh/config` pins one identity file per host class.

**Source of truth: `~/.ssh/config`** + live `tailscale status`. This skill is the operating convention layer; don't hard-code the live inventory here.

## Topology — sites and roles

Two physical sites stitched together by site routers running IPsec/GRE and advertising LAN subnets into the tailnet:

| Role | Notes |
|---|---|
| `servarr` (primary host) | Unraid server. Runs ~12 Docker Compose stacks managed by `composer` (GitOps). Hosts Caddy (`network_mode: host`), media stack, Authelia, Immich, Vaultwarden, Keycloak, Gitea, MinIO. Origin host for ACME renewals against the off-site Knot DNS. |
| Site routers (×2) | IPsec/GRE site-to-site, plus tailscale subnet advertisement. One site has the public IP. |
| OOB management | PiKVMs — recovery when SSH/network is dead. |
| SBC cluster | ARM compute modules + BMC. |
| Edge devices | Standalone SBCs, travel routers, Proxmox host + VMs. |

Resolve actual aliases from `~/.ssh/config`; the LLM should `grep Host ~/.ssh/config` to enumerate, not hard-code.

Subnet conventions:

| Range | Role |
|---|---|
| `10.0.X.0/24` (per-site) | Primary LAN view; site-A advertises its `/24` via its router |
| `10.68.X.0/24` (per-site) | Same LAN as advertised by the *other* peer's IPsec tunnel — backup path |
| `100.64.0.0/10` | Tailscale CGNAT range; raw `100.x` only as a last-resort fallback |

The dual `10.0.X.Y` / `10.68.X.Y` alias on every Host block is intentional: a single SSH alias works whichever path is healthy. If the `10.0.X.Y` address fails but the `10.68.X.Y` does not, the primary IPsec tunnel is down and you're cross-tunneling.

## Identity files — the convention

One private key per **host class**, named `~/.ssh/id_<role>` (no shared agent key). The global `Host *` block enforces:

```
IdentitiesOnly yes
```

This is **load-bearing** — without it `ssh-agent` shotguns every loaded key at every host and trips MaxAuthTries. Don't `ssh-add` extra keys hoping it'll work; the agent is intentionally muted.

Naming patterns observed:

- `_2` suffix indicates a key rotation — `id_servarr_2`, `id_vyos_2` — the unsuffixed predecessors are retired.
- Shared key across a hardware family is fine — one key per SBC cluster, used by the BMC and every compute module behind it.
- Hardware-tagged names (e.g. `id_<device-codename>`) preferred over role-tagged where the device is unique.

## Primary host (`servarr`) — the operator surface

The user almost never logs in interactively. Pattern is `ssh servarr '<one-liner>'`:

```bash
# Container ops
ssh servarr 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | head -40'
ssh servarr 'docker logs <svc> --since 5m 2>&1 | tail -50'
ssh servarr 'docker restart <svc>'
ssh servarr 'docker exec <svc> <cmd>'

# File ops on Unraid host (data lives under /mnt/user/data/<svc>/)
ssh servarr 'mkdir -p /mnt/user/data/<svc>/<dir>'
ssh servarr 'cat /mnt/user/data/<svc>/<file>'

# Composer-managed restart (decrypts SOPS) — for stacks that have SOPS env
make -C ~/ergo/<svc>-compose restart                  # NOT restart-<svc>
```

The `make restart` vs `restart-<svc>` distinction is critical and lives in the `caddy` and `composer` skills. Don't recreate-via-`docker restart` a container whose `.env` is SOPS-managed unless you know its env is already plaintext in memory.

For other hosts (site routers, PiKVMs, SBCs) the user drops into an interactive shell — these are config-by-CLI devices, not script targets.

## Tailscale CLI — the minimum useful set

```bash
tailscale status                  # one line per peer + relay/direct indicator
tailscale status --peers          # peer-only view
tailscale status --json | jq      # for scripting
tailscale ip -4                   # self IPv4 in 100.x range
tailscale ip -4 <peer>            # peer IPv4 in 100.x range (magic-DNS resolved)
tailscale ping <peer>             # like ICMP ping but reports DERP-relay vs direct
tailscale netcheck                # diagnose local NAT + DERP reachability
tailscale dns status              # MagicDNS state
tailscale bugreport               # shareable diagnostic blob for support
tailscale whois <100.x.y.z>       # identify a device by tailscale IP
tailscale debug derp-map          # list DERP relays
```

State / membership:

```bash
sudo tailscale up                                 # bring up with current prefs
sudo tailscale down                               # disconnect (keeps node registered)
sudo tailscale logout                             # remove node from tailnet
sudo tailscale up --reset                         # reset unspecified prefs to default
sudo tailscale up --ssh                           # accept incoming Tailscale SSH
sudo tailscale up --accept-routes                 # accept advertised subnet routes
sudo tailscale up --accept-dns=false              # disable MagicDNS (rarely correct)
sudo tailscale up --advertise-routes=10.0.X.0/24  # become a subnet router (subject to admin approval)
sudo tailscale up --advertise-exit-node           # offer this node as exit (subject to admin approval)
```

Subnet-router prerequisite on Linux: enable IP forwarding (`net.ipv4.ip_forward=1`, `net.ipv6.conf.all.forwarding=1` in sysctl). Skip this and exit-node / subnet-router silently fail.

## MagicDNS — the quick rules

- The magic resolver is **`100.100.100.100`**. MagicDNS proxies DNS through tailscaled and answers names in the tailnet domain (`*.<your-tailnet>.ts.net`). Find yours with `tailscale status --json | jq -r .MagicDNSSuffix`.
- `nslookup` on some platforms bypasses the system resolver and queries the system DNS server directly — it returns **incorrect** results for split-DNS / MagicDNS. Use `dig` or `tailscale dns query` for honest diagnostics.
- On Ubuntu / systemd-resolved, tailscale rewrites `/etc/resolv.conf`. If `/etc/resolv.conf` is being clobbered or pointing only at `127.0.0.53`, that's the intended behaviour — diagnose with `resolvectl status`.
- Split-DNS lets you point specific suffixes at internal resolvers (e.g. `*.vyos1.lan` → an internal nameserver behind a subnet router). Configure in the admin console DNS tab.

## ACLs — exit-node and subnet-router patterns

The user's tailnet uses **Grants** (newer ACL syntax). The relevant ACL idioms:

```hujson
// Allow members to use the internet via any exit node tagged tag:vpn
{
  "src": ["autogroup:member"],
  "dst": ["autogroup:internet:*"],
  "via": ["tag:vpn"],
  "ip": ["*"]
}
```

- `autogroup:internet` resolves to public IP space (excludes RFC 1918, CGNAT, link-local). It does NOT mean "everything"; an ACL that grants `autogroup:internet` does not grant access to other tailnet members.
- `via: [...]` restricts which exit nodes / subnet routers a source may use. Without `via:`, an exit-node grant defaults to "any exit node visible to the source".
- Subnet routes must be **approved in the admin console** after a node advertises them. `tailscale status | grep offers` shows advertised-but-unapproved routes.
- For SaaS allowlisting where the SaaS wants a specific egress IP: prefer a **subnet router with `--advertise-routes=<saas-ip>/32`** over an exit node. ACLs then control access to that `/32` cleanly; exit-node ACLs are coarse-grained.

## Failure-mode diagnostic order

When `ssh <alias>` fails, work cheapest probes first:

1. **Alias mapped?** `grep -A2 "Host $HOST" ~/.ssh/config`. If absent, use `<host>.<your-tailnet>.ts.net` directly or add a Host block.
2. **Tailscale up locally?** `tailscale status` — if it says `Tailscale is stopped`, that's the problem. `sudo tailscale up`.
3. **Peer online?** `tailscale status | grep $HOST` — `offline` means the peer is down. `idle` is fine. `-` (no last-seen) = never connected.
4. **MagicDNS resolving?** `tailscale ip -4 $HOST` should return a `100.x` IP. If not, MagicDNS is off — use the LAN `10.0.x.y` IP directly.
5. **Wrong key offered?** `ssh -v $HOST 2>&1 | grep -E 'Offering|Authentications'`. `IdentitiesOnly yes` means only the pinned key is offered. Fix the `Host` block; don't `ssh-add` more keys.
6. **Permission denied (publickey) with the right key?** Permissions: `ls -la ~/.ssh/id_<role>` must be `0600`. If just rotated (`_2` suffix), the new pubkey may not be in `authorized_keys` yet — escalate to PiKVM for OOB recovery.
7. **Primary LAN path dead?** Try the `10.68.x.x` alias listed in the same Host block — that's the cross-site IPsec backup.
8. **Tailnet partition?** `tailscale ping $HOST` — if it can't establish even a relay path, suspect the control plane (`login.tailscale.com`) or a firewall blocking DERP. `tailscale netcheck` for local diagnosis.
9. **Servarr-only: ssh works but `docker ps` hangs?** Unraid host is in a bad state — reboot via PiKVM is the standard escalation. Check `~/servarr-compose/AGENTS.md` for the last hang post-mortem before doing anything destructive.

Order matters: 1-2 are local, 3-4 are tailnet API, 5-6 require touching the remote host, 7-8 escalate to network plumbing, 9 is hardware. Don't skip ahead.

## Tailscale-specific gotchas

1. **MagicDNS off → magic FQDNs don't resolve**, but tailscale IPs still work. `--accept-dns=true` is the default; verify with `tailscale dns status`.
2. **`/etc/resolv.conf` overwriting on Ubuntu/Debian** is intended. If something else expected to own resolv.conf (e.g. NetworkManager) is fighting tailscale, you get DNS flapping. Use `resolvectl status` to see who's winning.
3. **Subnet router needs IP forwarding** at the kernel level *and* admin-console approval. Both. Either one missing = silent failure.
4. **`tailscale up` without flags resets unspecified prefs to default** — pass every flag you want preserved each time, or rely on `--reset` only when you mean it.
5. **`ssh -o ProxyCommand='tailscale nc %h %p'`** is the userspace-tailscale workaround — useful in CI runners and ephemeral containers where you can't install the full client. Slower than direct.
6. **DERP-relay use is a red flag for direct-connection failure**. `tailscale ping` reports `via DERP` instead of `via 100.x.y.z:port`. Diagnose with `tailscale netcheck` — usually a strict-NAT or firewall issue at one end.
7. **Quarantined nodes (shared from other tailnets, including Mullvad exit nodes) cannot establish inbound connections.** Use `autogroup:danger-all` cautiously — it includes them.
8. **Pre-auth keys (`tskey-auth-*`) are scoped + expiring** — generate per-fleet in the admin console with appropriate tags. Don't bake long-lived keys into images.

## Cross-references

- **`caddy` skill** — every `ssh servarr 'docker ...'` recipe assumes this works.
- **`composer` skill** — same; the deployment platform lives on `servarr`.
- **`knot-dns` skill** — Knot runs on Fly, not on the homelab, but the homelab Caddy is the cert-consuming downstream.
- **`gloryhole` skill** — home profile runs on the homelab; uses VyOS as upstream resolver.
- **`infrastructure-stack` skill** — bridge subnet conventions, compose patterns on `servarr`.

## See also

- `~/.ssh/config` — host inventory + identity-file mapping (authoritative)
- `tailscale status` / `tailscale status --json | jq` — live tailnet state
- `~/servarr-compose/AGENTS.md` — Unraid host conventions
- Tailscale docs (kb): troubleshooting guide, subnet routers, MagicDNS, route filtering with `via`, ACL grants
