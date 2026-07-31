---
name: xikectl
description: Drive the user's `xikectl` CLI - the operator tool for the XikeStor SKS8300-12E2T2X switch at 10.0.69.4 (edge switch between the MS-01 router and the servarr box). Use when reading switch state (VLANs, interfaces, MAC table, MTU/jumbo, port stats, STP, LLDP, ARP, CPU/memory/fan), running the live smoke or verify suites, adding a show resource, probing switch CLI commands, saving/backing up switch config, or planning the switch write lane (set/apply/restore) or reboot. Fires on "xikectl", "XikeStor", "SKS8300", "the switch", "switch VLANs/ports", "jumbo MTU on the switch", "display vlan", "trunk port". NOT for router/DHCP/NAT/firewall (that's `eaves` on the NixOS router), DNS (`knotctl`/`gloryhole`), or the arr media stack (`arr-stack`). Sibling to `eaves`, `tailscale-homelab`, `caddy`. Repo `~/servarr-compose/tools/xikectl`, Go, 78 unit tests + live smoke green.
---

# xikectl - operator CLI for the XikeStor switch

Switch: SKS8300-12E2T2X at `10.0.69.4`, firmware V1.04.B09, PRODUCTION
(carries the servarr trunk). Tool repo: `~/servarr-compose/tools/xikectl`
(single Go module). **Read `tools/xikectl/AGENTS.md` first when working
in the repo** - it has the full gotcha list. Design + live facts:
`incident-2026-05/edge-nixos/xikectl-plan.md`.

## Quick reference

```bash
cd ~/servarr-compose/tools/xikectl && go build -o xikectl ./cmd/xikectl
export XIKE_USER=admin XIKE_PASS=admin          # XIKE_HOST defaults to 10.0.69.4

./xikectl show vlan|interfaces|mac|mtu|...      # 24 resources, --json available
./xikectl smoke                                  # live e2e: all 24 resources, ~15s
./xikectl verify                                 # drift vs fixture.yaml
./xikectl save                                   # persist to flash + readback (manual only)
./xikectl backup --running -o backup.cfg         # CLI scrape (web exporter is a lie)
./xikectl cfg "display vlan"                   # config-mode sequence (enable->system-view->cmds->end)
                                               # THE WRITE PATH - state changes go here, manual + readback
                                               # needs XIKE_ENABLE_PASS since 2026-07-31 (vaultwarden)
./xikectl set "interface eth0/0/5" "description foo"   # full write pattern:
                                               # apply + before/after config diff + save + proof
./xikectl apply [--prune] [--dry-run] [--i-know]       # declarative reconcile live->fixture.yaml
                                               # (additive default; guards: mgmt/session-port)
./xikectl interact 'send:X' 'wait:Y' 'prompt'  # interactive dialogs (sub-prompts, e.g.
                                               # user change-privilege-pwd re-auth)
go test ./...                                    # 126 unit tests
```

## The three CLI modes (the #1 trap)

```
Switch>      user-exec       xikectl lands HERE
<Switch>     privilege-exec  enable - password-gated since 2026-07-31 (XIKE_ENABLE_PASS)
[Switch]     global config   system-view  (aaa -> [Switch-aaa]: local-user, ...)
```

A command "not existing" usually means WRONG MODE, not missing feature -
older sessions wrongly concluded "no config/user commands exist" from
user-exec probing. To walk modes use `xikectl probe` (multi-line, one shell,
no error abort); `xikectl run` completes at the first prompt and
cannot enter config mode.

## Top gotchas (all live-verified)

- `display utilization interface` / `display ddm` / `display pmp` HANG
  the SSH session - use `display utilization channel-group`.
- Syslog entries are web-only (no CLI path; use a remote syslog
  destination instead). Optical DDM absent on this hardware.
- User management broken on ALL four paths (web no-op, config-import
  drop, no exec password cmd, CLI local-user stores-but-never-
  authenticates) - box is permanently admin/admin; vendor ticket sent.
- `enable` is password-gated (needs `user privilege-auth always`, not
  the bare command) and `login-acl` is restricted to 10.0.69.0/24
  (snmp/web/telnet) - both fired 2026-07-31; enable password in
  vaultwarden, pass via XIKE_ENABLE_PASS. Both DO show in
  `display current-config` (!!!OAM); the enable password sits there in
  CLEARTEXT - treat every config scrape as a secret (backup warns).
  `?` help on an already-valid command EXECUTES it (help redraws the
  line, trailing newline submits) - probe `?` only on incomplete
  prefixes. Telnet login-acl changes DROP the current SSH session
  (kick, not lockout) - fire them last in a sequence.
- `save current-config` exists ONLY at privilege-exec (user-exec AND
  config mode reject it); saves before 2026-07-31-evening were silent
  no-ops (lowercase "unrecognized" check + vacuous readback diff).
  Save rides RunPrivileged now; first real persist confirmed flash
  holds the hardening.
- Legacy SSH only: ssh-rsa + hmac-sha1, shell-only (no exec channels),
  ONE shell per TCP connection (a 2nd channel can't elevate: "locked
  by other users") - the client holds one shell for its whole life.
  Never `set sysname` (prompt regex hardcodes "Switch").
  Failed-auth lockout exists (failMax).
- 9014B jumbo frames count as "Giants" in port stats - benign.

## Boundaries

- Read-only by default. `save` manual-only, `reboot` NEVER fired
  (maintenance window). Never `save` from a loop/test.
- `cfg` and `set` are live write paths. `set` (2026-07-31) is the full
  pattern: apply + before/after raw config diff + save with persistence
  proof; no-diff after accepted commands = error (firmware accept-but-
  drop class). State changes are one-at-a-time, manual, with readback -
  never from a loop/test.
- `restore`/`apply --prune` (the reconciler above `set`) is designed,
  NOT built - that's the next major work item.
