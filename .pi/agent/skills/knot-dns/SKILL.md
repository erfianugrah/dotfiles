---
name: knot-dns
description: Deploy self-hosted authoritative DNS — Knot DNS 3.5 on Fly.io anycast, with TSIG-keyed RFC 2136 ACME (Caddy), AXFR/IXFR primary↔secondary, and the Cloudflare → Knot migration path. Covers nameserver choice (Knot vs NSD vs PowerDNS vs CoreDNS), Fly machine sizing and the PROXY-on-TCP-is-broken trap, knotc confdb operations, ACME ACL pattern (the `sub-or-equal` vs `pattern` mismatch for `_acme-challenge`), Namecheap glue + in-bailiwick NS, the CF outgoing-AXFR migration (NOTIFY source IPs documented-wrong vs the real anycast list, Fly edge NAT rewriting source to 172.16.x), TTL pre-lowering, registry NS swap timing per TLD, and the post-migration Caddy `dns cloudflare` → `dns rfc2136` cutover. Sibling to `fly`, `cloudflare`, `infrastructure-stack`, `gloryhole`, and `knotctl`. Reference deployment source lives at `~/knotea/authority/deploy/knot-only/` (legacy `~/knot-fly/deploy/knot-only/` feeds live `knot-fly-mvp` until P6).
---

# knot-dns — authoritative DNS on Fly

