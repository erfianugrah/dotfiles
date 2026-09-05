# knot-dns reference - bare-knotd deploy tree + Cloudflare -> Knot migration

Copy-paste material condensed from `~/infra/knotea/authority/deploy/knot-only/`
(the historical standalone-knotd Fly deploy) and
`~/infra/knotea/authority/docs/runbooks/cf-to-knot-migration.md`. The live
authority is the merged knotea binary (see SKILL.md); these files still
document the TSIG / ACL / confdb pattern the live confdb inherited, and the
migration playbook is what you follow to move another zone off Cloudflare.

## fly.toml - the bare-knotd shape

`deploy/knot-only/fly.toml`. Two ports, no PROXY protocol on TCP. Knot's
`proxy-allowlist` is UDP-only; PROXY-v2 framing on TCP closes the connection
immediately. (The live knotea app terminates PROXY itself and proxies inward,
so this limitation only applies to a bare knotd app.)

```toml
app = "<knot-app>"
primary_region = "<region>"

[build]
  dockerfile = "Dockerfile.knot"

[[services]]
  internal_port = 53
  protocol = "udp"
  [[services.ports]]
    port = 53

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

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

## Dockerfile.knot

```dockerfile
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

The `cznic/knot` image has `runuser` (util-linux), not `su-exec` or `gosu`.
The live knotea image builds Knot from source instead (`ARG KNOT_VERSION` in
`~/infra/knotea/Dockerfile`).

## Entrypoint - confdb mode

```bash
# deploy/knot-only/docker-entrypoint.sh - abridged
set -eu
STORAGE=/var/lib/knot-fly
TPL=/etc/knot/knot.conf.template
CONF="$STORAGE/knot.conf"
CONFDB="$STORAGE/confdb"

# Fly volumes mount root:0755. Knot UID is 53. Without this chown the daemon
# cannot create journal/timers/zones subdirs and knotc returns
# "operation not permitted".
if [ "$(stat -c '%u' "$STORAGE")" != "53" ]; then
    chown knot:knot "$STORAGE"
fi

# Render template -> seed. sed with | delimiter so base64 + and / are safe.
# Re-render only on first boot OR if the existing seed fails conf-check.
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
    runuser -u knot -- knotc -C "$CONFDB" conf-import "$CONF"
fi

# Compile-time storage path on cznic/knot is /storage. Symlink so bare knotc
# (no -C) works from `fly ssh console`.
mkdir -p /storage && ln -sfn "$CONFDB" /storage/confdb

exec knotd -C "$CONFDB"
```

## knot.conf template - keys, ACLs, templates

Zones are NOT in the template; they are operator state added at runtime.

```yaml
server:
    listen: [ "0.0.0.0@53", "::@53" ]
    rundir:  "/run/knot"
    user:    "knot:knot"
    answer-rotation: on
    automatic-acl:   off
    edns-client-subnet: off
    nsid: "<knot-app>"

# Knot 3.4+ moved storage into its own section; server.storage is rejected
# with "invalid item" on 3.5.
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
    # Journal-only persistence: zonefile-load: none means no out-of-band
    # edits, journal IS truth.
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

The live confdb additionally holds the `knotctl.` key + `knotctl_update` ACL,
the `knotea-auto` DNSSEC policy, and the `parent_loopback` ds-push remote -
see `~/infra/knotea/authority/AGENTS.md`.

## Zone bootstrap - knotc two-step protocol

```bash
# Inside the machine. Wrap multi-statement edits in conf-begin/commit.
knotc conf-begin
knotc conf-set   "zone[lab.erfi.io]"                  # step 1: bare id
knotc conf-set   "zone[lab.erfi.io].template" default # step 2: attributes
knotc conf-commit

knotc zone-begin   lab.erfi.io
knotc zone-set     lab.erfi.io @ 3600 SOA "ns1.lab.erfi.io. admin.lab.erfi.io. $(date +%s) 86400 900 691200 3600"
knotc zone-set     lab.erfi.io @ 3600 NS  "ns1.lab.erfi.io."
knotc zone-commit  lab.erfi.io
```

From the dev box: `cd ~/infra/knotea/authority/deploy/knot-only && make bootstrap-zone ZONE=<zone> NS_FQDN=ns1.<zone>`.
SOA serial defaults to `$(date +%s)`.

## nsupdate smoke of the TSIG path

```bash
ZONE=lab.erfi.io
printf 'server %s\nzone %s\nupdate add _acme-challenge.smoke.%s 60 TXT "hi"\nsend\n' \
    137.66.1.170 "$ZONE" "$ZONE" \
  | nsupdate -y "hmac-sha256:caddy-acme.:$TSIG_CADDY_ACME"
