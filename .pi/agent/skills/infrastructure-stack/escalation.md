# infrastructure-stack: beyond compose

Supporting reference for the `infrastructure-stack` skill. When compose stops fitting and what replaces it: the graduation triggers, k3s component swaps and manifest layout, Proxmox VM patterns.

## When to graduate from compose

Compose works fine until one of:

1. **Multiple hosts** - load balancing or HA across machines. Compose has no scheduler. Next step: **k3s** (lightweight k8s, single-binary, suitable for 3-5 node homelab).
2. **Auto-scaling** - workload elasticity. Compose can't scale beyond `--scale N` (static). Next step: k3s + HPA.
3. **Self-healing** - node failure recovery. Compose has no rescheduler.
4. **Secret management at scale** - already solved at compose scale: stacks keep a SOPS-encrypted `.env` in git (`composer` skill for the decrypt-at-deploy cycle, `secret-handling` for key custody). On k3s the equivalent is sealed-secrets or a SOPS operator; HashiCorp Vault only if a second team needs dynamic credentials.

Don't graduate prematurely. The current scale (a couple of dozen stacks across the NAS and the router) fits compose comfortably.

## k3s (when you do graduate)

Single-binary, lightweight k8s. Install via `curl -sfL https://get.k3s.io | sh -`. Bundled components:

- **Traefik** ingress (replaces Caddy) - fine, but Caddy via `caddy-ingress` works too if you want continuity
- **Flannel** CNI - replace with **Cilium** for eBPF observability + better network policy
- **local-path-provisioner** - single-node only; for multi-node use **Longhorn** (replicated block) or **NFS CSI** pointing at the servarr ZFS NAS
- **ServiceLB** (Klipper) - for bare-metal LB without cloud; replace with **MetalLB** for production-grade

Manifest layout convention (when migrating compose -> k3s):

```
~/infra/k3s-myservice/
|-- kustomization.yaml         # references base/ and overlays/
|-- base/
|   |-- deployment.yaml        # replaces the compose service
|   |-- service.yaml           # ClusterIP, replaces network static-IP
|   |-- ingress.yaml           # replaces Caddyfile entry
|   `-- pvc.yaml               # replaces bind-mount
`-- overlays/
    `-- prod/
        |-- kustomization.yaml
        `-- replica-count.yaml
```

Use **Helm only for upstream charts you didn't write**. For your own services, raw manifests + `kustomize` is cleaner.

## Proxmox VMs (when compose is too much overhead)

For workloads that need a full VM (Windows, GPU passthrough, kernel modules, security isolation). No Proxmox host is in the fleet today; these are the patterns to apply if one is stood up:

- **VM template via cloud-init**: build once, clone N times. Ubuntu 24.04 LTS + cloud-init datasource = baseline.
- **Snapshotting before changes** - Proxmox snapshots are cheap, restore is instant.
- **Backup via Proxmox Backup Server** (separate host) - incremental, dedup'd, encrypted.
- **Mount cluster filesystems via virtiofs** for shared data (faster than 9p, near-native).
- **Don't use containers in VMs except for transition** - adds a layer of overhead. Either commit to VMs or commit to containers per workload.

## Backups

Owned by `zfs-storage` (sanoid snapshots + syncoid replication + pg_dump timers on servarr) and `compose-backups` (offen sidecars for off-host copies). Compose YAML + AGENTS.md are backed up by being in git; the SOPS-encrypted `.env` in each stack repo is canonical and the age key custody rules are in `secret-handling`.