> **knotea merge (2026-06-16)** — knot-fly is being merged with `glory-hole`
> (recursive resolver) into a single supervised binary, `knotea`. The monorepo
> lives at `~/knotea/` with knot-fly under **`~/knotea/authority/`** and
> glory-hole under `~/knotea/resolver/`. The monorepo is the canonical source
> tree; the legacy `~/knot-fly/` checkout and live `knot-fly-mvp` Fly app (fra)
> remain in service until the P6 deployment cutover. Plan:
> `~/knotea/docs/plans/2026-06-16-knotea-merge.md`. Post-merge,
> knotd no longer binds public `:53` — it runs loopback-only on `127.0.0.1:5354`
> and knotea owns the public sockets, proxying RFC 2136 UPDATE + AXFR inward.
> This resolves the PROXY-on-TCP limitation (gotcha #2) and the UDP hairpin
> SERVFAIL (gotcha #24) by co-location. The Namecheap glue re-registration to
> knotea's new anycast IP is the one irreversible-until-TTL cutover step (plan §5).

The reference deployment source is `~/knotea/authority/deploy/knot-only/` — the former `~/knot-fly/deploy/knot-only/` tree. The live `knot-fly-mvp` app in `fra` keeps serving from the legacy checkout until P6. It runs as the `<your-knot-app>` Fly app in your primary region (single region; secondary-region deferred to Phase 2), serves `<your-zone>` + `lab.<your-zone>`, and issues real Let's Encrypt certs for 36 Caddy sites via `dns rfc2136`. Every snippet below mirrors that working tree. Read `~/knotea/authority/AGENTS.md` for the canonical gotcha list this skill condenses.

## Why self-host

Two real wins, one accepted tax:

- **DNS-01 ACME without giving a third party API access to your zones.** Caddy talks TSIG to your own Knot. No `CF_API_TOKEN` in `.env`, no CF rate limits during cert storms.
- **No DNS provider in the critical path.** Fly's edge is the failure domain you already accept for the rest of your stack.
- **Tax**: you now operate a nameserver. Single Fly region = single point of failure for the DNS plane. Plan a second region (another region) before treating it as production.

## Stack choice — Knot

| Server | DNSSEC | Mgmt | RSS | Verdict |
|---|---|---|---|---|
| **Knot DNS** (CZ.NIC) | Online signing with KASP (auto KSK/ZSK roll, NSEC3, CDS/CDNSKEY) | `knotc` control socket, YAML config, confdb (LMDB) | ~30 MB | **Pick this.** What TLDs run on. |
| NSD (NLnet Labs) | Offline only — sign with `ldns-signzone` in CI | Plain zone files | ~15 MB | Pure auth, set-and-forget. No online DDNS. |
| PowerDNS Auth | Online | REST API + `pdnsutil`, DB-backed (SQLite/Postgres) | ~50 MB | Pick if you want REST-first management without writing a shim. |
| CoreDNS | None worth shipping | Caddy-style Corefile | varies | A recursive/forwarder with `file` plugin bolted on. Not authoritative in the production sense. Skip. |

Knot wins for this stack because:

1. `knotc` is a clean control-socket API that maps directly onto a thin Go shim. The shim isn't needed for Workflow 1 (Caddy drives via RFC 2136), only for Phase 1 CF-shaped REST.
2. Online DNSSEC with KASP — point a policy at a zone, key rollover is automatic.
3. Catalog zones + IXFR + NOTIFY work as documented.
4. Pinned base image `cznic/knot:v3.5.4` is multi-arch, ~25 MB, includes `knotd` + `knotc` + `runuser`.

## Fly is the anycast layer

You don't run BGP. Fly's edge announces your app's dedicated v4 + v6 anycast from every PoP. Deploy to N regions, the same `<knot-anycast-ip>` resolves to the closest. Glue at the registrar points at those two IPs.

Two regions is the minimum for "not a single point of failure": one primary, one secondary in a different region pulling via AXFR over Fly's `.internal` mesh. Single anycast IP, two machines, Knot's `master/notify` directives wire them up.

## fly.toml — the shape

`~/knotea/authority/deploy/knot-only/fly.toml`. Two ports, no PROXY protocol on TCP. The PROXY-on-TCP omission is **load-bearing**.

```toml
app = "<your-knot-app>"
primary_region = "<your-primary-region>"

[build]
  dockerfile = "Dockerfile.knot"

# UDP — cannot wear PROXY (no v2 framing on UDP). Fly NATs source so resolver-IP
# analytics on UDP/53 are unreliable. Doesn't matter for an auth server.
[[services]]
  internal_port = 53
  protocol = "udp"
  [[services.ports]]
    port = 53

# TCP — NO `proxy_proto` handler. Knot 3.5's `proxy-allowlist` is UDP-only
# ("TCP is not supported" — https://www.knot-dns.cz/docs/3.5/html/reference.html#proxy-allowlist).
# PROXY-v2 framing on TCP closes the connection immediately. Trade-off:
# TCP/53 + AXFR/IXFR carry Fly edge IPs, not real resolver IPs. TSIG gates writes.
[[services]]
  internal_port = 53
  protocol = "tcp"
  [[services.ports]]
    port = 53
  [[services.tcp_checks]]
    interval = "15s"
    timeout = "2s"
    grace_period = "60s"

[mounts]
  source = "knot_data"
  destination = "/var/lib/knot-fly"

# knotd's RSS is well under 100 MiB for a few zones / a few hundred records.
[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

## Dockerfile.knot (minimal)

```dockerfile
# Bump via: oci_tags cznic/knot --semver --limit 5
ARG KNOT_VERSION=v3.5.4
FROM cznic/knot:${KNOT_VERSION}

COPY knot.conf.template      /etc/knot/knot.conf.template
COPY docker-entrypoint.sh    /usr/local/bin/docker-entrypoint.sh
COPY bootstrap-zone.sh       /usr/local/bin/bootstrap-zone.sh
RUN  chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/bootstrap-zone.sh

VOLUME ["/var/lib/knot-fly"]
EXPOSE 53/udp 53/tcp
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
```

The image has `runuser` (util-linux) — **not** `su-exec` or `gosu`. Use `runuser -u knot --` to drop privileges; the LinuxServer.io conventions don't apply.

## Entrypoint — file mode is a trap, use confdb mode

Knot has two configuration modes. **`knotd -c knot.conf`** (file mode) makes `knotc conf-set` runtime-only — your edits vanish on restart. **`knotd -C /path/to/confdb`** (database mode) persists everything to LMDB. The template is the *seed*; once imported, the confdb is the source of truth.

```bash
# /usr/local/bin/docker-entrypoint.sh — abridged. Full file in
# ~/knotea/authority/deploy/knot-only/docker-entrypoint.sh
set -eu
STORAGE=/var/lib/knot-fly
TPL=/etc/knot/knot.conf.template
CONF="$STORAGE/knot.conf"
CONFDB="$STORAGE/confdb"

# Fly volumes mount root:0755. Knot UID is 53. Without this chown the daemon
# can't create journal/timers/zones subdirs and `knotc` returns
# "operation not permitted" cryptically.
if [ "$(stat -c '%u' "$STORAGE")" != "53" ]; then
    chown knot:knot "$STORAGE"
fi

# Render template → seed. Substitute TSIG secrets from Fly env (sed with `|`
# delimiter so base64 `+`/`/` are safe). Re-render only on first boot OR if
# the existing seed fails knotc conf-check.
if [ ! -f "$CONF" ] || ! knotc -c "$CONF" conf-check >/dev/null 2>&1; then
    : "${TSIG_CADDY_ACME:?}" "${TSIG_CADDY_DDNS:?}" "${TSIG_AXFR_OUT:?}"
    sed -e "s|{{TSIG_CADDY_ACME_SECRET}}|${TSIG_CADDY_ACME}|g" \
        -e "s|{{TSIG_CADDY_DDNS_SECRET}}|${TSIG_CADDY_DDNS}|g" \
        -e "s|{{TSIG_AXFR_OUT_SECRET}}|${TSIG_AXFR_OUT}|g" \
        "$TPL" > "$CONF"
    chown knot:knot "$CONF" && chmod 0640 "$CONF"
fi
unset TSIG_CADDY_ACME TSIG_CADDY_DDNS TSIG_AXFR_OUT   # stay out of /proc/<pid>/environ

# Import once. KNOT_FORCE_REIMPORT=1 wipes the confdb (destroys operator state).
if [ ! -f "$CONFDB/data.mdb" ]; then
    install -d -o knot -g knot -m 0750 "$CONFDB"
    # conf-import must run as `knot` so LMDB files own knot:knot.
    runuser -u knot -- knotc -C "$CONFDB" conf-import "$CONF"
fi

# Compile-time storage path on cznic/knot is /storage. Symlink so bare `knotc`
# (no -C) works from `fly ssh console` for operators.
mkdir -p /storage && ln -sfn "$CONFDB" /storage/confdb

exec knotd -C "$CONFDB"
```

## knot.conf template — keys, ACLs, templates

`~/knotea/authority/deploy/knot-only/knot.conf.template`. Zones are NOT in the template — they're operator state, added at runtime by `bootstrap-zone.sh` or `cf-axfr-setup.sh`. Three TSIG keys: `caddy-acme.` (ACME challenges, narrow ACL), `caddy-ddns.` (general A/AAAA DDNS), `axfr-out.` (outbound transfers to secondaries).

```yaml
server:
    listen: [ "0.0.0.0@53", "::@53" ]
    rundir:  "/run/knot"
    user:    "knot:knot"
    answer-rotation: on
    automatic-acl:   off
    edns-client-subnet: off
    nsid: "<your-knot-app>"
    # NO `proxy-allowlist` — see fly.toml TCP comment.

# Knot 3.4+ split storage into its own section. The OLD `server.storage` path
# is REJECTED with "invalid item" on Knot 3.5.
database:
    storage: "/var/lib/knot-fly"

log:
  - target: stdout
    any: info

key:
  - id: caddy-acme.
    algorithm: hmac-sha256
    secret: "{{TSIG_CADDY_ACME_SECRET}}"
  - id: caddy-ddns.
    algorithm: hmac-sha256
    secret: "{{TSIG_CADDY_DDNS_SECRET}}"
  - id: axfr-out.
    algorithm: hmac-sha256
    secret: "{{TSIG_AXFR_OUT_SECRET}}"

acl:
  # ACME challenge ACL — see "ACME ACL trap" section below.
  - id: acme_update
    address: [ "0.0.0.0/0", "::/0" ]
    action: update
    update-type: [ TXT ]
    key: caddy-acme.
    update-owner: name
    update-owner-match: pattern
    update-owner-name: [ "_acme-challenge", "_acme-challenge.*", "_acme-challenge.*.*" ]

  - id: ddns_update
    address: [ "0.0.0.0/0", "::/0" ]
    action: update
    update-type: [ A, AAAA ]
    key: caddy-ddns.

  - id: axfr_out
    address: [ "0.0.0.0/0", "::/0" ]
    action: transfer
    key: axfr-out.

template:
  - id: default
    storage: "/var/lib/knot-fly/zones"
    file: "%s.zone"
    semantic-checks: on
    # Journal-only persistence: zonefile-load: none means no out-of-band edits,
    # journal IS truth. Matches the "edits only via knotc/DDNS through the
    # running daemon" model.
    journal-content: all
    zonefile-load:   none
    zonefile-sync:   -1
    acl: [ acme_update, ddns_update ]

  - id: secondary
    storage: "/var/lib/knot-fly/zones"
    journal-content: all
    zonefile-load:   none
    zonefile-sync:   -1
```

## ACME ACL trap (the one that bites everyone)

Per RFC 8555 §8.4, the challenge for `host.example.org` is `_acme-challenge.host.example.org`, and for the wildcard `*.example.org` it's `_acme-challenge.example.org`. `_acme-challenge` is the **leftmost** label, not a parent of the challenged name.

This means `update-owner-match: sub-or-equal` with `update-owner-name: ["_acme-challenge"]` does NOT match — those names aren't DNS-tree subdomains of `_acme-challenge.<zone>`, they're siblings under different parents. Caddy returns syntactically-valid TSIG-signed updates that Knot rejects with `NOTAUTH`.

The fix is `pattern` mode with explicit per-depth entries — each `*` matches exactly one label:

```yaml
update-owner: name
update-owner-match: pattern
update-owner-name: [ "_acme-challenge", "_acme-challenge.*", "_acme-challenge.*.*" ]
```

Add more `.*` entries if you issue certs deeper than two levels under the zone.

## Zone bootstrap — `knotc` two-step protocol

`knotc conf-set` requires creating the bare identifier **first**, then attributes. Skipping step 1 yields `error: (invalid identifier)`. Applies to `zone[]`, `key[]`, `acl[]`, `remote[]`, `template[]`.

```bash
# From inside the machine. Wrap every multi-statement edit in conf-begin/commit.
knotc conf-begin
knotc conf-set   "zone[lab.<your-zone>]"                  # step 1: bare id
knotc conf-set   "zone[lab.<your-zone>].template" default # step 2: attributes
knotc conf-commit

knotc zone-begin   lab.<your-zone>
knotc zone-set     lab.<your-zone> @ 3600 SOA "ns1.lab.<your-zone>. admin.lab.<your-zone>. $(date +%s) 86400 900 691200 3600"
knotc zone-set     lab.<your-zone> @ 3600 NS  "ns1.lab.<your-zone>."
knotc zone-commit  lab.<your-zone>
```

From your dev box via the `~/knotea/authority/deploy/knot-only/Makefile`:

```bash
cd ~/knotea/authority/deploy/knot-only
make bootstrap-zone ZONE=lab.<your-zone> NS_FQDN=ns1.lab.<your-zone>
```

SOA serial defaults to `$(date +%s)`. **Once committed, the semantic-check at `zone-commit` is hard-coded and ignores `template[].semantic-checks: off`** — see foot-gun #11. Pick a serial scheme you can live with.

## Caddy RFC 2136 — the ACME path

Add the provider to your Caddy build (`~/ergo/caddy-compose/Dockerfile`):

```dockerfile
--with github.com/caddy-dns/cloudflare@v0.2.3 \
--with github.com/caddy-dns/rfc2136@v1.0.0 \
```

Site block (the working `test.lab.<your-zone>` template):

```caddyfile
test.lab.<your-zone> {
    tls {
        issuer acme {
            dns rfc2136 {
                key_name "caddy-acme."
                key_alg  "hmac-sha256"
                key      {$TSIG_CADDY_ACME}
                server   "<knot-anycast-ip>:53"
            }
            propagation_delay 30s
            resolvers <knot-anycast-ip>
        }
    }
    respond "knot-fly is authoritative for this name" 200
}
```

`{$TSIG_CADDY_ACME}` must be set in Caddy's `.env` at parse time. **The `rfc2136` module is strict** — unlike `cloudflare`/`route53` it doesn't defer credential validation; it crashes startup with `rfc2136: missing key, at <Caddyfile>:<line>` if the env var is empty. If you hit that, the `.env` is missing the line OR `compose.yaml` doesn't pass it through.

`propagation_delay 30s` + `resolvers <knot-IP>` make Caddy query Knot directly during validation instead of waiting on Let's Encrypt's resolvers to see the TXT through the public path.

## Smoke-test the TSIG path (one-liner)

```bash
KNOTFLY_HOST=<knot-anycast-ip>
ZONE=lab.<your-zone>
printf 'server %s\nzone %s\nupdate add _acme-challenge.smoke.%s 60 TXT "hi"\nsend\n' \
    "$KNOTFLY_HOST" "$ZONE" "$ZONE" \
  | nsupdate -y "hmac-sha256:caddy-acme.:$TSIG_CADDY_ACME"
dig @$KNOTFLY_HOST _acme-challenge.smoke.$ZONE TXT +short
```

Key name in `-y` includes the trailing dot. Algorithm separator is `:`, not `-`.

## Glue + NS at Namecheap (the in-bailiwick pattern)

For zone `<zone>` served by your Fly app:

1. **Register host glue at the registrar.** Namecheap → Domain List → Manage → Advanced DNS → Personal DNS Server. Add `ns1` and `ns2` (or `ns1` + `ns2` of a different bailiwick) pointing at the Fly v4 anycast IP. Namecheap requires two glue names per domain. The same IP for both is acceptable as long as the names differ — `ns1.<zone>` and `ns2.<zone>` both → `<knot-anycast-ip>`.
2. **Set NS at the registrar.** Domain → Nameservers → Custom DNS → `ns1.<zone>`, `ns2.<zone>`.
3. **Put matching in-zone A records** for `ns1` and `ns2` inside the zone served by Knot. The zone is self-referential by design (in-bailiwick) — without these, recursive resolvers can't validate the delegation.

TLD propagation timing (real-world from 2026-05-24):

| Visible at | Time after Save |
|---|---|
| Namecheap UI confirmation | T+0 |
| `whois -h whois.nic.<tld>` | T+~1 min |
| `dig @a0.nic.io <zone> NS` AUTHORITY section | T+~15 min |
| Google `8.8.8.8`, Quad9 `9.9.9.9` | T+~15 min |
| Cloudflare `1.1.1.1` | bound by previous NS TTL (often longer than expected) |

**Gotcha**: `dig +short @<tld-ns> NS <zone>` returns EMPTY. TLD nameservers answer with `AUTHORITY` + `ADDITIONAL` (delegation + glue), not `ANSWER`, and `+short` only prints `ANSWER`. Use `dig +noall +authority +additional @a0.nic.<tld> <zone> NS` to actually see delegation state.

## CF → Knot migration via outgoing AXFR

Zone already lives at CF (Enterprise), you want a hidden Knot mirror to validate against before flipping NS. **CF outgoing AXFR requires Enterprise** — free/pro can't push.

One command does the whole bootstrap (`~/knotea/authority/deploy/knot-only/scripts/cf-axfr-setup.sh`):

```bash
export CLOUDFLARE_API_TOKEN=...
cd ~/knotea/authority/deploy/knot-only
./scripts/cf-axfr-setup.sh <your-zone>
```

What it does (idempotent on re-run):

1. Pulls live CF anycast CIDRs from `https://api.cloudflare.com/client/v4/ips`. **Do not hardcode this list.** See NOTIFY foot-gun below.
2. Creates a TSIG on the CF account (`POST /accounts/{aid}/secondary_dns/tsigs`) or reuses by name. Secret is captured **once at create time** and persisted to `~/.<your-knot-app>.env` (mode 0600). Lose it → recreate the TSIG.
3. Creates a CF peer (`POST /accounts/{aid}/secondary_dns/peers`) pointing at the Knot anycast v4, linked to that TSIG.
4. `knotc conf-set` adds the TSIG, `remote[cloudflare]` (CF's transfer-out IP is `172.65.64.6@53`), an ACL for incoming NOTIFY, and registers the zone with `template: secondary` and `master: cloudflare`.
5. `POST /zones/{zid}/secondary_dns/outgoing` links peer → zone, `/enable`, `/force_notify`.
6. Polls `dig @knot SOA <zone>` against `dig @1.1.1.1 SOA <zone>` until serials match (up to 90 s).

### NOTIFY source IPs — the documented list is WRONG

CF's docs list `104.30.167.163`, `104.30.167.173`, `2a09:bac0:1000:c47::/64` as post-Dec 2026 outbound NOTIFY sources. **Verified 2026-05-24 against `<your-zone>`: actual NOTIFYs arrive from CF's full anycast ranges** (e.g. `104.22.242.42` in `104.16.0.0/13`) AND from `172.16.x.x` because Fly's edge proxy relays inbound TCP and rewrites the source IP.

Symptom: Knot logs `ACL, denied, action notify`. NOTIFY/IXFR silently fails. Zone falls behind CF until the next SOA-refresh-interval AXFR (~3h on CF's defaults).

Right answer (what `cf-axfr-setup.sh` does):

```bash
CF_IPS_JSON=$(curl -fsS https://api.cloudflare.com/client/v4/ips)
mapfile -t CF_V4_CIDRS < <(echo "$CF_IPS_JSON" | jq -r '.result.ipv4_cidrs[]')
mapfile -t CF_V6_CIDRS < <(echo "$CF_IPS_JSON" | jq -r '.result.ipv6_cidrs[]')
FLY_INTERNAL_CIDRS=("172.16.0.0/12" "fdaa::/16")
# Pass CF_V4_CIDRS + CF_V6_CIDRS + FLY_INTERNAL_CIDRS to acl[cf_axfr_in].address.
```

TSIG (HMAC-SHA256, 32-byte secret) is the actual identity gate. IP filtering is belt-and-suspenders.

### Initial AXFR returns BADKEY for ~30 s

Transient. After `outgoing/enable`, CF's secondary-dns subsystem needs ~30 s to propagate the peer + TSIG mapping. Knot retries every ~30 s with backoff. Don't roll back on the first failure.

### CF refuses ANY queries (RFC 8482)

When diffing zones during validation, **always use specific record types**:

```bash
# Wrong:
diff <(dig @<knot-anycast-ip> ANY <your-zone> +noall +answer) \
     <(dig @1.1.1.1       ANY <your-zone> +noall +answer)
# Right:
for t in A AAAA MX TXT NS SOA CNAME CAA SRV; do
    diff <(dig @<knot-anycast-ip> $t <your-zone> +noall +answer) \
         <(dig @1.1.1.1       $t <your-zone> +noall +answer)
done
```

### Worker Custom Domain `AAAA 100::` placeholders

CF's outgoing AXFR ships proxied Worker hostnames as `AAAA 100::` placeholders. They don't resolve. After promotion to primary, overlay with real CF edge IPs:

```
104.18.0.74, 104.18.1.74, 2606:4700::6812:4a, 2606:4700::6812:14a
```

CF Tunnel CNAMEs (`*.cfargotunnel.com`) come through fine — they resolve to CF's tunnel anycast regardless of which authoritative server is serving them.

## The NS-swap dance (three phases)

Reversible up to Phase C.

### Phase A — prep (do over multiple sessions)

1. Verify sync faithfulness: `knotc zone-read <zone>` vs `GET /zones/{zid}/dns_records`. CF's AXFR-out flattens CNAMEs to A/AAAA at the edge — wire form differs from API logical form but answers identically. Don't diff naively; compare by resolved content.
2. Clean vestigial NS records inside the zone at CF (e.g. `dns1.registrar-servers.com` leftovers from Namecheap default DNS). Also verifies bidirectional sync — deletion propagates to Knot via IXFR.
3. Identify current parent delegation via `whois -h whois.nic.<tld>`.
4. Pre-lower the zone's NS TTL at CF if it's high (e.g. 1d → 5min). Wait for the old TTL to expire before flipping. Skip if TTL is already low; `.io` zones at CF default to 3600 s.
5. Set up outgoing AXFR from Knot (the `axfr-out.` TSIG + `axfr_out` ACL above) so future secondaries can mirror.

### Phase B — flip Knot to primary (reversible within the daemon)

```bash
fly ssh console -a <your-knot-app> -C "sh -c '
knotc conf-begin
knotc conf-set zone[<your-zone>].template default
knotc conf-unset zone[<your-zone>].master
knotc conf-unset zone[<your-zone>].acl cf_axfr_in
knotc conf-set zone[<your-zone>].acl acme_update
knotc conf-set zone[<your-zone>].acl ddns_update
knotc conf-commit
'"
```

Before committing, disable CF outgoing (`POST /zones/{zid}/secondary_dns/outgoing/disable`) so you stop receiving NOTIFY about CF-side edits you no longer care about. CF keeps serving from its copy until NS swaps at the registry.

### Phase C — registry NS swap (durable after parent TTL)

Two patterns at the registrar:

- **In-bailiwick + glue** (used for `<your-zone>`): NS = `ns1.<zone>` / `ns2.<zone>`, register A glue at the registrar pointing at Knot's anycast IPs. Zone itself must contain matching A records.
- **Out-of-bailiwick**: NS = names in a different zone you control. No glue at the parent.

Soak the parent NS TTL (3600 s on `.io`, 86400 s on `.com` / `.dev` — the upper bound on how long old delegations linger in recursive caches; some caches hold longer).

Once propagation is verified across multiple resolvers, decide CF's role: drop the zone entirely, or keep CF as a Knot-secondary by giving CF an AXFR-out TSIG against Knot.

**Overlap vs full-swap**: the safe path is to add new NS alongside old, verify, then remove. The `<your-zone>` migration on 2026-05-24 was full-swap in one Namecheap edit and worked — Knot was fully sync'd from CF before the flip, glue was pre-registered, and exposure was ~15 min until TLD propagated. For DNSSEC'd zones or high-traffic zones, do overlap.

## Post-migration: Caddy `dns cloudflare` → `dns rfc2136`

**Sites under the migrated zone using `dns cloudflare` for ACME will silently fail renewal once recursive caches expire (~24-48 h).** Mechanism: Caddy writes `_acme-challenge.<host>` TXT to CF; world asks Knot for the challenge because world resolves via the new NS; Knot doesn't have it; cert expires.

Migration recipe per site block (can be done one at a time during the soak window):

```caddyfile
# Before
foo.<your-zone> {
    import tls_config            # snippet using dns cloudflare {$CF_API_TOKEN}
    ...
}

# After
foo.<your-zone> {
    tls {
        issuer acme {
            dns rfc2136 {
                key_name "caddy-acme."
                key_alg  "hmac-sha256"
                key      {$TSIG_CADDY_ACME}
                server   "<knot-anycast-ip>:53"
            }
            propagation_delay 30s
            resolvers <knot-anycast-ip>
        }
    }
    ...
}
```

Caddy renews ~30 days before expiry. Don't put this off; force-renew at least one site early to verify the path works before relying on it.

### Force-renewal recipe (verified 2026-05-24, ~40 s end-to-end)

```bash
HOST=caddy.<your-zone>
CERT_DIR=/mnt/cache/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$HOST

ssh servarr "openssl x509 -in $CERT_DIR/$HOST.crt -noout -dates"
ssh servarr "mkdir -p /tmp/cert-backup && cp -r $CERT_DIR /tmp/cert-backup/"
ssh servarr "rm $CERT_DIR/$HOST.crt $CERT_DIR/$HOST.key $CERT_DIR/$HOST.json"

# CRITICAL: `caddy reload` alone WILL NOT trigger re-issuance — sees JSON
# unchanged and short-circuits; in-memory cert cache stays populated even
# after files are gone. Use `docker restart` to flush the cache, NOT
# `make restart-caddy` — the latter force-recreates and re-reads the
# SOPS-encrypted .env which can crash. See ~/ergo/caddy-compose/AGENTS.md.
ssh servarr "docker restart caddy"

ssh servarr "docker logs --since 1m caddy 2>&1 | grep -iE '$HOST|acme'"
# expect: "obtaining certificate" → "trying to solve challenge" → "authorization finalized"
```

## DNSSEC — when to enable

Per-zone decision. Knot's KASP does online signing — `conf-set 'zone[<zone>].dnssec-signing' on` plus a policy with NSEC3 + automatic KSK/ZSK rollover. Phase 2 territory in `~/knotea/authority/PLAN.md`; not enabled on the MVP yet.

When to enable:

- Public zone where TLS isn't the only trust anchor (e.g. you publish CAA / TLSA / SSHFP records that DNSSEC actually protects).
- Compliance / "we sign everything" posture.

When to skip:

- Personal zones whose records are reachable only via HTTPS-with-CT. DNSSEC adds operational risk (key rollovers, DS coordination with the registrar) for limited additional safety.

Multi-signer transitions (live DNSSEC'd zone moving between providers) is the genuinely-hard variant. `<your-secondary-zone>` and `<your-tertiary-zone>` are still on CF DNSSEC for that reason. Plan an explicit multi-signer window: import the new signer's ZSK into the active zone, dual-signed propagation, swap DS at registrar, retire old signer's ZSK.

## Day-2 operations

```bash
# from your dev box
fly status --app <your-knot-app>
fly logs   --app <your-knot-app>
fly ssh console --app <your-knot-app>                # interactive shell

# inside the machine
knotc status                                       # daemon health
knotc zone-status <zone>                           # serial, role, NOTIFY/AXFR state
knotc zone-read <zone>                             # dump current records
knotc zone-flush <zone>                            # journal → zonefile (won't fire if zonefile-load: none)
knotc conf-read 'key'                              # list TSIG keys (secrets visible — careful)
knotc zone-retransfer <zone>                       # force AXFR from primary (secondary role)

# rotate a TSIG without downtime:
# 1. generate new secret
openssl rand -base64 32
# 2. push as Fly secret (restarts machine; rendered knot.conf on volume is unchanged)
fly secrets set --app <your-knot-app> TSIG_CADDY_ACME='<new>'
# 3. inside the machine
knotc conf-begin
knotc conf-set 'key[caddy-acme.].secret' '<new>'
knotc conf-commit
# 4. update Caddy env and redeploy Caddy
```

## Verification one-liners

```bash
# external auth resolution
dig +short @<knot-anycast-ip> SOA <your-zone>
dig +short SOA <your-zone> @1.1.1.1                    # via public resolver (proves delegation)

# delegation state at TLD (use AUTHORITY section, +short returns empty)
dig +noall +authority +additional @a0.nic.io <your-zone> NS

# AXFR test (requires TSIG)
kdig -y "hmac-sha256:axfr-out.:$TSIG_AXFR_OUT" +tcp @<knot-anycast-ip> <your-zone> AXFR

# trace from root
dig +trace SOA <your-zone>
```

## Foot-guns — the running list

Distilled from `~/knotea/authority/AGENTS.md`. Each is a real failure mode with a real fix.

1. **`server.storage` is invalid in Knot 3.5.** Moved to `database.storage`.
2. **PROXY-on-TCP is unsupported in Knot 3.5.** `proxy-allowlist` is UDP-only. Drop `handlers = ["proxy_proto"]` from fly.toml's TCP service or connections close with "end of file".
3. **`knotc conf-set` is runtime-only in file mode (`-c`).** Always start `knotd -C confdb-dir` for durability.
4. **`conf-import` won't overwrite an existing confdb** without `+force` or wiping first.
5. **`cznic/knot` has no `su-exec` / `gosu`.** Use `runuser -u knot --`.
6. **Fly volumes mount `root:0755`.** Entrypoint must `chown` for UID 53 on first boot or `knotc` returns cryptic EPERMs.
7. **`journal-content: all` + `zonefile-load: none`** is the journal-only primary mode. `difference-no-serial` requires a zonefile you don't write.
8. **`fly ssh console -C "cmd1 && cmd2"` doesn't go through a shell.** Wrap in `sh -c '...'`.
9. **Fly outbound IP ≠ anycast ingress IP.** Outbound NATs through a regional egress. Doesn't matter for TSIG-authed AXFR but matters for IP-allowlist ACLs.
10. **Initial CF AXFR returns `BADKEY` for ~30 s** after `outgoing/enable`. Knot retries; don't roll back on first failure.
11. **CF refuses `ANY` queries (RFC 8482).** Use specific types when diffing.
12. **Worker Custom Domain `AAAA 100::` placeholders.** Overlay with real CF edge IPs after promotion.
13. **`update-owner-match: sub-or-equal` does NOT match ACME challenges.** `_acme-challenge` is the leftmost label, not a parent. Use `pattern` with explicit per-depth entries (see ACL section above).
14. **`caddy-dns/rfc2136` validates `key` at parse time.** Empty `{$TSIG_*}` crashes startup with `rfc2136: missing key`. Other CF / route53 providers defer; rfc2136 doesn't.
15. **CF's documented NOTIFY source IPs are WRONG.** Use the full anycast list from `api.cloudflare.com/client/v4/ips` + Fly internal CIDRs. TSIG is the actual gate.
16. **Adding a TSIG-driven Caddy site is a three-edit change** across `~/.<your-knot-app>.env` (operator-only, 0600), `~/ergo/caddy-compose/.env` (SOPS), and the Caddyfile site block.
17. **`knotc conf-set` requires a two-step protocol for new identifiers.** Bare ID first, attributes second. Skipping yields `error: (invalid identifier)`.
18. **`knotc zone-commit` semantic-check is NOT controlled by `semantic-checks: off`.** Some hard consistency rule always fires. Last-resort recovery: `zone-flush` → `zone-purge +journal +kaspdb +catalog +expired` → re-add zone → re-import records. Drops journal history.
19. **`dig +short @<tld-ns> NS <zone>` returns EMPTY.** TLD delegation lives in AUTHORITY + ADDITIONAL, not ANSWER. Use `dig +noall +authority +additional`.
20. **Post-migration: Caddy `dns cloudflare` sites under the migrated zone silently break at next renewal.** Migrate every site block to `dns rfc2136` within the soak window.
21. **CF outgoing AXFR flattens CNAMEs to resolved A/AAAA at the edge.** Wire form differs from API logical view but answers identically. Compare by resolved content, not record type, when verifying sync.
22. **`knotc zone-unset` / `zone-set` take the RELATIVE owner name, not the FQDN** — even though `zone-read` prints absolute form (`[erfi.io.] gloryhole.erfi.io. 300 CNAME ...`). Passing the FQDN fails with the misleading `error: (no such node in zone found) [zone] owner RTYPE`. The node IS there; the lookup key is wrong. Use `knotc zone-unset erfi.io gloryhole CNAME`, not `knotc zone-unset erfi.io gloryhole.erfi.io CNAME`. `@` is the apex. Note `zone-begin` doesn't validate names — the error only surfaces on the first `zone-set`/`zone-unset` inside the transaction. Abort with `knotc zone-abort <zone>` before retrying.

## Cost

`shared-cpu-1x` / 256 MB / 1 GB volume / 1 region = ~$4/mo on Fly. Anycast IPs are free for the first v4 + first v6 per app. No egress charges at this volume (DNS queries are tiny; AXFRs are infrequent and small).

Two regions for HA doubles VM cost. Volumes are regional — each region needs its own (can't auto-replicate). Knot AXFR over Fly's `.internal` mesh costs nothing.

## See also

- **`fly`** — platform mechanics (volumes, anycast IPs, `fly ssh console -C` quirks, `auto_stop_machines`). DNS apps should NOT auto-stop — first-query cold start breaks resolution.
- **`cloudflare`** — CF Secondary DNS API endpoints (`/secondary_dns/tsigs`, `/secondary_dns/peers`, `/secondary_dns/outgoing`) used by `cf-axfr-setup.sh`. CF anycast IP list at `api.cloudflare.com/client/v4/ips`.
- **`infrastructure-stack`** — the Caddy stack in `~/ergo/caddy-compose/` is the consumer of the TSIG path. Three-edits-at-once rule for adding a TSIG-driven site is in that stack's `AGENTS.md`.
- **`terraform`** — if you ever want to IaC the registrar bits; Namecheap glue + NS records can be managed by `namecheap/namecheap` provider.
- **`~/knotea/authority/AGENTS.md`** — the authoritative gotcha list and live-system state.
- **`~/knotea/authority/docs/runbooks/cf-to-knot-migration.md`** — the full operator playbook with rollback procedures.
- **`~/knotea/authority/PLAN.md`** — Phase 1 Cloudflare-shaped REST API design (not yet implemented as of 2026-05-24).
