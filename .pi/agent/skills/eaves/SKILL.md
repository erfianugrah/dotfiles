---
name: eaves
description: Drive the user's `eaves` CLI - a read-only Juniper/VyOS-style operational shell for the NixOS edge router (ssh alias `nixos`). Use when answering operational questions about the edge router (DHCP leases/pools, NAT translations, conntrack count, nftables ruleset, interfaces/routes/neighbors, vnstat bandwidth, kea journal), running the 13-check `doctor` health/regression suite after a router.nix rebuild, answering router questions OFFLINE via the committed fixtures (EAVES_FIXTURE_DIR, no ssh needed), re-capturing/sanitizing fixtures, or extending the CLI itself. Fires on "eaves", "show dhcp leases", "who is 10.0.x.x", "router health", "edge router status", "is NAT working". NOT for config changes - eaves has no configure mode by design; config is router.nix + nixos-rebuild. Sibling to `tailscale-homelab` (ssh), `knotctl`, `caddy`. Repo `~/eaves` (private GitHub erfianugrah/eaves), stdlib-only Go, CI green.
---

# eaves - read-only operational CLI for the edge router

`eaves` is the observational half of a VyOS CLI for the NixOS edge router:
`show` / `monitor` / `doctor`, Juniper-style unique-prefix matching
(`eaves sh int`), `--json` on everything, exit 0/1/2. Zero mutation
capability - no `configure` mode exists by design.

**Config control plane (since 2026-08-01): `~/router`** - private
GitHub `erfianugrah/router`, flake-based, SINGLE configuration.nix (the
old configuration.nix/router.nix manual-mirror workflow is dead).
`/etc/nixos` on the router is a read-only checkout; NEVER edit files
on the router. All changes: edit in `~/router`, commit, `make deploy`
(push -> router fast-forwards -> `nixos-rebuild switch --flake
.#nixos` -> `eaves doctor` gate). `make diff` = dry-build. nixpkgs
and eaves are rev-pinned in flake.nix; bump deliberately. The router
authenticates with read-only deploy keys (see ~/router/README.md).

Full command reference + doctor check table: `~/eaves/README.md`.
Implementation plan + fixture contract: `~/eaves/docs/plans/2026-07-24-eaves-cli.md`.

## When to reach for what