dig @137.66.1.170 _acme-challenge.smoke.$ZONE TXT +short
```

Key name in `-y` includes the trailing dot; algorithm separator is `:`.
`nsupdate -y` puts the secret on argv - prefer `knotctl` for anything you
run more than once.

## Cloudflare -> Knot migration via outgoing AXFR

Zone lives at CF (Enterprise - free/pro cannot push outgoing AXFR); you want a
hidden Knot mirror to validate before flipping NS.

```bash
export CLOUDFLARE_API_TOKEN=...   # by var reference, never printed
cd ~/infra/knotea/authority/deploy/knot-only
./scripts/cf-axfr-setup.sh <zone>
```

What the script does (idempotent on re-run):

1. Pulls the live CF anycast CIDR list from the CF API `ips` endpoint (see the
   script header for the exact URL). Do not hardcode this list.
2. Creates a TSIG on the CF account (`POST /accounts/{aid}/secondary_dns/tsigs`)
   or reuses by name. The secret is captured once at create time and persisted
   to the operator env file (mode 0600). Lose it -> recreate the TSIG.
3. Creates a CF peer (`POST /accounts/{aid}/secondary_dns/peers`) pointing at
   the Knot anycast v4, linked to that TSIG.
4. `knotc conf-set` adds the TSIG, `remote[cloudflare]` (CF transfer-out IP
   `172.65.64.6@53`), an ACL for incoming NOTIFY, and registers the zone with
   `template: secondary` + `master: cloudflare`.
5. `POST /zones/{zid}/secondary_dns/outgoing` links peer -> zone, `/enable`,
   `/force_notify`.
6. Polls `dig @knot SOA <zone>` against `dig @1.1.1.1 SOA <zone>` until serials
   match (up to 90 s).

### NOTIFY source IPs - the documented list is wrong

CF documents a short list of outbound NOTIFY sources; real NOTIFYs arrive from
CF's full anycast ranges (e.g. `104.16.0.0/13`) and, through Fly's edge proxy,
from `172.16.x.x`. Symptom: Knot logs `ACL, denied, action notify`; the zone
falls behind CF until the next SOA-refresh AXFR (~3 h on CF defaults).

The fix is what `cf-axfr-setup.sh` does: fetch the CF v4 + v6 CIDR lists at
run time, append the Fly internal CIDRs `172.16.0.0/12` and `fdaa::/16`, and
pass all of them to `acl[cf_axfr_in].address`. TSIG is the real gate; the IP
filter is belt-and-suspenders.

### Validation diffs

CF refuses `ANY` (RFC 8482); diff by type:

```bash
for t in A AAAA MX TXT NS SOA CNAME CAA SRV; do
    diff <(dig @137.66.1.170 $t <zone> +noall +answer) \
         <(dig @1.1.1.1      $t <zone> +noall +answer)
done
```

- Initial AXFR returns `BADKEY` for ~30 s after `outgoing/enable` - transient,
  Knot retries.
- CF ships proxied Worker Custom Domains as `AAAA 100::` placeholders. After
  promotion, overlay real CF edge IPs (`104.18.0.74`, `104.18.1.74`,
  `2606:4700::6812:4a`, `2606:4700::6812:14a`). Tunnel CNAMEs
  (`*.cfargotunnel.com`) come through fine.
- CF's AXFR-out flattens CNAMEs to A/AAAA at the edge. Compare by resolved
  content, not record type.

## The NS-swap dance

Reversible up to Phase C.

### Phase A - prep

1. Verify sync faithfulness (`knotc zone-read <zone>` vs
   `GET /zones/{zid}/dns_records`, by resolved content).
2. Clean vestigial NS records inside the zone at CF (registrar-default
   leftovers). Deletion propagating to Knot via IXFR proves bidirectional sync.
3. Identify current parent delegation via `whois -h whois.nic.<tld>`.
4. Pre-lower the zone's NS TTL at CF if high; wait for the old TTL to expire.
   `.io` zones at CF default to 3600 s.
5. Set up outgoing AXFR from Knot (`axfr-out.` TSIG + `axfr_out` ACL) so
   future secondaries can mirror.

### Phase B - flip Knot to primary

```bash
fly ssh console -a glory-hole -C "sh -c '
knotc conf-begin
knotc conf-set zone[<zone>].template default
knotc conf-unset zone[<zone>].master
knotc conf-unset zone[<zone>].acl cf_axfr_in
knotc conf-set zone[<zone>].acl acme_update
knotc conf-set zone[<zone>].acl ddns_update
knotc conf-commit
'"
```

Disable CF outgoing first (`POST /zones/{zid}/secondary_dns/outgoing/disable`).
CF keeps serving its copy until the registry NS swaps.

### Phase C - registry NS swap

- In-bailiwick + glue (erfi.io pattern): NS = `ns1.<zone>` / `ns2.<zone>`,
  A glue at the registrar pointing at the anycast IP; the zone must contain
  matching A records.
- Out-of-bailiwick: NS names in a different zone you control; no glue.

Soak the parent NS TTL (3600 s on `.io`, 86400 s on `.com` / `.dev`). Then
decide CF's role: drop the zone, or keep CF as a Knot secondary via an
AXFR-out TSIG.

## Caddy site block: dns cloudflare -> dns rfc2136

```caddyfile
# Before
foo.erfi.io {
    import tls_config            # snippet using dns cloudflare {$CF_API_TOKEN}
}

# After
foo.erfi.io {
    tls {
        issuer acme {
            dns rfc2136 {
                key_name "caddy-acme."
                key_alg  "hmac-sha256"
                key      {$TSIG_CADDY_ACME}
                server   "137.66.1.170:53"
            }
            propagation_delay 30s
            resolvers 137.66.1.170
        }
    }
}
```
