#!/usr/bin/env bash
# test-rotation.sh - deterministic sensor for sops_rotate_age.
# Runs the function against the fixture tree and checks invariants.
# NEVER prints decrypted content; verification is recipient/format/exit-code based.
# Exit 0 = all checks pass; exit 1 with FAILED lines otherwise.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FIX="$HERE/fixtures"
FN="$HERE/../../functions.d/crypto.zsh"
OLD_PUB=$(grep -oE 'age1[a-z0-9]+' "$HERE/key-old.txt")
NEW_PUB=$(grep -oE 'age1[a-z0-9]+' "$HERE/key-new.txt")
export SOPS_AGE_KEY_FILE="$HERE/test-keys.txt"

fails=0
chk() { # chk <name> <condition...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    fails=$((fails+1))
  fi
}

# 0. fixtures must exist and be wrapped to OLD key (precondition)
chk "precondition: fixtures wrapped to old key" \
  bash -c "grep -q '$OLD_PUB' '$FIX/nested/a/secrets.tfvars'"

# 1. function syntax
chk "zsh syntax: crypto.zsh parses" zsh -n "$FN"

# 2. run the function (default mode: updatekeys) non-interactively
out=$(timeout 120 zsh -c "
  source '$FN'
  SOPS_ROTATE_CHECK_GH=0 sops_rotate_age '$OLD_PUB' '$NEW_PUB' '$FIX'
" 2>&1)
rc=$?
chk "run 1: exit 0" test "$rc" -eq 0
chk "run 1: no FAILED lines" bash -c "! grep -q 'FAILED' <<<\"$out\""

# 3. every sops file now has ONLY the new recipient
for f in $(find "$FIX" -type f ! -name '*.md' ! -name '.sops.yaml'); do
  chk "recipient only-new: ${f#$FIX/}" \
    bash -c "grep -oE 'age1[a-z0-9]+' '$f' | sort -u | grep -qx '$NEW_PUB'"
done

# 4. format preservation
chk "format: tfvars stays binary-container" \
  bash -c "head -c 4096 '$FIX/nested/a/secrets.tfvars' | grep -q '\"data\": \"ENC\['"
chk "format: tfstate stays binary-container" \
  bash -c "head -c 4096 '$FIX/bigfile/terraform.tfstate' | grep -q '\"data\": \"ENC\['"
chk "format: yaml keeps ^sops: metadata" \
  bash -c "grep -q '^sops:' '$FIX/nested/b/users_database.yml'"
chk "format: dotenv keeps ENC inline style" \
  bash -c "grep -q '^ADMIN_TOKEN=ENC\[' '$FIX/nested/c/.env'"
chk "format: json keeps structured keys" \
  bash -c "grep -q '\"api_key\": \"ENC\[' '$FIX/nested/a/config.json'"

# 5. decryptability (to /dev/null; content never printed)
for f in $(find "$FIX" -type f ! -name '*.md' ! -name '.sops.yaml'); do
  chk "decrypts: ${f#$FIX/}" sops -d -o /dev/null "$f"
done

# 6. no fixture plaintext survived in encrypted files
for pat in fixture-cf-key-aaa111 fixture-token-bbb222 fixture-json-key-ccc333 fixture-anchored-pass-ddd444 fixture-kube-token-eee555 fixture-gate-secret-fff666; do
  chk "no plaintext leak: $pat" \
    bash -c "! grep -rF '$pat' '$FIX' --exclude='*.md' | grep -q ."
done

# 7. prose replaced (old key gone, new key present, doc otherwise intact)
chk "prose: NOTES.md has new key" grep -q "$NEW_PUB" "$FIX/NOTES.md"
chk "prose: NOTES.md lost old key" bash -c "! grep -q '$OLD_PUB' '$FIX/NOTES.md'"
chk "prose: anchored/README.md has new key" grep -q "$NEW_PUB" "$FIX/anchored/README.md"
chk "prose: .sops.yaml recipient updated" grep -q "$NEW_PUB" "$FIX/anchored/.sops.yaml"

# 8. no stray temp .sops.yaml left beside standalone files
chk "cleanup: no temp .sops.yaml in standalone/" \
  bash -c "! -e '$FIX/standalone/.sops.yaml'"

# 9. idempotency: second run is a no-op
out2=$(timeout 120 zsh -c "
  source '$FN'
  SOPS_ROTATE_CHECK_GH=0 sops_rotate_age '$OLD_PUB' '$NEW_PUB' '$FIX'
" 2>&1)
chk "run 2: no files contain old key" \
  bash -c "grep -q 'No files contain the old key' <<<\"$out2\""

# 10. FULL mode also works end-to-end on a fresh fixture copy
"$HERE/build-fixtures.sh" >/dev/null 2>&1
out3=$(timeout 240 zsh -c "
  source '$FN'
  SOPS_ROTATE_FULL=1 SOPS_ROTATE_CHECK_GH=0 sops_rotate_age '$OLD_PUB' '$NEW_PUB' '$FIX'
" 2>&1)
rc3=$?
chk "full mode: exit 0" test "$rc3" -eq 0
chk "full mode: no FAILED lines" bash -c "! grep -q 'FAILED' <<<\"$out3\""
for f in $(find "$FIX" -type f ! -name '*.md' ! -name '.sops.yaml'); do
  chk "full recipient only-new: ${f#$FIX/}" \
    bash -c "grep -oE 'age1[a-z0-9]+' '$f' | sort -u | grep -qx '$NEW_PUB'"
  chk "full decrypts: ${f#$FIX/}" sops -d -o /dev/null "$f"
done
chk "full format: tfvars stays binary-container" \
  bash -c "head -c 4096 '$FIX/nested/a/secrets.tfvars' | grep -q '\"data\": \"ENC\['"

echo
if [ "$fails" -eq 0 ]; then
  echo "ALL CHECKS PASS"
  exit 0
else
  echo "$fails CHECK(S) FAILED"
  exit 1
fi
