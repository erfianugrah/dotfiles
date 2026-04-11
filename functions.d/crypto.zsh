# ---------------------------------------------------------------------------
# Encryption / Decryption — SOPS + Age
# ---------------------------------------------------------------------------

encrypt_k3s_secret() {
    local public_key
    public_key=$(echo "$SOPS_AGE_KEYS" | sed -n 's/.*public key: \([A-Za-z0-9]*\).*/\1/p' | head -1)
    
    if [[ -z "$public_key" ]]; then
        echo "Error: Failed to extract public key from SOPS_AGE_KEYS" >&2
        return 1
    fi

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

    SOPS_AGE_KEY=$(echo -e "$SOPS_AGE_KEYS" | tail -n 1)
    export SOPS_AGE_KEY
    
    if ! sops --decrypt --encrypted-regex '^(data|stringData)$' --in-place "$1"; then
        echo "Error: Decryption failed for $1" >&2
        return 1
    fi
}

encrypt() {
    local public_key
    public_key=$(echo "$SOPS_AGE_KEYS" | sed -n 's/.*public key: \([A-Za-z0-9]*\).*/\1/p' | head -1)
    
    if [[ -z "$public_key" ]]; then
        echo "Error: Failed to extract public key from SOPS_AGE_KEYS" >&2
        return 1
    fi

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

_is_sops_encrypted() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    # Check for sops markers in the first few lines (YAML/JSON)
    if head -5 "$file" | grep -qE '"sops"|sops_|encrypted_regex|lastmodified|mac:' 2>/dev/null; then
        return 0
    fi
    # Fallback: check if it's a JSON file with a .sops key
    if jq -e '.sops' "$file" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

decrypt() {
    SOPS_AGE_KEY=$(echo -e "$SOPS_AGE_KEYS" | tail -n 1)
    export SOPS_AGE_KEY

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
                if ! sops --decrypt --in-place "$file"; then
                    echo "Error: Decryption failed for $file" >&2
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

    if ! sops --decrypt --in-place "$1"; then
        echo "Error: Decryption failed for $1" >&2
        return 1
    fi
    echo "Decrypted: $1"
}

encrypt_all() {
    local public_key
    public_key=$(echo "$SOPS_AGE_KEYS" | sed -n 's/.*public key: \([A-Za-z0-9]*\).*/\1/p' | head -1)
    
    if [[ -z "$public_key" ]]; then
        echo "Error: Failed to extract public key from SOPS_AGE_KEYS" >&2
        return 1
    fi

    for file in *; do
        if [[ -f "$file" ]]; then
            echo "Encrypting: $file"
            if ! sops --encrypt --age "$public_key" --in-place "$file"; then
                echo "Error: Encryption failed for $file" >&2
                return 1
            fi
        fi
    done
}

decrypt_all() {
    SOPS_AGE_KEY=$(echo -e "$SOPS_AGE_KEYS" | tail -n 1)
    export SOPS_AGE_KEY

    for file in *; do
        if [[ -f "$file" ]]; then
            echo "Decrypting: $file"
            if ! sops --decrypt --in-place "$file"; then
                echo "Error: Decryption failed for $file" >&2
                return 1
            fi
        fi
    done
}

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
