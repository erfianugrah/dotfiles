---
name: knotctl
description: "Use when making live DNS edits against the user's Knot authoritative server (erfi.io + lab.erfi.io, TSIG-keyed RFC 2136 over TCP) - add/rm/set/ls records, declarative YAML zone apply from authority/zones/, TSIG key roles and NOTAUTH, or the live smoke test. Fires on 'knotctl', 'add/change a DNS record', 'RFC 2136', 'TSIG key', 'zone apply', 'zones-plan', '_acme-challenge TXT'. NOT for resolver work (gloryhole) or server-side config, ACLs and DNSSEC (knot-dns)."
---

# knotctl - TSIG-keyed DNS editor

Source `~/infra/knotea/authority/cmd/knotctl/` (knotea monorepo), binary `~/bin/knotctl`, built with `cd ~/infra/knotea/authority && make install-knotctl`. Static Go binary, `CGO_ENABLED=0`, speaks miekg/dns RFC 2136 over TCP to the live authority at `137.66.1.170:53` (knotea on the Fly app `glory-hole`, which proxies UPDATE to its loopback knotd - topology in the `knot-dns` skill). No shim, no Cloudflare token, no `nsupdate -y` (which leaks secrets to argv) - keyfiles + TSIG + auto-verify polling. Design doc: `~/infra/knotea/authority/docs/plans/2026-05-25-knotctl-foundation.md`.

## When to reach for it

