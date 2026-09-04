---
name: flint-openwrt
description: Use when operating the user's Flint 2 (GL-MT6000) access point on mainline OpenWrt - SSID/key/channel/bridge changes, deploying or verifying config, the box unreachable, iwinfo showing Tx-Power 0 dBm, hostapd "errors found in configuration file", a reflash or u-boot recovery, or when router/switch config must agree on the wireless (VLAN 100, 10.0.72) and IoT (VLAN 400, 10.0.73) segments. Fires on 'flint', 'FLINT_2', 'FLINT_IOT', 'GL-MT6000', '10.0.72.2', 'deploy.sh'. NOT for the retired GL firmware or the MS-01 router itself.
---

# flint-openwrt - operating the Flint 2 on mainline OpenWrt

Repo: `~/infra/flint-openwrt` (read its AGENTS.md). The Flint is a bridged
WAP under the MS-01 router: mgmt **10.0.72.2**, key-only ssh
(`-i ~/.ssh/id_flint_erlis`), stock OpenWrt 24.10.8, SSIDs FLINT_2 (2.4G),
FLINT_2_5G (5G), FLINT_IOT (2.4G, isolated, VLAN 400). Router mode config
exists in `config/router/` for a future move; untested on hardware.

## Quick reference

| Want to | Do |
|---|---|
| Change wireless/system config | edit `config/*` (keys stay placeholders), then `./deploy.sh root@10.0.72.2 ap` (reboots the box) |
| Rotate WPA keys | edit `flint-secrets.env` (gitignored), redeploy. IoT key: `make rotate-wifi` in ~/infra/hearth does all four stores |
| Un-reflashed IoT devices cannot join | set `LEGACY_IOT_KEY` in `flint-secrets.env`, redeploy: a temporary `erfi-iot` VAP appears; remove the var after the OTA sweep (hearth `docs/plans/2026-09-04-iot-readoption.md`) |
| Verify | `ssh -i ~/.ssh/id_flint_erlis root@10.0.72.2 'iwinfo; logread \| grep -i "errors found"'` - 3 SSIDs, real Tx-Power, zero errors; then a real client on FLINT_2_5G gets a 10.0.72.x lease |
| Box on a subnet this machine cannot route to | `DEPLOY_SSH_OPTS="-J root@10.0.72.1 -i ~/.ssh/id_flint_erlis" ./deploy.sh root@<ip> ap`; add a temporary alias on the router VLAN interface if needed |
| Fresh box / bricked | GL u-boot recovery, `docs/flash-runbook.md` Recovery section |
| Which VLAN / subnet / switch port | `docs/network-model.md` - the one table (router `vlans` attrset and any switch config must match it) |
| What happened last time | `docs/cutover-2026-09-04.md` |

## Rules that bite

- **Stock image = wpad-basic.** No `bss_transition` (802.11v). One unknown
  hostapd key drops the WHOLE interface; the only visible symptom is
  `Tx-Power: 0 dBm` and `HT Mode: NOHT` in iwinfo. Check `logread | grep
  "errors found"` first. Want 802.11v back: `opkg install wpad-mbedtls`
  (replaces wpad-basic-mbedtls), then re-add the option.
- **First boot is 192.168.1.1, root, no password**, radios off, WAN port
  DHCPs from Kea at once. The Kea log on the router
  (`journalctl -u kea-dhcp4-server -o cat | grep -i 94:83:c4:a3:f9:0a`) is
  the liveness signal, not ping.
- **A 192.168.1.1 ping reply is not the Flint** if the machine has another
  uplink (hotspot). Confirm with `arp -a` / `tracert` on the cabled
  interface. The laptop port must be static 192.168.1.2/24 for u-boot
  recovery (no DHCP server there); stock OpenWrt does serve DHCP.
- **Do not press reset on a running box you cannot see.** >5 s = factory
  reset + reboot on mainline; held through power-on = u-boot recovery.
- **PiKVM OTG safety net is unproven** (`docs/otg-safety-net.md`). Do not
  plan a flash around it.
- **deploy.sh order matters:** it pushes `authorized_keys` before the
  dropbear config that disables password auth. Losing the key = u-boot
  recovery. Do not "simplify" that order.
- **Router-side edits go live on the next composer bump commit.**
  `~/infra/router/configuration.nix` must never hold uncommitted edits;
  see the router repo notes.

## Common mistakes

- Percent-style `txpower` values (GL habit). Mainline wants dBm; omit for
  regulatory max.
- Flashing the `factory` image via u-boot. Wiki: sysupgrade only.
- Using `scp` to the box: no sftp-server on stock. deploy.sh cat-pipes.
- `ssh` with BatchMode against the first-boot box works (empty password is
  accepted); a normal known_hosts mismatch after a flash is expected -
  deploy.sh clears it.
