---
name: drawbridge
description: "Work on or operate `drawbridge` - the user's mTLS-gated, route-allowlisted, audited reverse proxy for the Docker Engine API (repo `~/infra/drawbridge`, image `ghcr.io/erfianugrah/drawbridge`, Go stdlib-first). It fronts `/var/run/docker.sock` on servarr so composer on MS-01 can manage servarr's containers over the tailnet without a plaintext socket. Fires on 'drawbridge', 'docker socket proxy', 'mTLS docker', 'tcp://100.69.69.7:2376', '403 drawbridge: route not allowed', allowlist/cert rotation/audit-log questions, deploying or upgrading the servarr docker gateway, or debugging composer remote-host TLS failures. Sibling to `composer` (the management plane that connects through it) and `tailscale-homelab` (transport)."
---

# drawbridge skill

mTLS + route-allowlist + audit-log reverse proxy for the Docker Engine API. Single static Go binary, distroless multi-arch image. Runs on the docker host (servarr) as one pinned container; composer on MS-01 is the only client today.

```
composer (MS-01)                  drawbridge (servarr)
  docker SDK/CLI --mTLS:2376-->   allowlist -> audit -> /var/run/docker.sock
```

## Operational facts (live, verified 2026-07)

- Listener: servarr tailscale IP `100.69.69.7:2376` only (mTLS, TLS 1.3, `RequireAndVerifyClientCert`). Loopback-only plaintext `:2377/healthz` for the container HEALTHCHECK. `/metrics` (Prometheus) is on the mTLS listener.
- Composer's host registry entry: `{"id":1,"name":"servarr","endpoint":"tcp://100.69.69.7:2376","cert_dir":"/certs/servarr"}`. Client certs live on MS-01 at `/var/lib/composer/certs/servarr/{ca,cert,key}.pem` (docker CLI naming), mounted into the composer container as `/certs:ro` - that mount existing in BOTH router.nix copies is load-bearing.
- Deliberately NOT composer-managed: composer reaches servarr's docker THROUGH drawbridge, so composer managing drawbridge would be a self-dependency loop (a bad deploy severs the management plane needed to roll back).
- servarr has NO docker compose (neither plugin nor v1) - deploy/upgrade is `make deploy-servarr TAG=x.y.z` (idempotent `docker run`, `restart: always`). `deploy/compose.yaml` is only the declarative reference for hosts that do have compose.
- Audit trail = `docker logs drawbridge` (one slog JSON line per request: peer_cn, version-stripped path, matched rule, status; mutations INFO, denials WARN, reads DEBUG).
- CA + client private keys are sops+age encrypted and COMMITTED at `secrets/*.sops.pem` under a drawbridge-only age identity (`~/.config/sops/age/drawbridge.txt`, deliberately NOT composer's key - composer must never be able to decrypt drawbridge's trust root). Recover with `make ca-decrypt` / `make client-cert-decrypt`. TODO-check: that age private key was due a Vaultwarden backup (manual, needs `bw unlock`) - verify before assuming DR coverage.

## Default-deny allowlist

Routes not in the allowlist return `403 drawbridge: route not allowed`. Matching happens AFTER stripping the `/vX.Y` API version prefix. The embedded default (`internal/allowlist/default.yaml`) covers everything composer + `docker compose` need (containers, exec, images, build/buildkit, networks, volumes, events) and excludes the dangerous set (attach, secrets, push, prune, swarm, plugins). Override with `DRAWBRIDGE_ALLOWLIST=/path/to/file.yaml`. If composer gains a feature that needs a new docker endpoint (e.g. a prune endpoint for remote hosts), the allowlist likely needs a rule - a sudden 403 on one route class after a composer upgrade is the signature.

## Design invariants (from repo AGENTS.md - do not break)

1. Default deny (see above).
2. mTLS always on the main listener; the ONLY plaintext path is loopback `/healthz`.
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
SERVARR_TAILSCALE_IP=100.69.69.7 make deploy-servarr TAG=<ver>   # deploy/upgrade on servarr
```

## Smoke test (from any tailnet host with the client certs)

```bash
export DOCKER_HOST=tcp://100.69.69.7:2376 DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/path/to/certs
docker ps        # stock CLI works as-is; no-cert connections die at the TLS handshake
curl -s --cacert ca.pem --cert cert.pem --key key.pem https://100.69.69.7:2376/v1.47/containers/json | jq length
curl -s --cacert ca.pem --cert cert.pem --key key.pem https://100.69.69.7:2376/v1.47/secrets   # expect 403 drawbridge
```

## Debugging composer <-> drawbridge failures

- `TLS material: stat /certs/servarr/ca.pem` on composer = the `/var/lib/composer/certs:/certs:ro` mount is missing (router.nix regression - see the composer skill's upgrade policy).
- Remote containers showing 'No such container' in the composer UI while local works = frontend not threading `host` (fixed in composer v0.20.0) or wrong host param.
- Handshake failures from a new client = cert not signed by the drawbridge CA, or SAN/hostname mismatch; mint a new client cert with `certgen --client-cn <name>` on a box that can decrypt the CA key.
- Denials appear as WARN lines in `docker logs drawbridge` with the matched (or unmatched) route - check there first, not on the composer side.

Repo: `/home/erfi/drawbridge` (AGENTS.md has layout + full invariants; TODO.md tracks remaining migration chores). Go 1.26, stdlib-first; deps are only `prometheus/client_golang` + `gopkg.in/yaml.v3`.
