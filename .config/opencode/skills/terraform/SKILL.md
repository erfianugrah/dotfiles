---
name: terraform
description: Infrastructure-as-code with OpenTofu (preferred) or Terraform — module structure, state backends (S3 / R2 / local), provider version pinning, SOPS+age secrets, `tflint` / `tfsec` linting, `terraform import` and `cf-terraforming` for adopting existing resources, drift detection, and the dir-per-environment layout the user employs. Covers the OpenTofu fork rationale, provider upgrade migrations (esp. Cloudflare v4→v5), `for_each` + `dynamic` block patterns, and dependency graph debugging. Use when writing or refactoring `.tf` files, importing existing cloud resources, setting up a new IaC repo, or migrating from Terraform to OpenTofu. Pairs with `cloudflare` (for the actual CF resources) and the `infrastructure-stack` skill.
---

# Terraform / OpenTofu

## Core principles

1. **Prefer OpenTofu (`tofu`) over `terraform`.** Same HCL, drop-in-compatible, BSL-free, community-driven. The user already uses `tofu` locally. CI/automation should call `tofu`.
2. **Pin the provider major.** `version = "~> 4.0"` lets you take patches but not breaking changes. Read provider CHANGELOGs before bumping the major.
3. **State is the source of truth.** If state and reality diverge, fix state via `terraform import` / `terraform state rm` / `terraform state mv` — don't blow away resources.
4. **Plan before apply, always.** `tofu plan -out=tfplan && tofu apply tfplan` so what gets applied is exactly what was reviewed.
5. **One state per blast radius.** Group resources so a state corruption or accidental destroy only kills one logical unit (a zone, an app, an account). Smaller is safer.
6. **No secrets in `.tf` or `.tfvars`.** SOPS+age, environment variables, or a secrets manager.

## OpenTofu vs Terraform

| | OpenTofu (`tofu`) | Terraform (`terraform`) |
|---|---|---|
| License | MPL 2.0 (free, true OSS) | BSL 1.1 (source-available, not OSS) |
| Compatibility | All HCL 1.x + providers + modules | Same |
| Backend support | Same set + community backends | HashiCorp's list |
| Encryption-at-rest for state | **Yes (native, since 1.7)** | No (must use cloud KMS) |
| Deletion-time provisioners | **Yes (1.8+)** | No |
| CLI | Drop-in `tofu` for `terraform` | `terraform` |

Migration is `mv terraform.tfstate{,.bak} && tofu init && tofu plan` — state format is identical.

The user runs OpenTofu locally (`tofu` binary). Default to `tofu` in any new repo.

## Repo layout (dir-per-environment, modules subdirectory)

This is the user's pattern:

```
.
├── README.md
├── account_details/             # Account-level resources (one state)
│   ├── main.tf
│   ├── provider.tf
│   ├── variables.tf
│   ├── terraform.tfstate
│   └── secrets.enc.tfvars       # SOPS-encrypted
├── main_zone/                   # Zone-level resources (separate state)
│   ├── dns.tf
│   ├── dnssec.tf
│   ├── http_request_firewall_ruleset.tf
│   ├── lb.tf
│   ├── data.tf                  # data sources
│   ├── provider.tf              # provider block + version pin
│   ├── variables.tf
│   └── modules/
│       ├── dns_records/         # reusable submodule
│       │   ├── main.tf
│       │   ├── variables.tf
│       │   └── outputs.tf
│       └── certificate_packs/
└── zero_trust/                  # Access + Gateway + Tunnels
```

**Why this layout**:

- Each top-level dir is an independent state. `tofu apply` in `main_zone/` doesn't touch `zero_trust/`.
- Modules (`modules/dns_records/`) are reusable from any parent dir.
- One blast radius per dir — accidental `destroy` only kills the dir's resources.

**Avoid**: terraform workspaces for environments. Use directories. Workspaces share `.tf` source — drift in branching logic gets impossible to reason about.

