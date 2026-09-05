---
name: knot-dns
description: "Use when working on the user's self-hosted authoritative DNS for erfi.io + lab.erfi.io (Knot DNS embedded in knotea on Fly anycast) - knotc confdb operations, TSIG keys and ACLs, RFC 2136 ACME from Caddy, AXFR/IXFR, DNSSEC/KASP and DS at the registrar, glue and NS delegation, or migrating another zone off Cloudflare. Fires on 'knotc', 'authoritative DNS', 'nameserver', 'AXFR/IXFR', 'glue records', 'zone migration', 'NOTAUTH'. NOT for record edits (knotctl) or the resolver (gloryhole)."
---

# knot-dns - authoritative DNS

Live topology: the authority for `erfi.io` + `lab.erfi.io` is the knotea binary on the Fly app `glory-hole` (region `sin`, anycast v4 `137.66.1.170`; `ns1`/`ns2.erfi.io` glue point there). knotd runs loopback-only on `127.0.0.1:5354`; knotea owns the public sockets and proxies RFC 2136 UPDATE + AXFR inward. Source: `~/infra/knotea/authority/` in the `~/infra/knotea` monorepo; the image is the root `~/infra/knotea/Dockerfile`, which builds Knot from source (`ARG KNOT_VERSION`). The predecessor Fly app `knot-fly-mvp` is destroyed. Canonical gotcha list and live state: `~/infra/knotea/authority/AGENTS.md`. The resolver half is the `gloryhole` skill; record edits are the `knotctl` skill.

`~/infra/knotea/authority/deploy/knot-only/` is the historical bare-knotd Fly deploy (the `knot-fly` name comes from it). Its fly.toml, knot.conf template and entrypoint still document the TSIG / ACL / confdb pattern the live confdb inherited. Copy-paste versions of those files plus the Cloudflare -> Knot AXFR migration playbook are in reference.md - read when standing up a new zone, bootstrapping a bare knotd, or migrating a zone off Cloudflare.

## Why self-host

- DNS-01 ACME without giving a third party API access to your zones. Caddy talks TSIG to your own Knot; no CF token in `.env`, no CF rate limits during cert storms.
- No DNS provider in the critical path. Fly's edge is the failure domain you already accept.
- Tax: you operate a nameserver. Single Fly region is a single point of failure for the DNS plane.

## Stack choice - Knot

| Server | DNSSEC | Mgmt | RSS | Verdict |
|---|---|---|---|---|
| Knot DNS (CZ.NIC) | Online signing with KASP (auto KSK/ZSK roll, NSEC3, CDS/CDNSKEY) | `knotc` control socket, YAML config, confdb (LMDB) | ~30 MB | Pick this. What TLDs run on. |
| NSD (NLnet Labs) | Offline only - sign in CI | Plain zone files | ~15 MB | Pure auth, set-and-forget. No online DDNS. |
| PowerDNS Auth | Online | REST API + `pdnsutil`, DB-backed | ~50 MB | Pick if you want REST-first without writing a shim. |
| CoreDNS | None worth shipping | Corefile | varies | A forwarder with `file` bolted on. Skip. |

Knot wins here because `knotc` maps cleanly onto a Go client (`pkg/knot` in authority), KASP signing is automatic once a policy is attached, and catalog zones + IXFR + NOTIFY work as documented. Bump the Knot version in the root Dockerfile's `ARG KNOT_VERSION`.

## Fly is the anycast layer

You do not run BGP. Fly announces the app's dedicated v4 + v6 anycast from every PoP; glue at the registrar points at them. Two regions is the minimum for "not a single point of failure": one primary, one secondary pulling AXFR over Fly's `.internal` mesh. DNS apps must NOT auto-stop (first-query cold start breaks resolution) - see the `fly` skill.

## Config model - confdb, not file mode

Knot has two modes. `knotd -c knot.conf` (file mode) makes `knotc conf-set` runtime-only: edits vanish on restart. `knotd -C <confdb>` (database mode) persists to LMDB. The template is the seed; once imported, the confdb is the source of truth. Consequences:

- Zones, their `dnssec-policy` assignment, the `knotctl.` key and the ds-push remote are operator state in the confdb, not in the template. A confdb wipe loses them together.
- `conf-import` will not overwrite an existing confdb without `+force` or wiping first.
- `knotc conf-set` needs a two-step protocol for new identifiers: bare id first (`conf-set 'zone[x]'`), attributes second. Skipping step 1 yields `error: (invalid identifier)`. Applies to `zone[]`, `key[]`, `acl[]`, `remote[]`, `template[]`. Wrap multi-statement edits in `conf-begin` / `conf-commit`.
- `journal-content: all` + `zonefile-load: none` is the journal-only primary mode: edits happen only via knotc / DDNS through the running daemon; `zone-flush` will not write a file.

## TSIG keys and ACLs

Four keys, each mapped to a narrow ACL: `knotctl.` (general write, `knotctl_update`), `caddy-acme.` (TXT under `_acme-challenge.*` only, `acme_update`), `caddy-ddns.` (A/AAAA only, `ddns_update`), `axfr-out.` (transfer only, `axfr_out`). Using the wrong key for a record type returns `NOTAUTH` - the role table and client-side symptoms are in the `knotctl` skill. Key material: never print it; compare or rotate with `secretctl` (the `secret-handling` skill). Rotation touches three places: the Fly secret, the confdb (`knotc conf-set 'key[<id>].secret'`), and the consumer's SOPS-encrypted `.env` (Caddy) - redeploy the consumer last.

### ACME ACL trap

Per RFC 8555 the challenge for `host.example.org` is `_acme-challenge.host.example.org` and for `*.example.org` it is `_acme-challenge.example.org`: `_acme-challenge` is the leftmost label, not a parent. `update-owner-match: sub-or-equal` with `update-owner-name: ["_acme-challenge"]` therefore never matches and Caddy's valid TSIG-signed updates get `NOTAUTH`. Use `pattern` mode with one entry per depth (each `*` is exactly one label):

```yaml
update-owner: name
update-owner-match: pattern
update-owner-name: [ "_acme-challenge", "_acme-challenge.*", "_acme-challenge.*.*" ]
```

Add more `.*` entries if you issue certs deeper than two levels under the zone.

## Caddy RFC 2136 - the ACME path

