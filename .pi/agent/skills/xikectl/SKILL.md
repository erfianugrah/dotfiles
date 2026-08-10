---
name: xikectl
description: Drive the user's `xikectl` CLI - the operator tool for the XikeStor SKS8300-12E2T2X switch at 10.0.69.4 (edge switch between the MS-01 router and the servarr box). Use when reading switch state (VLANs, interfaces, MAC table, MTU/jumbo, port stats, STP, LLDP, ARP, CPU/memory/fan), running the live smoke or verify suites, adding a show resource, probing switch CLI commands, saving/backing up switch config, or planning the switch write lane (set/apply/restore) or reboot. Fires on "xikectl", "XikeStor", "SKS8300", "the switch", "switch VLANs/ports", "jumbo MTU on the switch", "display vlan", "trunk port". NOT for router/DHCP/NAT/firewall (that's `eaves` on the NixOS router), DNS (`knotctl`/`gloryhole`), or the arr media stack (`arr-stack`). Sibling to `eaves`, `tailscale-homelab`, `caddy`. Repo `~/infra/xikectl`, Go, 162 unit tests + live smoke green.
---

# xikectl - operator CLI for the XikeStor switch

Switch: SKS8300-12E2T2X at `10.0.69.4`, firmware V1.04.B09, PRODUCTION
(carries the servarr trunk). Tool repo: `~/infra/xikectl`
(single Go module). **Read `~/infra/xikectl/AGENTS.md` first when working
in the repo** - it has the full gotcha list. Design + live facts:
`~/infra/xikectl/docs/xikectl-plan.md`.

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
                                               # needs XIKE_ENABLE_PASS since 2026-07-31 (vaultwarden)
./xikectl set "interface eth0/0/5" "description foo"   # full write pattern:
                                               # apply + before/after config diff + save + proof
./xikectl cfg "interface eth0/1/1" "shutdown" "undo shutdown"  # PORT BOUNCE
                                               # (servarr flap recovery; verified 2026-08-10,
                                               # runbook: repo PORT-RESET.md; cfg not set -
                                               # transient, no flash save)
./xikectl apply [--prune] [--dry-run] [--i-know]       # declarative reconcile live->fixture.yaml
                                               # (additive default; guards: mgmt/session-port)
./xikectl restore <file> [--dry-run]           # validate config file (strict section grammar),
                                               # upload as BOOT config via web, exporter byte-proof.
                                               # Takes effect at NEXT REBOOT.
./xikectl interact 'send:X' 'wait:Y' 'prompt'  # interactive dialogs (sub-prompts, e.g.
                                               # user change-privilege-pwd re-auth)
./xikectl reboot [--timeout 5m]                  # web SetReset=2, waits for SSH return.
                                               # Live-fired 2026-08-01 (54s); maintenance-window only
go test ./...                                    # 162 unit tests
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
- Syslog entries are web-only (no CLI path; LIVE since 2026-07-31:
  info-center 10.0.69.1 -> router vector -> minio). Optical DDM absent
  on this hardware, but basic SFP inventory + process list ARE
  readable via the ASP web backend (show transceiver / show processes).
- The ASP content pages (/configchn/*.asp) are a second read surface
  (2026-08-01): server-rendered management-DB views, stable id anchors;
  WebLogin (source-IP session) precedes every WebGet. version is
  dual-backed; uptime formats differ between transports by design.
- User management broken on ALL four paths (web no-op, config-import
  drop, no exec password cmd, CLI local-user stores-but-never-
  authenticates) - box is permanently admin/admin; vendor ticket sent.
- `enable` is password-gated (needs `user privilege-auth always`, not
  the bare command) and `login-acl` is restricted to 10.0.69.0/24
  (snmp/web/telnet) - both fired 2026-07-31; enable password in
  vaultwarden (item XIKESTOR_ENABLE_PASSWORD, in the NOTES field -
  login.password is null), pass via XIKE_ENABLE_PASS. Both DO show in
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
  sysname renames the prompt mid-session - the client re-anchors on a
  successful sysname and re-learns non-default names at login (the box
  IS renamed to xikeswitch since 2026-07-31); still never set it
  casually. Failed-auth lockout exists (failMax).
- 9014B jumbo frames count as "Giants" in port stats - benign.

## Boundaries

- Read-only by default. `save` manual-only. `reboot` first live-fired
  2026-08-01 (54s to SSH+CLI; hardening + sysname verified persisted) -
  still maintenance-window-only. Never `save` from a loop/test.
- `cfg` and `set` are live write paths. `set` (2026-07-31) is the full
  pattern: apply + before/after raw config diff + save with persistence
  proof; no-diff after accepted commands = error (firmware accept-but-
  drop class). State changes are one-at-a-time, manual, with readback -
  never from a loop/test.
- The write lane is COMPLETE: `set`, `apply --prune`, and `restore`
  (validate + web upload, BOOT config) all live-fired 2026-07-31.
- Ops runbooks in the repo: FACTORY-RESET.md (systemReset=3 wipe +
  rebuild), PASSWORD-RESET.md (enable password rotation via interact;
  login password immutable - broken user mgmt), PORT-RESET.md (remote
  port bounce shutdown/undo shutdown - servarr flap recovery; never
  bounce the trunk eth0/1/4 from a session that rides it).
