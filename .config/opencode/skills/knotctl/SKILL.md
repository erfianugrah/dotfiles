---
name: knotctl
description: Drive the user's `knotctl` CLI for live DNS edits against `knot-fly-mvp` (the authoritative server for `erfi.io` + `lab.erfi.io`). TSIG-keyed RFC 2136 over TCP — no nsupdate heredoc + /tmp keyfile ceremony, no Cloudflare API token. Covers add/rm/set/ls/export/keys subcommands, the four key roles (`knotctl/axfr-out/caddy-acme/caddy-ddns`) and which ACL each maps to (the #1 trip wire — `caddy-ddns` is A/AAAA-only, `caddy-acme` is `_acme-challenge.*` TXT-only, only `knotctl.` writes arbitrary record types), the 6-code exit contract for scripts, auto-verify-after-write polling, both --json placements, and the `make smoke` live integration test. Sibling to `knot-dns` (server side — config, ACLs, Fly deploy), `caddy` (uses the same TSIG infra via `dns rfc2136` for ACME), and `cloudflare` (for zones not yet migrated — `erfi.dev`, `erfianugrah.com` still on CF). Source at `~/knot-fly/cmd/knotctl/`, binary at `~/bin/knotctl`, tagged `knotctl-v0.1.0` since 2026-05-26.
---

# knotctl — TSIG-keyed DNS editor

Lives at `~/knot-fly/cmd/knotctl/`. Static Go binary, ~9.5MB, `CGO_ENABLED=0`,
talks miekg/dns RFC 2136 directly to `knotd` on `169.155.56.21:53`. No shim,
no Cloudflare API token, no `nsupdate -y` (which leaks secrets to argv) —
just keyfiles + TSIG + auto-verify polling. See the M0.5 plan at
`~/knot-fly/docs/plans/2026-05-25-knotctl-foundation.md` for the full design.

## When to reach for it