## Provider block (Cloudflare example, user's actual config)

```hcl
# provider.tf
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  # User's actual rate-limit defence — CF default of 4 req/s is conservative
  max_backoff = "10"
  min_backoff = "2"
  retries     = "5"
  rps         = "4"
}
```

**Auth is via env var** `CLOUDFLARE_API_TOKEN`. Never put the token in `.tf`.

### Required versions

```hcl
terraform {
  required_version = ">= 1.6, < 2.0"      # OpenTofu 1.6+ for state encryption
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    aws        = { source = "hashicorp/aws",        version = "~> 5.0" }
    random     = { source = "hashicorp/random",     version = "~> 3.6" }
  }
}
```

## State backends

### Local (default — fine for personal infra)

```hcl
# No backend block needed; state lives in terraform.tfstate alongside .tf files.
# Commit only terraform.tfstate.lock.info and .terraform.lock.hcl. NEVER commit
# terraform.tfstate or terraform.tfstate.backup — they may contain secrets.
```

`.gitignore`:

```
*.tfstate
*.tfstate.*
.terraform/
.terraform.tfstate.lock.info
*.tfvars
!example.tfvars
```

### Cloudflare R2 (S3-compatible — ideal for CF-heavy infra)

```hcl
terraform {
  backend "s3" {
    bucket                      = "<bucket-name>"
    key                         = "main_zone/terraform.tfstate"
    region                      = "auto"
    endpoint                    = "https://<account-id>.r2.cloudflarestorage.com"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    # Locking: R2 supports object-version-based locking via use_lockfile = true (TF 1.10+)
    use_lockfile                = true
  }
}
```

Set `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` to R2 token's credentials before `tofu init`.

### AWS S3 + DynamoDB locking

```hcl
backend "s3" {
  bucket         = "<bucket>"
  key            = "<env>/<service>/terraform.tfstate"
  region         = "us-east-1"
  encrypt        = true
  dynamodb_table = "terraform-locks"   # CREATE separately: { LockID: STRING (hash) }
}
```

### Native state encryption (OpenTofu 1.7+)

```hcl
terraform {
  encryption {
    key_provider "pbkdf2" "default" {
      passphrase = "TF_STATE_PASSPHRASE"   # via env, NOT inline
    }
    method "aes_gcm" "default" {
      keys = key_provider.pbkdf2.default
    }
    state {
      method   = method.aes_gcm.default
      enforced = true
    }
    plan {
      method   = method.aes_gcm.default
      enforced = true
    }
  }
}
```

Then `TF_STATE_PASSPHRASE=$(pass tofu/state-key) tofu apply`.

## Secrets management

### SOPS + age (user's pattern)

```sh
# One-time setup
age-keygen -o ~/.config/sops/age/keys.txt
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt

# In repo root, .sops.yaml configures which files get encrypted with which key
cat .sops.yaml <<'EOF'
creation_rules:
  - path_regex: secrets\.enc\.tfvars$
    age: age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EOF

# Create encrypted vars file
sops secrets.enc.tfvars
# (opens $EDITOR; save and SOPS encrypts on disk)

# Apply
sops exec-env secrets.enc.tfvars 'tofu apply'
# or decrypt to disk + clean up
sops -d secrets.enc.tfvars > /tmp/decrypted.tfvars
tofu apply -var-file=/tmp/decrypted.tfvars
shred -u /tmp/decrypted.tfvars
```

**`.gitignore`** must include `*.tfvars` with `!secrets.enc.tfvars` exception (so the encrypted file IS committed).

### Environment variables (for tokens)

```sh
export TF_VAR_cloudflare_api_token="..."   # → var.cloudflare_api_token
export CLOUDFLARE_API_TOKEN="..."          # provider auto-reads (preferred)
```

## Workflow

