# AGENTS.md - ergo workspace

Seven independent Go projects (the proxy/edge services workspace), each with
its own git repo and `go.mod`:

| Directory | Description | Go | Sub-project AGENTS.md |
|---|---|---|---|
| `caddy-body-matcher/` | Caddy plugin: HTTP request body matching | 1.25.1 | Yes |
| `caddy-policy-engine/` | Caddy plugin: policy rule evaluation engine (WAF) | 1.26.1 | Yes |
| `caddy-ddos-mitigator/` | Caddy plugin: adaptive DDoS/DoS mitigation | 1.26.1 | No |
| `caddy-compose/` | Docker Compose infra: edge Caddy + wafctl + dashboard (Authelia retired 2026-07) | 1.26.0 | Yes |
| `coraza-caddy/` | Fork of the OWASP Coraza WAF Caddy module (standalone; NOT wired into the edge Dockerfile) | 1.25.1 | No |
| `souin/` | Fork of darkweak/souin - edge HTTP cache patches. Compiled into the edge Caddy image via `--with ...=erfianugrah/souin@v1.7.7-erfi.1` (Dockerfile), but no `cache` handler is configured (see Architecture Notes) | 1.24 | No |
| `vigil/` | Fleet vulnerability sweeps: trivy orchestration + CISA KEV / EPSS enrichment + CI gating | 1.26.6 | Yes |

No top-level go.mod. The Code Style and Build sections below cover the
erfi-authored projects; the two forks (`coraza-caddy/`, `souin/`) keep
upstream layout and conventions, and `vigil/` has its own AGENTS.md.

> **Direction change (2026-08-09)**: the CRS/WAF side (caddy-policy-engine, CRS
> converter, challenge/PoW) is slated for removal - see caddy-compose/PLAN.md
> "Direction Change". wafctl survives and will be renamed **edgectl**, becoming
> the edge control plane (ddos/jail/events now, host-config management via the
> Caddy admin API next).

## Build & Test Commands

### Go plugins (caddy-body-matcher, caddy-policy-engine, caddy-ddos-mitigator)

```bash
go test -race -count=1 ./...                          # All tests
go test -race -count=1 -run TestCondition_Eq_Match ./... # Single test (regex)
go test -race -count=1 -run TestZone ./...             # Tests matching prefix
go test -bench=BenchmarkAC -benchmem ./...             # Benchmarks
xcaddy build --with github.com/erfianugrah/<plugin>    # Build into Caddy binary
go vet ./... && go mod tidy                            # Always run before committing
```

Always use `-race -count=1`. `-count=1` disables test caching; `-race` catches
data races in concurrency tests that exist in all plugins.

### caddy-compose - wafctl (Go backend, ~632 tests)

```bash
cd caddy-compose && make test                          # All tests (Go + frontend)
cd caddy-compose/wafctl && go test -count=1 -timeout 60s ./...          # Go only
cd caddy-compose/wafctl && go test -run TestFunctionName -count=1 -timeout 60s ./... # Single
```

### caddy-compose - waf-dashboard (Astro/React frontend, ~338 tests)

```bash
cd caddy-compose/waf-dashboard && npx vitest run       # All frontend tests
cd caddy-compose/waf-dashboard && npx vitest run -t "description substring" # Single
cd caddy-compose/waf-dashboard && npx tsc --noEmit     # Type check
```

### caddy-compose - E2E & Docker

```bash
cd caddy-compose/test/e2e && go test -v -count=1 -timeout 600s ./...    # E2E (needs Docker)
cd caddy-compose/test/e2e && go test -v -count=1 -timeout 60s -run TestName ./... # Single E2E
DDOS_LOAD=1 go test -v -count=1 -timeout 600s -run "TestDDoS" ./...     # DDoS load (opt-in)
make build         # All Docker images     make check  # tests + tsc + astro build
make build-caddy   # Caddy image only      make scan   # Trivy vulnerability scan
make build-wafctl  # wafctl image only     make test-cache  # edge HTTP cache harness (local, no Docker build)
```

## Lint / Format

No dedicated linter config. Use:
- `gofmt -w .` for Go formatting
- `go vet ./...` before every commit
- TypeScript strict mode via `astro/tsconfigs/strict`

## Secrets

`.env` in caddy-compose is SOPS-encrypted (age). A pre-commit hook blocks
unencrypted `.env`, `.tfvars`, `.tfstate` files. Never commit plaintext secrets.

## Code Style - Go (all projects)

### Imports

Two or three groups separated by blank lines, alphabetically sorted:
1. Standard library
2. Third-party (`github.com/caddyserver/caddy/v2`, `go.uber.org/zap`)
3. Internal (if applicable)

Named imports only when necessary (e.g. `libinjection "github.com/corazawaf/libinjection-go"`).

### Naming Conventions

