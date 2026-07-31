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
./xikectl smoke                                  # live e2e: all 24 resources, ~2min
./xikectl verify                                 # drift vs fixture.yaml
./xikectl save                                   # persist to flash + readback (manual only)
./xikectl backup --running -o backup.cfg         # CLI scrape (web exporter is a lie)
./xikectl cfg "display vlan"                   # config-mode sequence (enable->system-view->cmds->end)
                                               # THE WRITE PATH - state changes go here, manual + readback
go test ./...                                    # 78 fixture-driven unit tests
```

## The three CLI modes (the #1 trap)

```
Switch>      user-exec       xikectl lands HERE
<Switch>     privilege-exec  enable - NO password
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
- `enable` has no password; `login-acl` allows 0.0.0.0/0 - hardening
  items pending (`user change-privilege-pwd`, restrict login-acl).
- Legacy SSH only: ssh-rsa + hmac-sha1, shell-only (no exec channels),
  pager + fast-expiring confirms - always go through `xikectl.Client`,
  never a stock ssh client. Failed-auth lockout exists (failMax).
- 9014B jumbo frames count as "Giants" in port stats - benign.

## Boundaries

- Read-only by default. `save` manual-only, `reboot` NEVER fired
  (maintenance window). Never `save` from a loop/test.
- `cfg` IS a live write path (built 2026-07-31 on `xikectl.RunConfig`):
  config-mode `display`/`?` are safe; state-changing commands are
  one-at-a-time, manual, with readback - never from a loop/test.
- `set`/`apply`/`restore` (the reconciler above `cfg`) is designed,
  NOT built - that's the next major work item.