```sh
tofu init                            # download providers + configure backend
tofu init -upgrade                   # bump within version constraints
tofu fmt -recursive                  # canonical formatting
tofu validate                        # syntax + schema check (offline)
tofu plan -out=tfplan                # SAVE plan to a file
tofu show tfplan                     # human-readable diff
tofu apply tfplan                    # apply EXACTLY the saved plan

# Per-resource targeting (debug only — never habitualize)
tofu plan -target=cloudflare_record.api
tofu apply -target=cloudflare_record.api

# Refresh state from real infrastructure (no changes)
tofu refresh

# Destroy (DANGEROUS)
tofu plan -destroy -out=destroy.plan
tofu apply destroy.plan
```

## Importing existing resources

For resources created outside Terraform (clicked in dashboard, created via CLI/API).

### Modern: `import` blocks (TF 1.5+, OT 1.6+) — preferred

```hcl
# Append to .tf, then plan + apply
import {
  to = cloudflare_record.api
  id = "<zone-id>/<record-id>"
}

resource "cloudflare_record" "api" {
  zone_id = var.zone_id
  name    = "api"
  type    = "A"
  value   = "203.0.113.1"
  proxied = true
}
```

```sh
# Generate the resource block automatically from the import ID
tofu plan -generate-config-out=generated.tf
# Then move/edit generated.tf to fit your style
```

### Classic: `terraform import` CLI

```sh
tofu import cloudflare_record.api <zone-id>/<record-id>
```

The CLI form only updates state — you still have to write the resource block by hand. Prefer `import` blocks.

### Bulk import for Cloudflare via `cf-terraforming`

See the `cloudflare` skill — `cf-terraforming generate` + `cf-terraforming import` produces both the .tf and the import script for an entire resource type at once.

## `for_each` and `dynamic` blocks

### `for_each` over a map (preferred over `count` — keys are stable)

```hcl
variable "records" {
  type = map(object({
    type    = string
    value   = string
    proxied = bool
  }))
}

resource "cloudflare_record" "this" {
  for_each = var.records
  zone_id  = var.zone_id
  name     = each.key            # the map key
  type     = each.value.type
  value    = each.value.value
  proxied  = each.value.proxied
  ttl      = 1
}

# Usage:
# records = {
#   "api"  = { type = "A",     value = "203.0.113.1", proxied = true  }
#   "mx-1" = { type = "MX",    value = "...",         proxied = false }
# }
```

Why `for_each` over `count`: removing the middle element of a `count`'d list shifts indices, causing destroy+recreate of everything after it. Maps are keyed by name — stable.

### `dynamic` blocks (for repeated nested blocks)

```hcl
resource "cloudflare_ruleset" "firewall" {
  zone_id = var.zone_id
  name    = "Custom WAF"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  dynamic "rules" {
    for_each = var.rules
    content {
      action      = rules.value.action
      expression  = rules.value.expression
      description = rules.key
      enabled     = true
    }
  }
}
```

### Conditional resource via `for_each = toset([...])`

```hcl
# Create only if a flag is set
resource "cloudflare_certificate_pack" "wildcard" {
  for_each = var.wildcard_cert_enabled ? toset(["wildcard"]) : toset([])
  # ... rest of config
}
```

## Linting + safety

```sh
# Install once
brew install tflint     # or paru -S tflint-bin
brew install tfsec      # or paru -S tfsec-bin

# .tflint.hcl
cat > .tflint.hcl <<'EOF'
plugin "terraform" { enabled = true, preset = "recommended" }
plugin "cloudflare" {
  enabled = true
  version = "0.4.0"
  source  = "github.com/terraform-linters/tflint-ruleset-cloudflare"
}
EOF

tflint --init                 # download plugins
tflint                         # lint
tfsec .                        # security scan
trivy config .                 # alternative scanner, catches misconfig
```

`pre-commit` integration (`.pre-commit-config.yaml`):

```yaml
repos:
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.92.0
    hooks:
      - id: terraform_fmt
      - id: terraform_validate
      - id: terraform_tflint
      - id: terraform_tfsec
```