| Want to ... | Reach for |
|---|---|
| Answer a router question WITHOUT touching the router | `cd ~/eaves && EAVES_FIXTURE_DIR=testdata/fixtures go run . <cmd>` (fixtures are a sanitized snapshot) |
| Live answer (leases, conntrack, NAT, ruleset) | `ssh nixos 'sudo -n eaves <cmd>'` (eaves is on PATH) |
| Post-rebuild regression gate ("did I break the router?") | `eaves doctor` - 13 assertions (12 GOTCHAS.md + nixos-checkout drift) |
| Verify the flake / test a change end-to-end | `go test ./...` + `bash scripts/smoke-fixtures.sh` (offline) |
| Change firewall/DHCP/VLAN config | `~/router` + `make deploy` - NEVER eaves (it can't), NEVER edit /etc/nixos on the router |
| Raw packet forensics eaves doesn't cover | `ssh nixos` + tcpdump/conntrack by hand (`tailscale-homelab` skill) |

## Binary availability (ADOPTED 2026-08-01)

eaves IS on the router's PATH (`/run/current-system/sw/bin/eaves`),
installed via the `~/router` flake input (`eaves.nixosModules.default`
= systemPackages). The old rsync + /tmp/nix-build pattern is RETIRED.
Run: `ssh nixos 'sudo -n eaves doctor'`. Rolling out a NEW eaves rev:
bump the `?rev=` pin in `~/router/flake.nix`, `make deploy` - the pin
means a broken eaves main never reaches the router by accident.
Most commands need root (conntrack/nft) - run via `sudo -n`
(passwordless sudo is already configured for the `nixos` ssh user, so
`sudo -n` never goes interactive).

## Command patterns

```bash
eaves doctor                              # 13 checks, exit 1 on any FAIL
eaves show dhcp server leases pool 69     # filters are POSITIONAL key/value pairs:
eaves show dhcp server leases ip 10.0.69.6   #   pool|ip|mac|host <value>, combinable, no dashes
eaves show dhcp server pools              # per-subnet pool utilization %
eaves show nat translations               # orig vs reply tuples (NAT'd only)
eaves show conntrack count                # N / max (pct)
eaves show firewall ruleset               # tables/chains/policies/rule counts
eaves show log [unit X] [lines N]         # journal, default kea-dhcp4-server
eaves show system bandwidth|storage|version
eaves monitor interface <name> [top]      # vnstat -l / iftop - LIVE ONLY
eaves --json show ...                     # machine-readable, pipe to jq
```

## Fixture mode (the pi-session superpower)

Every command except `monitor` works offline against the committed
fixtures - this is how you answer "who has DHCP leases right now"-class
questions in a session without ssh'ing anywhere:

```bash
cd ~/eaves
EAVES_FIXTURE_DIR=testdata/fixtures go run . show dhcp server leases
EAVES_FIXTURE_DIR=testdata/fixtures go run . doctor
```

Fixtures are SANITIZED: WAN is `198.51.x.x` (TEST-NET-2), MACs are
`02:00:00:00:XX:XX`, hostnames are `host-N`. Never quote these as live
values (a fixture MAC is a fabricated placeholder) - say "as of the
fixture snapshot". Fixture filenames map 1:1 to arg vectors
(`nft_-j_list_ruleset.json` == `nft -j list ruleset`).

**Check fixture freshness before answering anything time-sensitive**:
`cat ~/eaves/testdata/fixtures/CAPTURED_AT` (written by the capture
script) or `git -C ~/eaves log -1 --format=%ci -- testdata/fixtures`.
If the fixtures predate the event being asked about (a rebuild, a
topology change), say so - fixture answers describe the OLD state, and
the honest path is one read-only ssh (or a re-capture) before answering.
There is no offline path to live truth.

Re-capture when topology changes (read-only ssh, re-sanitizes):

```bash
~/eaves/scripts/capture-fixtures.sh   # then update count assertions in tests
```

## Gotchas (all learned the hard way)

- **Fixture counts churn.** kea hands out 300s leases, so leases4.csv
  appends per renewal (45 rows / 11 unique IPs at capture; readers must
  dedup by IP keeping the LAST row). Container veths churn the ip-link
  count too. Tests assert the COMMITTED fixture values - after a
  re-capture, update them.
- **Fixtures are ground truth over docs.** If a plan/README number and a
  fixture disagree, the fixture wins. Never edit fixtures to make a test
  pass (the `fixtures-untouched` harness sensor + git will catch it).
- **`monitor` is live-only** (interactive curses) - it errors cleanly in
  fixture mode; that's expected, not a bug.
- **Exit codes**: 0 ok, 1 runtime/doctor-FAIL, 2 usage (unknown/ambiguous
  command prints candidates).
- **Remote shell is zsh on `nixos`** - `echo ===` separators explode
  ("== not found"); use `echo ---`.
- **Filters are positional pairs**, not flags: `leases host foo ip 10.0.69.6`
  works; `--filter ip=...` / `--ip` do not exist. Invalid values exit 1.
- **doctor is data-driven, not hardcoded**: kea-served ifaces come from
  `/etc/kea/dhcp4-server.conf`, WAN from the default route. It
  generalizes past the current topology - don't hardcode interface names
  in checks.

## Extending eaves

Repo `~/eaves`, stdlib-only Go (go.mod zero requires - keep it that way;
`vendorHash = null` in flake.nix depends on it). Command tree in
`internal/show/show.go`; parsers pure in `internal/parse/`; new data
sources go through the runner allowlist (`internal/runner/runner.go`) -
add the binary + a fixture capture line + parser + golden test. Build via
the self-correcting loop (`.pi/harness.json` is ready: 10 sensors incl.
LLM judge) - see the `self-correcting-loop` skill. NOTE: loop agents run
in a bwrap jail (ro filesystem, ~/.ssh masked) - they CANNOT ssh to the
router, so fixture re-capture must happen OUTSIDE the loop (run
`scripts/capture-fixtures.sh` yourself, commit, then start the loop).
