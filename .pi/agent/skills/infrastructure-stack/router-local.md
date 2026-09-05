# infrastructure-stack: router-local stacks (MS-01)

Supporting reference for the `infrastructure-stack` skill. The extra constraints for composer-managed stacks that run on the MS-01 router itself (nftables policy-drop bridges, 172.20.x subnets, absolute host paths, pg18 mount, busybox shells).

## Router-local stacks (MS-01 / ssh `router`) - different rules than servarr

Composer-managed stacks ON the router itself (edge-services, forgejo, knotea,
ripe-atlas at the time of writing - `GET /api/v1/stacks` and filter on host
`local` for the live list) have constraints the servarr pattern doesn't:

1. **Subnets**: router uses `172.31.x` (edge-* nets) and `172.20.x`
   (composer-managed local stacks). svcnet is 10.68.50.0/24. Pick a free
   172.20.x `/24`; check with
   `ssh router 'docker network inspect $(docker network ls -q) --format "{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}"'`.
2. **Bridge names MUST be pinned** (`driver_opts:
   com.docker.network.bridge.name: <stack>0`) AND added to `dockerBridges` in
   `~/infra/router/configuration.nix`, then `make deploy` on the router repo.
   The router's nftables forward chain is policy-drop; unlisted bridges get
   NO inter-container traffic (symptom: `connection timed out` between
   containers while the containers themselves are healthy). Compose will NOT
   recreate existing networks when you add driver_opts - `down`, delete the
   networks, `up` (through the composer API, never raw compose).
3. **Bridge->LAN (10.0.0.0/8) is also dropped.** A bridge-attached container
   cannot reach servarr services (e.g. MinIO at 10.0.71.x). Host-originated
   traffic always works, and the host CAN hairpin its own WAN IP - so a
   container that needs LAN egress should use `network_mode: host` and reach
   bridge-IP services via their static IP.
4. **Bind mounts must be absolute router-host paths**, never `./relative`:
   the compose checkout is read by composerd inside its container, whose view
   of the stacks dir differs from the daemon's. The two paths and how to
   verify the bind-mount are in the `composer` skill ("Stack location on disk").
5. **postgres:18+ images**: mount the data volume at `/var/lib/postgresql`,
   NOT `/var/lib/postgresql/data` (pg18 image convention; PGDATA lands in a
   `data/docker` subdir).
6. **alpine shells are busybox**: no GNU date (`date -d '30 days ago'`
   fails) - use epoch math: `date -d @$(( $(date +%s) - 2592000 )) +%Y%m%d`.

memledger used to be router-local and hit every one of these; it moved to
servarr and its bridges were dropped from `dockerBridges`, so do not use it as
a router example.