| Want to ... | Reach for |
|---|---|
| One-off DNS edit on `erfi.io` or `lab.erfi.io` | `knotctl add/rm/set` |
| Replace ALL records of (name, type) with N values atomically | `knotctl set name TYPE v1 v2 v3` |
| Treat a zone as YAML in git, reconcile drift | edit `~/infra/knotea/authority/zones/<zone>.yml`, `make zones-plan`, `make zones-apply` |
| Preview what an apply would change | `knotctl apply <file> --dry-run` / `make zones-plan` |
| Inspect what is at a name | `knotctl ls` |
| Dump the whole zone | `knotctl export <zone>` (TSIG'd AXFR; `--yaml` for the apply schema) |
| Edit a CF-hosted zone (`erfi.dev`, `erfianugrah.com`) | `cloudflare-ops` skill - both still delegate to Cloudflare vanity NS (`dig NS <zone> +short`) |
| Debug Knot ACLs / confdb / Fly deploy, add a TSIG key or ACL | `knot-dns` skill (`knotc conf-set` server-side) |
| Run a Caddy ACME challenge | Caddy does this itself via `dns rfc2136` - `caddy` skill |
| CF-compatible tooling (terraform-provider-cloudflare, dnscontrol, octodns) | the CF-shape HTTP API on the same app: host `knotea.erfi.io`, Fly port 2096, path `/client/v4`, bearer token; schema `~/infra/knotea/authority/docs/api.md` |

`knotctl` is the wire-level operator CLI. The HTTP API is a separate surface over the same loopback knotd; the JSON shapes match (`pkg/wire.Record` uses the Cloudflare `dns_records` tags), so scripts written against `knotctl --json` port over.

## Install + first-run

```bash
cd ~/infra/knotea/authority && make install-knotctl   # -> ~/bin/knotctl, ldflags stamp --version
knotctl --version
# knotctl v<monorepo tag>-<n>-g<sha> (commit <sha>, built <iso8601>, go...)

knotctl keys import-env        # bootstrap keyfiles from the operator env file (default ~/.knot-fly-mvp.env, mode 0600)
knotctl keys list
# acme     ~/.config/knotctl/keys/caddy-acme.key  [ok]
# axfr     ~/.config/knotctl/keys/axfr-out.key    [ok]
# write    ~/.config/knotctl/keys/knotctl.key     [ok]
```

Each keyfile is BIND format, mode `0600` enforced by the loader (`pkg/tsigclient/keyfile.go`). Loose perms make the binary refuse to load it: `chmod 600 ~/.config/knotctl/keys/*.key`. Never print a keyfile; `knotctl keys show <role>` deliberately shows metadata only. Comparing or rotating a key is the `secret-handling` skill.

## The four key roles - do not mix up

Each TSIG key on the authority maps to a narrow ACL. The wrong key for a record type produces `NOTAUTH (rcode=9)` and exit 2.

| Key role | Keyfile | ACL on Knot | What it can do |
|---|---|---|---|
| `knotctl.` | `knotctl.key` | `knotctl_update` (A/AAAA/CNAME/MX/TXT/SRV/CAA/NS/DS) | The general-purpose write key. |
| `caddy-acme.` | `caddy-acme.key` | `acme_update` (TXT on `_acme-challenge.*`) | Caddy's ACME key. TXT only, only under `_acme-challenge.` labels. |
| `caddy-ddns.` | `caddy-ddns.key` | `ddns_update` (A/AAAA only) | Reserved for DDNS hosts; nothing live uses it. |
| `axfr-out.` | `axfr-out.key` | `axfr_out` (zone transfer) | Read-only AXFR. `knotctl export` uses this. |

`knotctl add/set/rm` use `knotctl.` (role `write`); `export` uses `axfr-out.` (role `axfr`). If you see `error: server rejected with NOTAUTH (rcode=9)` the cause is almost always "wrong key role for this record type", not a real auth failure - check `knotctl keys show write`.

## Workflows

### Add / replace / remove

`add` and `set` poll the server after the write and exit 0 only when the record is queryable. Default verify timeout 10s; `--wait=5s` tunes it, `--no-wait` returns on server-ack.

```bash
knotctl add www.erfi.io A 192.0.2.1
knotctl add mail.erfi.io MX "10 mx1.erfi.io"
knotctl add _verify.erfi.io TXT '"some-token"'    # quote TXT bodies - RFC 1035 char-string

knotctl set www.erfi.io A 198.51.100.7                       # atomic replace, single value
knotctl set mail.erfi.io MX '10 mx1.erfi.io' '20 mx2.erfi.io' # atomic multi-value: ONE UPDATE message
knotctl set api.erfi.io  A  1.2.3.4 1.2.3.5 1.2.3.6

knotctl rm www.erfi.io A 192.0.2.1        # specific (name, type, rdata)
knotctl rm www.erfi.io A                  # all A at this name
knotctl rm staging.erfi.io                # everything at the name
```

Validation happens client-side before anything hits the wire (`wire.Record.Validate()`): uneditable types (SOA, DNSKEY/RRSIG/NSEC*/CDS/CDNSKEY), empty content, missing name, TTL below 30s and a malformed `--wait` all exit 5 without writing. `DS` is editable (delegation glue for a child zone). Multi-value `set` shares (zone, name, type, ttl) across values; mixing types in one call errors client-side.

### Declarative reconcile (apply) - zones as code

The source of truth for both live zones is `~/infra/knotea/authority/zones/erfi.io.yml` and `lab.erfi.io.yml` (schema and workflow in `zones/README.md`). Edit in git, plan, apply:

```bash
cd ~/infra/knotea/authority
make zones-plan                 # dry-run every zones/*.yml, additive AND with --prune
make zones-apply                # additive: adds + updates only
make zones-apply ARGS=--prune   # also remove drift
make zones-export               # regenerate zones/*.yml from live state (`knotctl export <zone> --yaml`) - only when bootstrapping or capturing out-of-band edits
```

Single-file form: `knotctl apply zones/lab.erfi.io.yml [--dry-run] [--prune]`. Schema:

```yaml
zone: lab.erfi.io
default_ttl: 300
records:
  - { name: test, type: A,     content: 10.0.10.1 }
  - { name: api,  type: A,     content: [1.2.3.4, 1.2.3.5] }      # multi-value rrset
  - { name: '@',  type: MX,    content: ['10 mail.lab.erfi.io'] } # apex
  - { name: www,  type: CNAME, content: lab.erfi.io, ttl: 60 }
  - { name: _spf, type: TXT,   content: '"v=spf1 -all"', comment: SPF }
```

Properties to internalise:

- Additive by default. Live records absent from the YAML are left alone; `--prune` removes drift. Safer than `terraform apply` because hand edits at the apex are never at risk.
- Idempotent. A second apply prints `0 set, 0 removed, N unchanged`. Diff is by rrset (`name`+`type`) content + TTL.
- `--prune` never removes apex `NS`, `SOA`, DNSSEC records, or `DS`. DS is interactive-only (`add/rm/set/ls ... --zone=<parent>`) because a delegation DS may be daemon-managed by ds-push; apply rejects a DS entry with a pointer back to `knotctl add`. Reconcilable set = editable set minus DS.
- Multi-value `content: [a, b, c]` becomes one rrset replaced atomically.
- Name resolution: `@` = zone apex; bare label joins the zone; an FQDN must be inside the declared zone (else an error with the line number). BIND convention: no trailing dot = relative, even with internal dots.
- Per-op timeout 10s; only Sets are verified (remove verification is racy on caches).
- Not transactional across rrsets: each (name, type) op is one UPDATE, but op #5 failing leaves ops 1-4 applied. Always `--dry-run` / `make zones-plan` first.

Plan glyphs: `~` will Set, `-` will Remove (only with `--prune`), `=` unchanged; reasons `new`, `content changed`, `ttl changed`, `drift`, `unchanged`.

Content canonicalisation: miekg/dns appends the trailing dot to hostname rdata (`mail.erfi.io` -> `mail.erfi.io.`) and AXFR always returns that form. `pkg/tsigclient/CanonicaliseContent` normalises both sides before `reconcile.Plan`, so MX/CNAME/NS/SRV/PTR in YAML may be written with or without the dot and stay idempotent.

### Inspect

```bash
knotctl ls www.erfi.io A          # table
knotctl ls www.erfi.io            # ANY (server may filter)
knotctl ls www.erfi.io A --json   # pkg/wire.Record shape

knotctl export erfi.io            # TSIG'd AXFR, table
knotctl export erfi.io --json
knotctl export erfi.io --yaml     # apply-compatible schema
```

`ls` is an unauthenticated DNS query; `export` uses the `axfr` role. `--json`, `--no-wait`, `--wait` are global flags and work before or after the subcommand.

### Manage keyfiles

```bash
knotctl keys list                 # roles present + paths
knotctl keys show write           # metadata only, never the secret
knotctl keys import-env [PATH]    # default ~/.knot-fly-mvp.env
```

## Exit code contract

| Code | Meaning | Script reaction |
|---|---|---|
| 0 | Success (written + verified queryable) | continue |
| 1 | Write succeeded, verification timed out | retry / investigate / accept |
| 2 | Server rejected (NOTAUTH/FORMERR/REFUSED, `*tsigclient.RcodeError`) | wrong key role for the type, almost always |
| 3 | Config error - keyfile missing, loose perms, malformed YAML | fix keyfile / config |
| 4 | Network error - timeout, connection refused | check `KNOTCTL_SERVER` reachability |
| 5 | Usage error - bad flags, missing args, uneditable type | fix the invocation |

```bash
if knotctl set host.erfi.io A "$NEW_IP"; then
    log "DDNS update OK"
else
    case $? in
        1) log "sent but not visible within --wait" ;;
        2) log "server rejected - check key role" ;;
        4) log "cannot reach the authority" ;;
        *) log "other failure" ;;
    esac
    exit 1
fi
```

## Config layering

Flag > env > YAML > compiled defaults (`pkg/config/loadConfig`). Flags: `--config PATH` (default `~/.config/knotctl/config.yml`), `--server`, `--key`, `--keydir`. Env: `KNOTCTL_SERVER`, `KNOTCTL_KEY`, `KNOTCTL_ZONE`, `KNOTCTL_KEYDIR`. The compiled default server is `127.0.0.1:53` (dev), so the live config file is what points at prod - it holds exactly two keys and no secrets:

```yaml
# ~/.config/knotctl/config.yml
server: 137.66.1.170:53
known_zones:
  - erfi.io
  - lab.erfi.io
```

`keydir` defaults to `~/.config/knotctl/keys` and the role -> keyfile map (`write`/`axfr`/`acme`) has sane defaults, so neither is set.

## Sub-zone routing - `known_zones`

Zone inference is longest-suffix-match against `known_zones` (default `[erfi.io, lab.erfi.io]`), so `foo.lab.erfi.io` routes to `lab.erfi.io`, never to `erfi.io` as a leaf record (which would answer NXDOMAIN publicly because resolvers follow the deeper delegation). Precedence: explicit `--zone=<name>`, then longest suffix in `known_zones`, then `default_zone` if set and a real suffix, else a hard error: `cannot infer zone for "X": not a subdomain of any known_zones (...)`. Add the zone to `known_zones` or pass `--zone`. Add new zones here as they migrate off CF.

## Live smoke - `make smoke`

`cd ~/infra/knotea/authority && make smoke` (defaults `SMOKE_ZONE=erfi.io`; `SMOKE_ZONE=lab.erfi.io` exercises sub-zone routing). End-to-end against the real server: writes uniquely named `_smoke-knotctl-<ts>-<pid>.<zone>` / `_smoke-apply-...` records, exercises every subcommand including the full apply lifecycle (dry-run -> real -> idempotent -> prune), cleans up via `trap EXIT` on any exit path. Touches production DNS; the record names are unmistakable test artifacts. All green = green light to ship.

The smoke deliberately does not exercise wrong-key paths (it would pollute the Knot audit log); NOTAUTH/FORMERR are covered by unit tests in `cmd/knotctl/handlers_test.go` against the in-process `pkg/tsigtest` server, which enforces zone-match NOTAUTH like a real knotd.

## Common failure modes

- `error: keyfile X has loose permissions Y; want 0600` -> `chmod 600 ~/.config/knotctl/keys/*.key`.
- `error: server rejected with NOTAUTH (rcode=9)` (exit 2) -> wrong key role for the record type (`knotctl keys list`; pass `--key knotctl` explicitly), or the keyfile holds a rotated-out secret (compare with `secretctl cmp`, `secret-handling` skill; server-side rotation is in `~/infra/knotea/authority/AGENTS.md`).
- `error: update: network error: ... i/o timeout` (exit 4) -> `knotctl` is TCP throughout, so this is a real reachability problem with `137.66.1.170:53`, not the Fly UDP-hairpin issue documented in knotea's AGENTS.
- Verify timed out (exit 1) -> rare with a single primary. Extend with `--wait=30s`, or `--no-wait` then `knotctl ls` to see what landed.

## What knotctl is NOT

- Not a Cloudflare-API client: `erfi.dev` + `erfianugrah.com` stay on CF (`cloudflare-ops` skill).
- Not the HTTP API: that is the in-process CF-shape REST surface described above; `knotctl` is the wire-level CLI.
- Mostly not for DNSSEC: KASP manages keys and signing; DNSKEY/RRSIG/NSEC3/CDS/CDNSKEY are rejected client-side (exit 5) and filtered out of `apply --prune`. The one exception is a child delegation `DS` - interactive only: `knotctl add/rm/set/ls lab.erfi.io DS "<keytag> <alg> <digesttype> <digest>" --zone=erfi.io`. `lab.erfi.io`'s DS in `erfi.io` is also auto-reconciled on KSK rollover by same-server ds-push (`knot-dns` skill, AGENTS gotcha #28).
- Not for zone-level config (apex NS/SOA, TSIG keys, ACLs): `knotc conf-set` server-side via the `knot-dns` skill. `apply --prune` never removes apex NS or SOA.

## Updating knotctl

```bash
cd ~/infra/knotea && git pull
cd authority && make install-knotctl    # rebuilds with the current commit in --version
```

When changing knotctl itself: `~/infra/knotea/authority/AGENTS.md` first; add tests with the `pkg/tsigtest` in-process server for any handler change. Docs sources (erfi-toolkit docs tool): `knot-dns`, `miekg-dns-v2`.
