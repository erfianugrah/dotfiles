---
name: xikectl
description: Use when reading switch state (VLANs, interfaces, MAC table, MTU/jumbo, port stats, STP, LLDP, ARP, CPU/memory/fan) from the user's XikeStor SKS8300-12E2T2X at 10.0.69.4 via xikectl, running the live smoke or verify suites, adding a show resource, probing switch CLI commands, saving or backing up switch config, or bouncing a port. Fires on 'xikectl', 'XikeStor', 'SKS8300', 'the switch', 'switch VLANs/ports', 'display vlan', 'trunk port'. NOT for the router (eaves) or DNS (knotctl).
---

# xikectl - operator CLI for the XikeStor switch

**Status: in service, replacement pending.** This switch is being migrated to OpenWrt (fork `github.com/erfianugrah/openwrt`, branch `sks8300-edge`; plan `~/infra/xikectl/docs/plans/2026-08-09-openwrt-replacement.md`). xikectl retires after cutover - fix what the cutover needs, do not grow the tool.

Switch: SKS8300-12E2T2X at `10.0.69.4`, firmware V1.04.B09, PRODUCTION
(carries the servarr trunk). Tool repo: `~/infra/xikectl`
(single Go module). **Read `~/infra/xikectl/AGENTS.md` first when working
in the repo** - it has the full gotcha list. Design + live facts:
`~/infra/xikectl/docs/xikectl-plan.md`. Rebuild after pulling grammar changes: the binary bakes in the validator grammar, and a stale binary rejects a VALID config at restore pre-flight.

## Quick reference

```bash
cd ~/infra/xikectl && go build -o xikectl ./cmd/xikectl
export XIKE_USER=admin XIKE_PASS=admin          # XIKE_HOST defaults to 10.0.69.4

./xikectl show vlan|interfaces|mac|mtu|...      # 27 resources, --json available
                                               # [--via cli|web]; transceiver + processes are
                                               # WEB-ONLY (ASP pages, no CLI path exists)
./xikectl smoke                                  # live e2e: 25 cli + 3 web-backed rows, ~15s
./xikectl verify                                 # drift vs fixture.yaml + version cli==web A/B
./xikectl save                                   # persist to flash + readback (manual only)
./xikectl backup --running -o backup.cfg         # CLI scrape (web exporter is a lie)
./xikectl cfg "display vlan"                   # config-mode sequence (enable->system-view->cmds->end)
                                               # THE WRITE PATH - state changes go here, manual + readback
                                               # needs XIKE_ENABLE_PASS
./xikectl set "interface eth0/0/5" "description foo"   # full write pattern:
                                               # apply + before/after config diff + save + proof
./xikectl cfg "interface eth0/1/1" "shutdown" "undo shutdown"  # PORT BOUNCE
                                               # (servarr flap recovery; runbook: repo PORT-RESET.md;
                                               # cfg not set -
                                               # transient, no flash save)
./xikectl apply [--prune] [--dry-run] [--i-know]       # declarative reconcile live->fixture.yaml
                                               # (additive default; guards: mgmt/session-port)
./xikectl restore <file> [--dry-run]           # validate config file (strict section grammar),
                                               # upload as BOOT config via web, exporter byte-proof.
                                               # Takes effect at NEXT REBOOT.
./xikectl interact 'send:X' 'wait:Y' 'prompt'  # interactive dialogs (sub-prompts, e.g.
                                               # user change-privilege-pwd re-auth)
./xikectl reboot [--timeout 5m]                  # web SetReset=2, waits for SSH return (~1 min);
                                               # maintenance-window only
go test ./...                                    # unit tests (fixture-driven parsers)
```

## The three CLI modes (the #1 trap)

```
Switch>      user-exec       xikectl lands HERE
<Switch>     privilege-exec  enable - password-gated (XIKE_ENABLE_PASS)
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
- Syslog entries are web-only (no CLI path; syslog ships to the router:
  info-center 10.0.69.1 -> router vector -> Silo). Optical DDM absent
  on this hardware, but basic SFP inventory + process list ARE
  readable via the ASP web backend (show transceiver / show processes).
- The ASP content pages (/configchn/*.asp) are a second read surface
  : server-rendered management-DB views, stable id anchors;
  WebLogin (source-IP session) precedes every WebGet. version is
  dual-backed; uptime formats differ between transports by design.
- User management broken on ALL four paths (web no-op, config-import
  drop, no exec password cmd, CLI local-user stores-but-never-
  authenticates) - box is permanently admin/admin; vendor ticket sent.
- `enable` is password-gated (needs `user privilege-auth always`, not
  the bare command) and `login-acl` is restricted to 10.0.69.0/24
  (snmp/web/telnet). Pass the enable password via XIKE_ENABLE_PASS;
  its store is NOT yet registered with secretctl (the repo has no `.env`)
  - where it should live and how to hand it to a process without
  printing it: the `secret-handling` skill. Both settings DO show in
  `display current-config` (!!!OAM); the enable password sits there in
  CLEARTEXT - treat every config scrape as a secret (backup warns).
  `?` help on an already-valid command EXECUTES it (help redraws the
  line, trailing newline submits) - probe `?` only on incomplete
  prefixes. Telnet login-acl changes DROP the current SSH session
  (kick, not lockout) - fire them last in a sequence.
- `save current-config` exists ONLY at privilege-exec (user-exec AND
  config mode reject it). Save rides RunPrivileged; an OK-looking
  readback proves nothing unless the diff can actually see the change
  you just made (the readback diff only models VLANs/ports/ifaces/routes
  - !!!OAM edits are invisible to it).
- Legacy SSH only: ssh-rsa + hmac-sha1, shell-only (no exec channels),
  ONE shell per TCP connection (a 2nd channel can't elevate: "locked
  by other users") - the client holds one shell for its whole life.
  sysname renames the prompt mid-session - the client re-anchors on a
  successful sysname and re-learns non-default names at login (the box
  IS named xikeswitch); still never set it
  casually. Failed-auth lockout exists (failMax).
- 9014B jumbo frames count as "Giants" in port stats - benign.

## Boundaries

- Read-only by default. `save` manual-only. `reboot` is proven (~1 min to SSH+CLI;
  hardening + sysname persist) but maintenance-window-only. Never `save` from a loop/test.
- `cfg` and `set` are live write paths. `set` is the full
  pattern: apply + before/after raw config diff + save with persistence
  proof; no-diff after accepted commands = error (firmware accept-but-
  drop class). State changes are one-at-a-time, manual, with readback -
  never from a loop/test.
- The write lane is complete and live-proven: `set`, `apply --prune`, and
  `restore` (validate + web upload, BOOT config).
- Ops runbooks in the repo: FACTORY-RESET.md (systemReset=3 wipe +
  rebuild), PASSWORD-RESET.md (enable password rotation via interact;
  login password immutable - broken user mgmt), PORT-RESET.md (remote
  port bounce shutdown/undo shutdown - servarr flap recovery; never
  bounce the trunk eth0/1/4 from a session that rides it).
