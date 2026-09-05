---
name: drawbridge
description: "Use when operating or changing drawbridge - the user's mTLS-gated, route-allowlisted, audited reverse proxy in front of servarr's Docker Engine socket (repo ~/infra/drawbridge). Fires on 'drawbridge', 'docker socket proxy', 'mTLS docker', ':2376', '403 drawbridge: route not allowed', allowlist / cert rotation / audit-log questions, upgrading the servarr docker gateway, or composer remote-host TLS failures. NOT for composer itself (composer) or tailnet transport (tailscale-homelab)."
---

# drawbridge skill

mTLS + route-allowlist + audit-log reverse proxy for the Docker Engine API. Single static Go binary, distroless multi-arch image. Runs on the docker host (servarr) as one pinned container; composer on the MS-01 router is the only client today.

```
composer (MS-01 router)           drawbridge (servarr)
  docker SDK/CLI --mTLS:2376-->   allowlist -> audit -> /var/run/docker.sock
```

## Operational facts

- **Deployment**: a NixOS `virtualisation.oci-containers` unit on servarr - `docker-drawbridge.service`, image tag pinned in `~/infra/servarr-nixos/modules/drawbridge.nix`, `--network=host`. Deploy/upgrade = bump the tag in that module, commit, `make deploy` in `~/infra/servarr-nixos` (rebuilds servarr; `nixos` skill). The repo's `make deploy-servarr` / `scripts/deploy-servarr.sh` (`docker run`) predates the NixOS unit and would fight it - do not use it on servarr. `deploy/compose.yaml` is only the declarative reference for hosts that run compose. Both files hold `DRAWBRIDGE_*` values registered with secretctl, so the guard blocks reading them; verify live state over ssh instead (`ssh servarr 'systemctl is-active docker-drawbridge; docker inspect drawbridge --format "{{.Config.Image}}"'`).
- **Listeners** (`DRAWBRIDGE_LISTEN`): LAN address of servarr `:2376` as primary plus its tailnet IP `:2376` as backup, mTLS (TLS 1.3, `RequireAndVerifyClientCert`). Resolve the tailnet IP with `ssh router tailscale status`; do not hard-code it. A loopback-only plaintext health listener (`DRAWBRIDGE_HEALTH_LISTEN`) serves `/healthz` for the container HEALTHCHECK. `/metrics` (Prometheus) is on the mTLS listener.
- **Composer side**: the host registry entry for `servarr` points at one of the listeners above (check it via the composer API, `composer` skill). Client certs live on the router at `/var/lib/composer/certs/servarr/{ca,cert,key}.pem` (docker CLI naming), mounted into the composer container as `/var/lib/composer/certs:/certs:ro` in `~/infra/router/configuration.nix` - that mount is load-bearing.
- **Deliberately NOT composer-managed**: composer reaches servarr's docker THROUGH drawbridge, so composer managing drawbridge would be a self-dependency loop (a bad deploy severs the management plane needed to roll back).
- **Audit trail** = `docker logs drawbridge` on servarr (one slog JSON line per request: peer_cn, version-stripped path, matched rule, status; mutations INFO, denials WARN, reads DEBUG).
- **Trust root**: CA + client private keys are sops+age encrypted and COMMITTED at `secrets/{ca,client}-key.sops.pem` under a drawbridge-only age identity (`~/.config/sops/age/drawbridge.txt`, deliberately NOT composer's key - composer must never be able to decrypt drawbridge's trust root). Recover with `make ca-decrypt` / `make client-cert-decrypt`. **Standing gap**: `TODO.md` still lists the off-box backup of that age private key as open; until it is done, losing this workstation loses the ability to mint client certs. Escrow procedure: the `secret-handling` skill.

## Default-deny allowlist

Routes not in the allowlist return `403 drawbridge: route not allowed`. Matching happens AFTER stripping the `/vX.Y` API version prefix. The embedded default (`internal/allowlist/default.yaml`) covers everything composer + `docker compose` need (containers, exec, images, build/buildkit, networks, volumes, events) and excludes the dangerous set (attach, secrets, push, prune, swarm, plugins). Override with `DRAWBRIDGE_ALLOWLIST=/path/to/file.yaml`. If composer gains a feature that needs a new docker endpoint (e.g. a prune endpoint for remote hosts), the allowlist likely needs a rule - a sudden 403 on one route class after a composer upgrade is the signature.

## Design invariants (from repo AGENTS.md - do not break)

1. Default deny (see above).
2. mTLS always on the main listener; the ONLY plaintext path is the loopback health listener.
3. Hijack transparency: exec/attach-style 101 upgrades must pass through; `statusWriter` implements `http.Hijacker` + `http.Flusher`. Covered by `TestProxy_HijackPassThrough` - run it if you touch proxy.go.
4. Audit everything (one JSON line per request).
5. Metric cardinality: prometheus labels use allowlist rule names, NEVER raw paths (container/image IDs explode cardinality).
6. Root by design: the container opens the docker socket; hardening is read-only fs + cap_drop ALL + mTLS + allowlist, not UID games.
7. Cert rotation is hot-reload (atomic), no restart needed.

## Commands

```bash
make build     # bin/drawbridge
make test      # go test ./...
make lint      # go vet + gofmt check
make docker    # buildx --load dev image
bin/drawbridge serve                  # run the proxy
bin/drawbridge certgen --out certs --san <ip> --san <dns> --client-cn composer-servarr
bin/drawbridge healthcheck            # probes the loopback health listener
```

## Smoke test (from any host with the client certs)

```bash
DB=<servarr LAN or tailnet IP>:2376
export DOCKER_HOST=tcp://$DB DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/path/to/certs
docker ps        # stock CLI works as-is; no-cert connections die at the TLS handshake
curl -s --cacert ca.pem --cert cert.pem --key key.pem https://$DB/v1.47/containers/json | jq length
curl -s --cacert ca.pem --cert cert.pem --key key.pem https://$DB/v1.47/secrets   # expect 403 drawbridge
```

## Debugging composer <-> drawbridge failures

- `TLS material: stat /certs/servarr/ca.pem` on composer = the `/var/lib/composer/certs:/certs:ro` mount is missing (configuration.nix regression - see the composer skill's upgrade policy).
- Remote containers showing 'No such container' in the composer UI while local works = frontend not threading `host` or wrong host param (fixed in composer v0.20.0).
- Handshake failures from a new client = cert not signed by the drawbridge CA, or SAN/hostname mismatch; mint a new client cert with `certgen --client-cn <name>` on a box that can decrypt the CA key.
- Denials appear as WARN lines in `docker logs drawbridge` with the matched (or unmatched) route - check there first, not on the composer side.
- Listener bound to a stale address after a servarr IP change = `DRAWBRIDGE_LISTEN` in the NixOS module; the unit restarts on rebuild.

Repo: `~/infra/drawbridge` (AGENTS.md has layout + full invariants; TODO.md tracks remaining migration chores, some of which still describe the pre-NixOS `docker run` deploy). Go 1.26, stdlib-first; deps are only `prometheus/client_golang` + `gopkg.in/yaml.v3`.