## Migrations

### Cloudflare provider v4 → v5 (relevant for user)

v5 is a major schema rewrite. Key changes:

- `cloudflare_record` → `cloudflare_dns_record` (resource name change, attribute rename `value` → `content`)
- `cloudflare_ruleset` parameters restructured
- New `account_id` required as top-level (no longer inferred)
- Many implicit defaults removed (must be set explicitly)

**Migration approach**:

```sh
# 1. Snapshot current state
cp terraform.tfstate terraform.tfstate.pre-v5

# 2. Use the Cloudflare-provided migration tool
go install github.com/cloudflare/terraform-provider-cloudflare/migration-helper@latest
migration-helper --state terraform.tfstate --version 5

# 3. Manual review of rewritten .tf
# 4. tofu init -upgrade
# 5. tofu plan        # expect SOME no-ops + SOME real changes; review carefully
# 6. tofu apply
```

Stay on v4 until you have time to dedicate to the migration — it's not a casual bump.

### Refactoring resources (rename without destroy/recreate)

```hcl
# moved blocks (TF 1.1+, OT 1.6+)
moved {
  from = cloudflare_record.api_old
  to   = cloudflare_record.api
}
```

Or via CLI:

```sh
tofu state mv cloudflare_record.api_old cloudflare_record.api
```

## Drift detection

```sh
# Plan-only — exits 0 if no drift, 2 if drift present
tofu plan -detailed-exitcode -out=/dev/null
# In CI: nonzero exit triggers alert / GitHub issue
```

For continuous drift detection: schedule a job that runs `tofu plan -detailed-exitcode` and pages on exit code 2. Tools like Atlantis, Terramate, or Spacelift do this natively.

## Debugging

```sh
TF_LOG=DEBUG tofu plan 2>&1 | tee plan.log
# TF_LOG=TRACE for max verbosity (API request/response bodies)

# Inspect state
tofu state list                              # all resource addresses
tofu state show cloudflare_record.api        # full attrs of one resource
tofu state pull > /tmp/state.json            # dump full state JSON
jq '.resources[] | select(.type == "cloudflare_record") | .instances[].attributes.name' /tmp/state.json

# Graph (DOT format)
tofu graph -type=plan | dot -Tsvg > graph.svg

# Show planned changes for a specific resource
tofu plan -out=tfplan && tofu show -json tfplan | jq '.resource_changes[] | select(.address == "cloudflare_record.api")'
```

## Common footguns

1. **Forgetting to `tofu init` after backend change** — the next plan fails cryptically. Re-init resolves.
2. **Using `count` then removing the middle element** — destroys + recreates everything after. Use `for_each` with a map.
3. **Sensitive vars leaking into plan output** — mark with `sensitive = true` in the variable block.
4. **`terraform.tfstate` committed by accident** — secrets exposed. Always `.gitignore` + scan with `git log -p -- '*.tfstate'`.
5. **`tofu destroy` in the wrong directory** — `pwd` before destroy, double-check, or use `-target` to scope.
6. **Provider version drift between dev + CI** — pin in `.terraform.lock.hcl` AND commit it.
7. **State locks held after Ctrl+C** — `tofu force-unlock <lock-id>` (only if you're sure no one else is applying).
8. **Module changes not reflected** — `tofu init -upgrade` re-downloads modules.
9. **Cloudflare `proxied = true` on records pointing to private IPs** — Cloudflare refuses. Set `proxied = false` for internal DNS.
10. **Trying to `import` a managed resource** — error. Run `terraform state rm` first, then `import`.

## Related skills

- **`cloudflare`** — actual CF resources (DNS / Workers / Pages / Zero Trust) + `cf-terraforming` import workflow.
- **`infrastructure-stack`** — the compose stacks behind Caddy that the CF resources point to.
- **`fly`** — `flyctl` for the fly.io control plane (no Terraform needed; `fly.toml` is the IaC).