| Want to … | Reach for |
|---|---|
| Add/replace/remove a DNS record on `erfi.io` or `lab.erfi.io` | `knotctl` (this skill) |
| Inspect what's currently at a name | `knotctl ls` |
| Dump the whole zone to disk | `knotctl export <zone>` (TSIG'd AXFR) |
| Edit a CF-hosted zone (`erfi.dev`, `erfianugrah.com`) | `cloudflare` skill (still on CF) |
| Debug Knot ACLs / config / Fly deploy | `knot-dns` skill (server side) |
| Add a new TSIG key or ACL | `knot-dns` skill (`knotc conf-set` directly) |
| Run a Caddy ACME challenge | Caddy already does this via `dns rfc2136`; see `caddy` skill |

`knotctl` is the operator-facing CLI. It is NOT the HTTP API — that's M2+
work, not shipped yet.

## Install + first-run

```bash
# from ~/knot-fly source tree (built with ldflags so --version is stamped)
cd ~/knot-fly && make install-knotctl
# installs to ~/bin/knotctl  (ensure ~/bin is on $PATH)

knotctl --version
# knotctl knotctl-v0.1.0 (commit <sha>, built <iso8601>)

# Bootstrap keyfiles from the operator-local env file (the one
# `~/.knot-fly-mvp.env` that holds the TSIG secrets, mode 0600)
knotctl keys import-env

knotctl keys list
# acme     /home/erfi/.config/knotctl/keys/caddy-acme.key  [ok]
# axfr     /home/erfi/.config/knotctl/keys/axfr-out.key  [ok]
# write    /home/erfi/.config/knotctl/keys/knotctl.key  [ok]
```

Each keyfile is BIND format, mode `0600` enforced by the loader (see
`pkg/tsigclient/keyfile.go`). If perms drift loose the binary refuses to
load it — `chmod 600 ~/.config/knotctl/keys/*.key`.

## The four key roles — DO NOT MIX UP

This is the single most important thing in this skill. The four TSIG keys
provisioned on `knot-fly-mvp` each map to a narrow ACL. Using the wrong
key for a record type produces `NOTAUTH (rcode=9)` → `knotctl` exits 2.

| Key role | Keyfile | ACL on Knot side | What it CAN do |
|---|---|---|---|
| `knotctl.` | `knotctl.key` | `knotctl_update` (A/AAAA/CNAME/MX/TXT/SRV/CAA/NS) | **The general-purpose write key.** Provisioned in M0.5 K0. Use this for arbitrary record types. |
| `caddy-acme.` | `caddy-acme.key` | `acme_update` (TXT on `_acme-challenge.*`) | TXT only, only under `_acme-challenge.` labels. Caddy uses it via `dns rfc2136`. |
| `caddy-ddns.` | `caddy-ddns.key` | `ddns_update` (A/AAAA only) | A/AAAA only. Reserved for DDNS hosts; not used by anything live today. |
| `axfr-out.` | `axfr-out.key` | `axfr_out` (zone transfer) | **Read-only zone transfer (AXFR).** No writes. `knotctl export` uses this. |

Maps to: `knotctl add ... A` → uses `knotctl.` (role `write`). `knotctl
export` → uses `axfr-out.` (role `axfr`). Caddy ACME → uses `caddy-acme.`
under the hood, separate from `knotctl`.

If you see `error: server rejected with NOTAUTH (rcode=9)`, the cause is
≥99% "wrong key role for this record type", not a real auth failure. Check
`knotctl keys show write` and confirm the key your call resolved to.

## Workflows

### Add / replace / remove

`knotctl add` polls the server after the write — exits 0 only when the
record is queryable. Default verify timeout is 10s; tune with `--wait=5s`
or skip entirely with `--no-wait` (returns immediately on server-ack).

```bash
# Add a record
knotctl add www.erfi.io A 192.0.2.1
knotctl add mail.erfi.io MX "10 mx1.erfi.io"
knotctl add _verify.erfi.io TXT '"some-token"'    # quote TXT bodies — RFC 1035 char-string

# Atomic replace (set = remove all of type + add, in one UPDATE message)
knotctl set www.erfi.io A 198.51.100.7

# Remove
knotctl rm www.erfi.io A 192.0.2.1        # specific (name, type, rdata) tuple
knotctl rm www.erfi.io A                  # all A records at this name
knotctl rm staging.erfi.io                # everything at staging.erfi.io
```

`add` and `set` validate inputs against `wire.Record.Validate()` before
sending — uneditable types (SOA, DNSSEC) exit 5 client-side without
touching the wire. Empty content, missing name, TTL below 30s also exit 5.

### Inspect

```bash
knotctl ls www.erfi.io A          # human-readable table
knotctl ls www.erfi.io            # ANY query (server may filter)
knotctl ls www.erfi.io A --json   # JSON array, matches pkg/wire.Record shape

knotctl export erfi.io            # full zone via TSIG'd AXFR (table)
knotctl export erfi.io --json     # same, machine-readable
knotctl export erfi.io | wc -l    # zone size check (~253 records as of M0.5 smoke)
```

`ls` queries are unauthenticated (UDP/TCP DNS query, no TSIG). `export`
uses the `axfr` role key.

### `--json` is a global flag — works pre OR post subcommand

K15.5 fixed the stdlib-flag-parse-stops-at-positional bug. Both work:

```bash
knotctl --json ls www.erfi.io A
knotctl ls www.erfi.io A --json
# identical output
```

JSON shape matches `pkg/wire.Record` (Cloudflare `/zones/{id}/dns_records`
JSON tags), so scripts written against `knotctl --json` will keep working
when M2's HTTP API ships. Same applies to `--no-wait` and `--wait`.

### Manage keyfiles

```bash
knotctl keys list                         # which roles present + path
knotctl keys show write                   # metadata only — NEVER the secret
knotctl keys import-env [PATH]            # default: ~/.knot-fly-mvp.env
```

`keys show` deliberately does NOT echo the secret (defense against the
gotcha #25 leak class — see `~/knot-fly/AGENTS.md`). Read the file
directly if you genuinely need the value.

## Exit code contract — `$?` after any knotctl call

| Code | Meaning | Script reaction |
|---|---|---|
| 0 | Success (record written + verified queryable) | continue |
| 1 | Write succeeded but verification timed out — record NOT yet visible | retry / investigate / accept |
| 2 | Server rejected (NOTAUTH/FORMERR/REFUSED/etc., wrapped as `*tsigclient.RcodeError`) | check key role + ACL — usually "wrong key for record type" |
| 3 | Config error — keyfile missing, loose perms, malformed YAML | fix the keyfile / config |
| 4 | Network error — timeout, connection refused | check `KNOTCTL_SERVER` reachability |
| 5 | Usage error — bad flags, missing args, uneditable type | fix the invocation |

Idiomatic shell pattern:

```bash
if knotctl set host.erfi.io A "$NEW_IP"; then
    log "DDNS update OK"
else
    case $? in
        1) log "Update sent but didn't propagate within --wait; investigate" ;;
        2) log "Server rejected — almost certainly wrong key role" ;;
        4) log "Couldn't reach the server — see Fly UDP hairpin gotcha #24" ;;
        *) log "Other failure (exit=$?)" ;;
    esac
    exit 1
fi
```

## Config layering

Flag > env > YAML > defaults. Resolution at `pkg/config/loadConfig`.

```bash
# Highest precedence — flags
knotctl --server [fdaa:5:8fc8:a7b:...]:53 --keydir /tmp/keys ls foo

# Or via env (good for shell aliases)
export KNOTCTL_SERVER=169.155.56.21:53
export KNOTCTL_ZONE=erfi.io

# Lowest precedence (other than defaults) — YAML at ~/.config/knotctl/config.yml
cat > ~/.config/knotctl/config.yml <<'YAML'
server: 169.155.56.21:53
default_zone: erfi.io
default_key: knotctl
keydir: /home/erfi/.config/knotctl/keys
keys:
  write: knotctl
  axfr:  axfr-out
  acme:  caddy-acme
YAML
```

Defaults hardcode the live `knot-fly-mvp` anycast IP. The 4 environment
variables: `KNOTCTL_SERVER`, `KNOTCTL_KEY` (default-key basename),
`KNOTCTL_ZONE`, `KNOTCTL_KEYDIR`.

## Live smoke — `make smoke`

23-assertion end-to-end against the real server. Writes a uniquely-named
test record (`_smoke-knotctl-<unix-ts>-<pid>.erfi.io`), exercises every
subcommand, cleans up via `trap EXIT`.

```bash
cd ~/knot-fly && make smoke
# Builds + installs knotctl, then runs scripts/smoke.sh.
# 23/23 green = green-light to ship.
```

Safe to run repeatedly. Safe to SIGINT. **Touches production DNS** — the
smoke record name is unmistakable as a test artifact, and the trap-cleanup
removes it on any exit path.

The smoke deliberately does NOT exercise wrong-key paths (would pollute
the Knot audit log). NOTAUTH/FORMERR scenarios are covered by the unit
tests in `cmd/knotctl/handlers_test.go` against the in-process
`pkg/tsigtest` DNS server.

## Common failure modes

### `error: keyfile X has loose permissions Y; want 0600`

```bash
chmod 600 ~/.config/knotctl/keys/*.key
```

### `error: server rejected with NOTAUTH (rcode=9)` (exit 2)

Almost always "wrong key role for the record type." Check:

1. `knotctl keys list` — is the keyfile for your role present?
2. Are you implicitly using `caddy-ddns` (A/AAAA only) but trying to
   write a TXT? Pass `--key knotctl` explicitly to force the
   general-purpose key, or fix the `Keys` map in config.yml.
3. Is the secret in your `.key` file actually the current one?
   See gotcha #25 in `~/knot-fly/AGENTS.md` for the rotation procedure.

### `error: update: network error: ... i/o timeout` (exit 4)

The default server `169.155.56.21:53` is the public anycast IP. If you're
running `knotctl` from inside a Fly machine in `fra`, the UDP hairpin
block applies and queries timeout — but TCP works fine. `knotctl` uses
TCP throughout, so this usually means a real outage, not the hairpin
issue. See gotcha #24 in `~/knot-fly/AGENTS.md` for the full UDP/TCP
matrix per source.

### Verify timed out (exit 1) — write succeeded but record not yet queryable

Rare with Knot (primary serves authoritative immediately). Possibilities:

1. You wrote to one Knot instance and queried another (not possible
   today — there's only one knot-fly machine; will matter at M3).
2. The verify default of 10s isn't enough for some reason — `--wait=30s`
   to extend, or `--no-wait` to skip and check by hand with `knotctl ls`.
3. Bug in your args: the value you set might've been silently dropped
   by the server (rare with TSIG'd RFC 2136). Run with `--no-wait` then
   `knotctl ls` to see what's actually there.

## What knotctl is NOT

- **Not a Cloudflare-API client.** `erfi.dev` + `erfianugrah.com` are still
  on CF; use the `cloudflare` skill / wrangler / dnscontrol for those.
- **Not the future HTTP API.** M2 (knot-api shim) will expose a CF-shape
  REST API on `:8080`. `knotctl` is the wire-level CLI today; the JSON
  shape matches what M2 will return, so scripts port over.
- **Not for DNSSEC ops.** Knot's KASP manages keys + signing automatically.
  DNSKEY/RRSIG/NSEC3 records can't be edited via `knotctl` (uneditable-type
  validation rejects them client-side, exit 5).
- **Not for zone-level config** (NS, SOA at apex, TSIG keys, ACLs). Use
  `knotc conf-set` from the server side via the `knot-dns` skill.

## Updating knotctl

`knotctl` lives in `~/knot-fly/cmd/knotctl/`. Update via:

```bash
cd ~/knot-fly
git pull
make install-knotctl    # rebuilds with current commit SHA in --version
```

If you're modifying knotctl itself, see `~/knot-fly/AGENTS.md` and the
M0.5 plan. The test surface is comprehensive (~96 race-clean unit tests
across 4 packages, plus the live smoke). Add tests when changing
handlers; the `pkg/tsigtest` in-process server is the canonical helper.
