#!/usr/bin/env bash
# build-fixtures.sh - create a fixture tree mimicking every real shape the
# sops_rotate_age function must handle. Idempotent: rm -rf then rebuild.
#
# Shapes covered (mapped to real repos):
#   binary cf-tf style   {"data": "ENC[...]"} .tfvars/.tfstate (cf-tf)
#   big EOF metadata     >16KB binary sops file, sops block at end (tfstate)
#   yaml                 ^sops: metadata (k3s yaml, authelia users_database.yml)
#   dotenv               .env files (vaultwarden, gatekeeper)
#   json                 "sops": metadata structured keys (json configs)
#   anchored repo        .sops.yaml + encrypted + prose (forgejo, monitoring)
#   standalone           encrypted file, no .sops.yaml anywhere (kube, gatekeeper)
#   prose                docs mentioning the old key (AGENTS.md, SKILL.md)
#   nested dirs          same shapes spread across 3 subdirs
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FIX="$HERE/fixtures"
OLD_PUB=$(grep -oE 'age1[a-z0-9]+' "$HERE/key-old.txt")
KEYS="$HERE/test-keys.txt"

# combined key file: sops decrypts with old, re-wraps with new
cat "$HERE/key-old.txt" "$HERE/key-new.txt" > "$KEYS"
export SOPS_AGE_KEY_FILE="$KEYS"

rm -rf "$FIX"
mkdir -p "$FIX"/{anchored/secrets,standalone,nested/{a,b,c},bigfile}

enc() { # enc <type> <in> <out>
  sops -e --age "$OLD_PUB" --input-type "$1" --output-type "$1" "$2" > "$3"
  rm -f "$2"
}

# --- binary cf-tf style (tfvars is dotenv content encrypted as binary) ---
printf 'cloudflare_api_key = "fixture-cf-key-aaa111"\ncloudflare_email   = "fixture@example.com"\n' > /tmp/fx-tfvars
enc binary /tmp/fx-tfvars "$FIX/nested/a/secrets.tfvars"

# --- big binary with EOF metadata (tfstate shape, ~20KB) ---
python3 - <<'PY'
import json
doc = {"version": 4, "resources": [{"name": f"res_{i}", "id": "x"*200} for i in range(60)]}
open("/tmp/fx-tfstate","w").write(json.dumps(doc, indent=1))
PY
enc binary /tmp/fx-tfstate "$FIX/bigfile/terraform.tfstate"

# --- yaml ---
printf 'users:\n  fixtureadmin:\n    password: "$argon2id$fixturehash"\n    displayname: "Fixture Admin"\n' > /tmp/fx-yaml
enc yaml /tmp/fx-yaml "$FIX/nested/b/users_database.yml"

# --- dotenv ---
printf 'ADMIN_TOKEN=fixture-token-bbb222\nDATABASE_URL=postgres://fixture:x@db/fixture\n' > /tmp/fx-env
enc dotenv /tmp/fx-env "$FIX/nested/c/.env"

# --- json ---
printf '{\n  "api_key": "fixture-json-key-ccc333",\n  "endpoint": "https://fixture.internal"\n}\n' > /tmp/fx-json
enc json /tmp/fx-json "$FIX/nested/a/config.json"

# --- anchored repo: .sops.yaml + encrypted + prose ---
cat > "$FIX/anchored/.sops.yaml" <<EOF
creation_rules:
  - path_regex: ^secrets/.*$
    age: $OLD_PUB
EOF
printf 'db_password: fixture-anchored-pass-ddd444\n' > /tmp/fx-anch
enc yaml /tmp/fx-anch "$FIX/anchored/secrets/app.yaml"
cat > "$FIX/anchored/README.md" <<EOF
# fixture repo
the age recipient for secrets is $OLD_PUB
rotate with sops updatekeys.
EOF

# --- standalone (no .sops.yaml anywhere up the tree) ---
printf 'kube_token: fixture-kube-token-eee555\n' > /tmp/fx-kube
enc yaml /tmp/fx-kube "$FIX/standalone/config.local"

# --- standalone dotenv (gatekeeper shape) ---
printf 'GATE_SECRET=fixture-gate-secret-fff666\n' > /tmp/fx-gate
enc dotenv /tmp/fx-gate "$FIX/standalone/.env"

# --- prose only ---
cat > "$FIX/NOTES.md" <<EOF
# notes
public key reference: $OLD_PUB (appears in docs like AGENTS.md and SKILL.md)
EOF

echo "fixtures built under $FIX"
find "$FIX" -type f | sort