- **Exported types**: PascalCase - `PolicyEngine`, `MatchBody`, `DDOSMitigator`
- **Unexported types**: camelCase - `compiledRule`, `compiledCondition`
- **Constants**: camelCase - `defaultMaxSize`, `numShards`
- **Variables**: Short contextual names - `pe`, `cr`, `cc`, `rls`
- **JSON struct tags**: `snake_case,omitempty` - `json:"max_size,omitempty"`
- **Files**: lowercase, underscores - `ratelimit.go`, `rl_analytics.go`
- **Test functions**: `Test<Subject>_<Scenario>` - `TestCondition_Eq_Match`

### Error Handling

- Wrap with `fmt.Errorf("context: %w", err)` - always `%w`.
- Return errors as last value. Check immediately; never defer error checks.
- No sentinel error variables - errors are constructed inline.
- Early returns for guard clauses.
- In `Match()`/`ServeHTTP()`: log I/O errors at Debug level, never propagate up.
- In tests: `t.Fatal(err)` or `t.Fatalf(...)` for immediate failure.
- wafctl HTTP errors: `writeJSON(w, statusCode, ErrorResponse{...})`.
- wafctl store mutations: rollback-on-error (save old state, apply new, revert on failure).

### Concurrency

- `sync.RWMutex` on stores/hot-reload; `RLock` for reads, `Lock` for writes.
- `atomic.Int64` for offset tracking; `atomic.Bool` for guard flags.
- Return deep copies from getters to prevent concurrent modification.
- `sync.Pool` for buffer reuse (policy-engine).
- Channel-based goroutine lifecycle with `close()` for shutdown.

### Struct & File Organization

- Section separators: `// --- Section ---` or `// ─── Section ──────────`
- Group struct fields by category with section comments.
- Interface guards at bottom of file: `var _ caddy.Module = (*PolicyEngine)(nil)`
- Caddy plugin pattern: `init()` -> `CaddyModule()` -> `Provision()` -> `Validate()` -> runtime methods -> `UnmarshalCaddyfile()`
- Value receivers for read-only methods (`Match`, `ServeHTTP`); pointer receivers for mutating (`Provision`, `Validate`).
- Each config type has a compiled counterpart created at provision time (e.g. `PolicyRule` -> `compiledRule`).

### wafctl-specific patterns

- **Zero external deps** - stdlib only.
- Go 1.22+ route patterns: `mux.HandleFunc("GET /api/health", handler)`
- Closure-based DI: `handleSummary(store, als) http.HandlerFunc`
- JSON helpers: `writeJSON()`, `decodeJSON()` (5 MB limit).
- Atomic file writes via `atomicWriteFile()` (write temp, fsync, rename).
- Config from env: `envOr("KEY", "default")`.

## Code Style - TypeScript/React (waf-dashboard)

- **Path alias**: `@/` maps to `./src/`
- **API layer**: domain modules in `src/lib/api/` with barrel export via `index.ts`
- Go returns `snake_case` JSON; API modules map to `camelCase` TypeScript interfaces.
- shadcn/ui in `src/components/ui/`; `cn()` for className merging.
- Astro static MPA - file-based routing, pre-rendered HTML.
- Read URL params in `useEffect` (client-only), never in `useState` initializer.
- Cross-page links: native `<a href>`, not SPA navigation.
- Components over ~500 lines split into feature subdirs (`policy/`, `ratelimits/`).

## Testing Conventions

- All Go tests are **white-box** (same package), standard `testing` only - no testify/gomock.
- Table-driven tests with `t.Run()` subtests.
- Test helpers at top of test files: `testContext()`, `mustProvision()`, `makeRequest()`, etc.
- wafctl handlers: `httptest.NewRequest` + `httptest.NewRecorder`; `httptest.NewServer` for Caddy admin API mocks.
- Frontend: Vitest with `vi.fn()` mock fetch, `describe`/`it`, `beforeEach`/`afterEach`.

## Version Sync

Tags must stay in sync across: `Makefile`, `compose.yaml`,
`deploy/edge/compose.yaml`, `README.md`, `.github/workflows/build.yml`.
Update all five when bumping versions.

## Architecture Notes

- Deploy pipeline: generate config -> write `policy-rules.json` -> plugin detects mtime -> hot-reload.
- Unified rule store: `ExclusionStore` handles all rule types. `/api/rules` is canonical CRUD; `/api/deploy` triggers deploy.
- DDoS mitigator shares IP jail with wafctl via `/data/waf/jail.json` (bidirectional file sync). The plugin's `runFileSync` detects IPs removed from the file by wafctl and removes them from the in-memory jail.
- Caddy plugin ordering: `order log_append first`, `order ddos_mitigator after log_append`, `order policy_engine after ddos_mitigator`.
- Edge HTTP cache (edge variant only, `deploy/edge/Caddyfile`): REMOVED from config 2026-08-07 (commit 02b0706) - the souin fork + nuts modules are still compiled into the image but no `cache` handler is configured anywhere. Before re-enabling, read test/cache/README.md (7 verified quirks, incl. per-site nuts storage requirements from the 2026-07-31 incident and the broken purge API / SWR bugs). Ops tool: `tools/cachectl` (note: its `verify` assert still checks for a global cache block that no longer exists). Detail: caddy-compose/AGENTS.md "Edge HTTP cache".