The edge Caddy runs on the router (`~/infra/ergo/caddy-compose/`, the `caddy` skill); it is built with `caddy-dns/rfc2136` (pins live in that repo's Dockerfile - do not copy versions from here). Site block shape:

```caddyfile
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

- `{$TSIG_CADDY_ACME}` must be present at parse time. The `rfc2136` module validates the key at startup (unlike the cloudflare / route53 providers) and crashes with `rfc2136: missing key, at <Caddyfile>:<line>` if the env var is empty: the SOPS `.env` is missing the line or compose does not pass it through.
- `propagation_delay 30s` + `resolvers` make Caddy verify against Knot directly instead of waiting for Let's Encrypt's resolvers to see the TXT.
- Adding a TSIG-driven site is a three-edit change: the operator-local env file the TSIG lives in, the Caddy stack's SOPS `.env`, and the Caddyfile site block.
- Sites under a migrated zone that still use `dns cloudflare` silently fail at the next renewal (Caddy writes the challenge to CF, the world asks Knot). Migrate every site block within the old-NS soak window and force-renew one early to prove the path.

Force-renew (edge Caddy on the router; full recipe in `~/infra/ergo/caddy-compose/AGENTS.md`):

```bash
ssh router 'docker exec caddy rm -rf /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<host>'
ssh router 'docker restart caddy'      # `caddy reload` alone will NOT re-issue: in-memory cert cache survives
ssh router 'docker logs caddy --since 2m 2>&1 | grep -E "<host>|tls\.obtain|obtained"'
```

Smoke the TSIG path itself with `knotctl add _acme-challenge.smoke.lab.erfi.io TXT '"hi"'` (uses the `knotctl.` key) or the nsupdate one-liner in reference.md.

## Delegation - glue + NS at Namecheap

In-bailiwick pattern for a zone served here:

1. Register host glue at the registrar (Namecheap: Domain List -> Manage -> Advanced DNS -> Personal DNS Server): `ns1` and `ns2` both -> `137.66.1.170`. Namecheap requires two glue names; the same IP under two names is fine.
2. Set NS at the registrar to `ns1.<zone>`, `ns2.<zone>`.
3. Put matching A records for `ns1` / `ns2` inside the zone. Without them resolvers cannot validate the delegation.

Propagation: the TLD servers and Google / Quad9 pick up a registrar NS change in about 15 minutes; Cloudflare's `1.1.1.1` holds the old delegation for the previous NS TTL. `dig +short @<tld-ns> NS <zone>` prints nothing because delegation lives in AUTHORITY + ADDITIONAL - use `dig +noall +authority +additional @a0.nic.io <zone> NS`.

## Migrating another zone off Cloudflare

CF outgoing AXFR requires Enterprise. The pattern: mirror the zone into Knot as a secondary via `deploy/knot-only/scripts/cf-axfr-setup.sh`, validate by resolved content, flip Knot to primary inside the daemon (reversible), then swap NS at the registry. Judgment that survives the details (which are in reference.md):

- The NOTIFY ACL must allow CF's full anycast ranges plus Fly's internal CIDRs (`172.16.0.0/12`, `fdaa::/16`) - CF's documented short list of NOTIFY sources is wrong, and Fly's edge rewrites inbound TCP source IPs. TSIG is the real gate. Symptom of getting it wrong: `ACL, denied, action notify` and a zone that lags CF by hours.
- Initial AXFR returns `BADKEY` for ~30 s after enabling outgoing - transient.
- Never diff with `ANY` (CF refuses it, RFC 8482); diff per type. CF flattens CNAMEs to A/AAAA on the wire and ships proxied Worker Custom Domains as `AAAA 100::` placeholders that need overlaying after promotion.
- Pre-lower the NS TTL at CF and soak the parent TTL after the swap (3600 s on `.io`, 86400 s on `.com` / `.dev`). Add-new-alongside-old is the safe swap; a one-shot full swap is acceptable only when Knot is fully in sync and glue is pre-registered.
- Zones still on CF: `erfi.dev` and `erfianugrah.com` (Cloudflare vanity NS `ns1`/`ns2.erfianugrah.com`; `dig NS <zone> +short` to re-check). They are DNSSEC-signed at CF, so moving them is the multi-signer variant: import the new signer's ZSK, dual-sign, swap DS at the registrar, retire the old signer.

## DNSSEC - live

Both zones are signed with Knot's KASP (`policy[knotea-auto]`, online signing, automatic KSK/ZSK rollover, CDS/CDNSKEY published). `erfi.io` has its DS at the `.io` parent via Namecheap; `lab.erfi.io` has its DS inside `erfi.io`, reconciled automatically on KSK rollover by same-server ds-push (`remote[parent_loopback]` at `127.0.0.1@5354` + `zone[lab.erfi.io].ds-push` - per-zone, never on the policy, or `erfi.io` would try to DDNS its own DS to `.io`). Check with `dig DS erfi.io +short` and `dig DS lab.erfi.io +short`. Full wiring and the verification limit (ds-push fires only on a CDS change, so it cannot be proven without a real KSK rollover): gotcha #28 in `~/infra/knotea/authority/AGENTS.md`.

DNSKEY / RRSIG / NSEC3 / CDS / CDNSKEY are daemon-managed; `knotctl` refuses to edit them. A child's delegation DS is the only DNSSEC record you edit by hand (`knotctl` skill).

## Day-2 operations

```bash
fly status -a glory-hole
fly logs   -a glory-hole
fly ssh console -a glory-hole                  # then knotc inside; -C "cmd" needs sh -c for && chains

knotc status
knotc zone-status erfi.io                      # serial, role, NOTIFY/AXFR state
knotc zone-read erfi.io                        # dump records (absolute owners)
knotc conf-read 'zone'                         # zone list + per-zone overrides
knotc conf-read 'key'                          # lists secrets too - avoid in a transcript
knotc zone-retransfer <zone>                   # secondary role only
```

## Verification one-liners

```bash
dig +short @137.66.1.170 SOA erfi.io
dig +short SOA erfi.io @1.1.1.1                          # via a public resolver (proves delegation)
dig +noall +authority +additional @a0.nic.io erfi.io NS   # delegation state at the TLD
dig DS erfi.io +short                                     # DNSSEC chain at the parent
dig +trace SOA erfi.io
knotctl export erfi.io | wc -l                            # TSIG'd AXFR (axfr-out. key)
```

## Foot-guns - the running list

Distilled from `~/infra/knotea/authority/AGENTS.md`, which has the numbered canonical version.

1. `server.storage` is rejected with `invalid item` on current Knot; it moved to `database.storage`.
2. PROXY-on-TCP is unsupported by knotd (`proxy-allowlist` is UDP-only). Only knotea may terminate PROXY; a bare knotd behind Fly must not have `handlers = ["proxy_proto"]` on TCP.
3. `knotc conf-set` is runtime-only in file mode. Run `knotd -C <confdb>`.
4. `conf-import` will not overwrite an existing confdb without `+force`.
5. `cznic/knot` has no `su-exec` / `gosu`; use `runuser -u knot --`.
6. Fly volumes mount `root:0755`; the entrypoint must chown for UID 53 or `knotc` returns cryptic EPERMs.
7. `journal-content: all` + `zonefile-load: none` is the journal-only mode; `difference-no-serial` requires a zonefile you do not write.
8. `fly ssh console -C "a && b"` does not go through a shell; wrap in `sh -c '...'`.
9. Fly outbound IP differs from the anycast ingress IP; it matters for IP-allowlist ACLs at peers, not for TSIG-authed AXFR.
10. Initial CF AXFR returns `BADKEY` for ~30 s. Do not roll back on the first failure.
11. CF refuses `ANY` queries. Diff by type.
12. Worker Custom Domain `AAAA 100::` placeholders need real CF edge IPs after promotion.
13. `update-owner-match: sub-or-equal` does not match ACME challenges; use `pattern` with per-depth entries.
14. `caddy-dns/rfc2136` validates `key` at parse time; an empty `{$TSIG_*}` crashes Caddy at startup.
15. CF's documented NOTIFY source IPs are incomplete; allow the live CF anycast list plus Fly internal CIDRs.
16. Adding a TSIG-driven Caddy site is a three-edit change (operator env file, Caddy SOPS `.env`, Caddyfile).
17. New identifiers need the two-step `conf-set` (bare id, then attributes).
18. `knotc zone-commit` runs a semantic check that `semantic-checks: off` does not disable. Last-resort recovery: `zone-flush` -> `zone-purge +journal +kaspdb +catalog +expired` -> re-add zone -> re-import records (drops journal history).
19. `dig +short @<tld-ns> NS <zone>` returns nothing; read AUTHORITY + ADDITIONAL.
20. Post-migration, `dns cloudflare` site blocks under the migrated zone break at the next renewal.
21. CF's AXFR-out flattens CNAMEs; compare by resolved content when verifying sync.
22. `knotc zone-set` / `zone-unset` accept the absolute owner with trailing dot (what `zone-read` prints) or a single relative label; a dotless multi-label owner such as `gloryhole.erfi.io` is read as relative and fails with the misleading `error: (no such node in zone found)`. `zone-begin` does not validate names - the error surfaces on the first `zone-set` inside the transaction; `knotc zone-abort <zone>` before retrying.

## Cost

`shared-cpu-1x` / 256 MB / 1 GB volume / 1 region is a few dollars a month on Fly; the first v4 + v6 anycast IPs per app are free and DNS egress is negligible. A second region doubles VM cost and needs its own volume (volumes are regional). AXFR over Fly's `.internal` mesh is free.

## Docs sources

Docs sources (erfi-toolkit docs tool): `knot-dns`, `nsd`, `powerdns`, `miekg-dns-v2`, `flyio`, `letsencrypt`.

## See also

- `fly` skill - volumes, anycast IPs, `fly ssh console -C` quirks, why DNS apps must not auto-stop.
- `cloudflare-ops` skill - CF Secondary DNS API endpoints used by `cf-axfr-setup.sh`.
- `caddy` skill - the edge Caddy that consumes the TSIG path; force-renewal and TSIG rotation recipes.
- `knotctl` skill - record edits, key roles, zones-as-code in `~/infra/knotea/authority/zones/`.
- `gloryhole` skill - the resolver half of knotea and the shared Fly deploy.
- `~/infra/knotea/authority/docs/runbooks/cf-to-knot-migration.md` - full operator playbook with rollback.
- `~/infra/knotea/authority/docs/api.md` - the CF-shape REST API (host `knotea.erfi.io`, Fly port 2096, path `/client/v4`) for terraform / dnscontrol / octodns style tooling.
