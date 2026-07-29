# ---------------------------------------------------------------------------
# Encryption / Decryption — SOPS + Age
# ---------------------------------------------------------------------------

# bcrypt_hash [rounds] - prompt for a password (hidden, with confirmation),
# print its bcrypt hash. Verifies the hash round-trips before printing.
# Default cost factor is 12. Needs the `bcrypt` python package.
bcrypt_hash() {
    local rounds="${1:-12}"
    if ! [[ "$rounds" == <-> ]]; then
        echo "Usage: bcrypt_hash [rounds]  (rounds is an integer, default 12)" >&2
        return 1
    fi
    BCRYPT_ROUNDS="$rounds" python3 - <<'PY'
import bcrypt, getpass, os, sys
rounds = int(os.environ["BCRYPT_ROUNDS"])
pw = getpass.getpass("Password: ").encode()
if pw != getpass.getpass("Confirm : ").encode():
    print("Passwords do not match.", file=sys.stderr)
    sys.exit(1)
h = bcrypt.hashpw(pw, bcrypt.gensalt(rounds=rounds))
assert bcrypt.checkpw(pw, h)  # proves the hash matches what you typed
print(h.decode())
PY
}

# ---------------------------------------------------------------------------
# SOPS + Age helpers
# ---------------------------------------------------------------------------

# Extract Age private key from SOPS_AGE_KEYS (explicit match, not tail -n 1)
_sops_age_private_key() {
    local key
    key=$(print -r -- "$SOPS_AGE_KEYS" | grep '^AGE-SECRET-KEY-' | head -1)
    if [[ -z "$key" ]]; then
        echo "Error: No AGE-SECRET-KEY found in SOPS_AGE_KEYS" >&2
        return 1
    fi
    print -r -- "$key"
}

# Extract Age public key from SOPS_AGE_KEYS
_sops_age_public_key() {
    local key
    key=$(print -r -- "$SOPS_AGE_KEYS" | grep -oE 'age1[a-z0-9]+' | head -1)
    if [[ -z "$key" ]]; then
        echo "Error: Failed to extract public key from SOPS_AGE_KEYS" >&2
        return 1
    fi
    print -r -- "$key"
}

encrypt_k3s_secret() {
    local public_key
    public_key=$(_sops_age_public_key) || return 1

    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    if ! sops --encrypt --age "$public_key" --encrypted-regex '^(data|stringData)$' --in-place "$1"; then
        echo "Error: Encryption failed for $1" >&2
        return 1
    fi
}

decrypt_k3s_secret() {
    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    local age_key
    age_key=$(_sops_age_private_key) || return 1

    # Inline env: SOPS_AGE_KEY only exists for duration of sops command
    SOPS_AGE_KEY="$age_key" sops --decrypt --encrypted-regex '^(data|stringData)$' --in-place "$1" || {
        echo "Error: Decryption failed for $1" >&2
        return 1
    }
}

