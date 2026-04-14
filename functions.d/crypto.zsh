# ---------------------------------------------------------------------------
# Encryption / Decryption — SOPS + Age
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