encrypt() {
    if [[ -z "${1:-}" ]]; then
        echo "Usage: encrypt <file|directory>" >&2
        return 1
    fi

    local public_key
    public_key=$(_sops_age_public_key) || return 1

    # If argument is a directory, encrypt all files in it
    if [[ -d "$1" ]]; then
        local dir="$1"
        if [[ -z "$(ls -A "$dir")" ]]; then
            echo "Error: Directory $dir is empty" >&2
            return 1
        fi
        
        for file in "$dir"/*; do
            if [[ -f "$file" ]]; then
                echo "Encrypting: $file"
                if ! sops --encrypt --age "$public_key" --in-place "$file"; then
                    echo "Error: Encryption failed for $file" >&2
                    return 1
                fi
            fi
        done
        return 0
    fi

    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    if ! sops --encrypt --age "$public_key" --in-place "$1"; then
        echo "Error: Encryption failed for $1" >&2
        return 1
    fi
    echo "Encrypted: $1"
}

decrypt() {
    if [[ -z "${1:-}" ]]; then
        echo "Usage: decrypt <file|directory>" >&2
        return 1
    fi

    local age_key
    age_key=$(_sops_age_private_key) || return 1

    # If argument is a directory, decrypt all files in it
    if [[ -d "$1" ]]; then
        local dir="$1"
        if [[ -z "$(ls -A "$dir")" ]]; then
            echo "Error: Directory $dir is empty" >&2
            return 1
        fi
        
        for file in "$dir"/*; do
            if [[ -f "$file" ]]; then
                echo "Decrypting: $file"
                SOPS_AGE_KEY="$age_key" sops --decrypt --in-place "$file" || {
                    echo "Error: Decryption failed for $file" >&2
                    return 1
                }
            fi
        done
        return 0
    fi

    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    SOPS_AGE_KEY="$age_key" sops --decrypt --in-place "$1" || {
        echo "Error: Decryption failed for $1" >&2
        return 1
    }
    echo "Decrypted: $1"
}

# encrypt_all / decrypt_all — operate on current directory
encrypt_all() { encrypt .; }
decrypt_all() { decrypt .; }

encrypt_tf() {
    local named_files=("secrets.tfvars" "terraform.tfvars" "blueprint-export.yaml")
    local count=0

    for file in "${named_files[@]}"; do
        if [[ -f "$file" ]]; then
            encrypt "$file" || return 1
            ((count++))
        fi
    done

    # Glob separately — use (N) nullglob qualifier to avoid error when no matches
    for file in *.tfstate*(N); do
        if [[ -f "$file" ]]; then
            encrypt "$file" || return 1
            ((count++))
        fi
    done

    if (( count == 0 )); then
        echo "No sensitive files found to encrypt." >&2
        return 1
    fi
    echo "Encrypted $count file(s)."
}

decrypt_tf() {
    local named_files=("secrets.tfvars" "terraform.tfvars" "blueprint-export.yaml")
    local count=0

    for file in "${named_files[@]}"; do
        if [[ -f "$file" ]]; then
            decrypt "$file" || return 1
            ((count++))
        fi
    done

    # Glob separately — use (N) nullglob qualifier to avoid error when no matches
    for file in *.tfstate*(N); do
        if [[ -f "$file" ]]; then
            decrypt "$file" || return 1
            ((count++))
        fi
    done

    if (( count == 0 )); then
        echo "No encrypted files found to decrypt." >&2
        return 1
    fi
    echo "Decrypted $count file(s)."
}

# ---------------------------------------------------------------------------
# GPG git-signing cache (key B9D283E8AE4E56B4)
# ---------------------------------------------------------------------------
# gpg-agent caches the passphrase (7d sliding / 30d hard, see
# ~/.gnupg/gpg-agent.conf). Headless shells - tmux loops, pi -p subagents -
# have no TTY for pinentry, so a cold cache kills `git commit` with
# "gpg failed to sign the data". gpg_unlock warms the cache WITHOUT a TTY
# when bw serve is unlocked (item GPG_KEY_PASSPHRASE, passphrase in notes);
# otherwise it prompts once via pinentry.

_GPG_SIGNING_KEY="B9D283E8AE4E56B4"
# Keygrip is a public identifier (like the key fingerprint), NOT key material.
_GPG_SIGNING_KEYGRIP="17BB7DE98DD50550DE2641A694060FE9311D2BB4" # gitleaks:allow

# _gpg_cache_warm - returns 0 if the agent can sign with no passphrase prompt
_gpg_cache_warm() {
    echo cache-probe | gpg --batch --no-tty --pinentry-mode error \
        --clearsign -u "$_GPG_SIGNING_KEY" >/dev/null 2>&1
}

# gpg_unlock - warm the gpg-agent cache for the git signing key.
# (1) no-op if already warm; (2) seed from Vaultwarden via bw serve
#     (headless-safe); (3) one pinentry prompt (interactive fallback).
gpg_unlock() {
    emulate -L zsh

    if _gpg_cache_warm; then
        echo "[gpg] cache already warm for $_GPG_SIGNING_KEY"
        return 0
    fi

    # Headless path: preset from Vaultwarden (bw serve must be unlocked).
    if (( $+functions[_bw_serve_ok] )) && _bw_serve_ok; then
        local pw
        pw=$(_bw_api_get_note GPG_KEY_PASSPHRASE 2>/dev/null)
        if [[ -n "$pw" ]]; then
            # Arch ships the helper off-PATH at /usr/lib/gnupg/.
            local preset="${commands[gpg-preset-passphrase]:-/usr/lib/gnupg/gpg-preset-passphrase}"
            print -rn -- "$pw" | "$preset" --preset "$_GPG_SIGNING_KEYGRIP" 2>/dev/null
            unset pw
            if _gpg_cache_warm; then
                echo "[gpg] cache seeded from Vaultwarden (GPG_KEY_PASSPHRASE)"
                return 0
            fi
            print -u2 "[gpg] bw preset failed - wrong passphrase in GPG_KEY_PASSPHRASE?"
        fi
    fi

    # Interactive fallback: force exactly one pinentry prompt.
    if [[ -t 0 ]]; then
        export GPG_TTY="${GPG_TTY:-$(tty)}"
        echo "[gpg] prompting once via pinentry..."
        if echo cache-warm | gpg --clearsign -u "$_GPG_SIGNING_KEY" >/dev/null && _gpg_cache_warm; then
            echo "[gpg] cache warm until TTL expiry (7d idle / 30d max)"
            return 0
        fi
        print -u2 "[gpg] signing failed after prompt"
        return 1
    fi

    print -u2 "[gpg] no TTY and no bw seed available - cannot warm the cache here."
    print -u2 "      Run 'gpg_unlock' in an interactive shell, or store the passphrase as"
    print -u2 "      the notes of a Vaultwarden item named GPG_KEY_PASSPHRASE."
    return 1
}
