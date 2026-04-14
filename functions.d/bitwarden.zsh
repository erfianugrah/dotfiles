# ---------------------------------------------------------------------------
# Bitwarden Serve API — core accessor layer
# ---------------------------------------------------------------------------
# Instead of bulk-exporting secrets via `bw list items`, we query the local
# bw serve REST API (127.0.0.1:8087). Run `bw_serve_start` once after login.
# ---------------------------------------------------------------------------

BW_SERVE_PORT="${BW_SERVE_PORT:-8087}"
BW_SERVE_ADDR="http://127.0.0.1:${BW_SERVE_PORT}"
_BW_SESSION_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"

typeset -gA _BW_CACHE _BW_CACHE_TS
_BW_CACHE_TTL=300  # 5 minutes in-memory cache

# ---------------------------------------------------------------------------
# Secret mappings — single source of truth
# Format: "bw_item_name|ENV_VAR_NAME"
# Add new secrets here. load_bw and unset_bw_vars both read from these.
# ---------------------------------------------------------------------------
_BW_SECRETS=(
    "CLOUDFLARE_EMAIL|CLOUDFLARE_EMAIL"
    "CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ID"
    "CLOUDFLARE_ZONE_ID|CLOUDFLARE_ZONE_ID"
    "CLOUDFLARE_API_KEY|CLOUDFLARE_API_KEY"
    "CLOUDFLARE_ACCESS_OLLAMA_ID|CLOUDFLARE_ACCESS_OLLAMA_ID"
    "CLOUDFLARE_ACCESS_OLLAMA_SECRET|CLOUDFLARE_ACCESS_OLLAMA_SECRET"
    "CARGO_ROOT_KEY|CARGO_REGISTRY_TOKEN"
    "AWS_SECRET_ACCESS_KEY_ERFI|AWS_SECRET_ACCESS_KEY"
    "AWS_ACCESS_KEY_ID_ERFI|AWS_ACCESS_KEY_ID"
    "AUTHENTIK_TOKEN|AUTHENTIK_TOKEN"
    "CLOUDFLARE_TOKEN|CLOUDFLARE_TOKEN"
    "IPINFO_TOKEN|IPINFO_TOKEN"
    "COMPOSER_API_KEY|COMPOSER_API_KEY"
)

_BW_WRANGLER_SECRETS=(
    "CLOUDFLARE_WRANGLER_TOKEN|CLOUDFLARE_API_TOKEN"
)

# Vars not in _BW_SECRETS but still cleaned up by unset_bw_vars (legacy / special)
_BW_EXTRA_UNSET=(
    GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL
    GIT_AUTHOR_NAME GIT_COMMITTER_NAME
    PAPIREPO_API_KEY CLOUDLET_API_KEY
    SOPS_AGE_KEYS
)

# Check if bw serve is reachable
_bw_serve_ok() {
    curl -sf "${BW_SERVE_ADDR}/status" >/dev/null 2>&1
}

# Fetch a single item's .notes field from bw serve by exact name
_bw_api_get_note() {
    emulate -L zsh
    local item_name=$1 encoded_name response
    encoded_name=$(printf '%s' "$item_name" | jq -sRr @uri)
    response=$(curl -sf "${BW_SERVE_ADDR}/list/object/items?search=${encoded_name}") || {
        print -u2 "bw serve not reachable on ${BW_SERVE_ADDR}. Run bw_serve_start first."
        return 1
    }
    print -r -- "$response" | jq -r \
        --arg name "$item_name" \
        '.data.data[] | select(.name == $name) | .notes // empty' | head -1
}

# Cached accessor — returns the note value, fetching only if cache is stale
_bw_get() {
    emulate -L zsh
    local item_name=$1 now val
    now=$(date +%s)

    if [[ -n "${_BW_CACHE[$item_name]}" ]] && \
       (( now - ${_BW_CACHE_TS[$item_name]:-0} < _BW_CACHE_TTL )); then
        print -r -- "${_BW_CACHE[$item_name]}"
        return 0
    fi

    val=$(_bw_api_get_note "$item_name") || return 1
    if [[ -z "$val" ]]; then
        print -u2 "No value found for '$item_name' in Bitwarden."
        return 1
    fi

    _BW_CACHE[$item_name]=$val
    _BW_CACHE_TS[$item_name]=$now
    print -r -- "$val"
}

# ---------------------------------------------------------------------------
# bw serve lifecycle management
# ---------------------------------------------------------------------------

bw_serve_start() {
    echo "[bw-serve] Unlocking Bitwarden vault..."

    # Unlock vault and get session key
    local session
    local max_retries=3
    local retries=0

    while (( retries < max_retries )); do
        session=$(bw unlock --raw)
        if [[ -n "$session" ]]; then
            break
        fi
        echo "[bw-serve] Unlock attempt $((retries + 1))/$max_retries failed." >&2
        ((retries++))
    done

    if [[ -z "$session" ]]; then
        echo "[bw-serve] Failed to unlock vault after $max_retries attempts." >&2
        return 1
    fi
    echo "[bw-serve] Vault unlocked."

    # Sync vault to pull latest changes from server
    echo "[bw-serve] Syncing vault..."
    BW_SESSION="$session" bw sync 2>/dev/null && \
        echo "[bw-serve] Vault synced." || \
        echo "[bw-serve] Sync failed (non-fatal, using local cache)." >&2

    # Write session to runtime dir (mode 600, create-before-write to avoid TOCTOU)
    local session_file="${_BW_SESSION_DIR}/bw-session.env"
    install -m 600 /dev/null "$session_file"
    print -r -- "BW_SESSION=$session" > "$session_file"
    echo "[bw-serve] Session written to $session_file"

    # (Re)start bw serve via platform service manager
    if [[ "$_SYS_OS" == "macos" ]]; then
        # Kill any existing bw serve, then start fresh
        pkill -f "bw serve --port ${BW_SERVE_PORT}" 2>/dev/null
        BW_SESSION="$session" nohup bw serve --port "$BW_SERVE_PORT" --hostname 127.0.0.1 \
            >/dev/null 2>&1 &
        echo "[bw-serve] started in background (pid $!), waiting for API..."
    else
        systemctl --user reset-failed bw-serve.service 2>/dev/null
        systemctl --user restart bw-serve.service
        echo "[bw-serve] systemd service restarted, waiting for API..."
    fi

    # Wait for the API to become available
    local wait=0
    local max_wait=20
    while ! _bw_serve_ok; do
        ((wait++))
        if (( wait > max_wait )); then
            echo "" >&2
            echo "[bw-serve] Failed to start within ${max_wait}s." >&2
            if [[ "$_SYS_OS" != "macos" ]]; then
                journalctl --user -u bw-serve.service --no-pager -n 5 >&2
            fi
            return 1
        fi
        printf "\r  [%2d/%ds] Waiting for bw serve..." "$wait" "$max_wait" >&2
        sleep 1
    done
    printf "\r%*s\r" 50 "" >&2
    echo "[bw-serve] API running on ${BW_SERVE_ADDR}"
}

bw_serve_stop() {
    echo "[bw-serve] Stopping service..."
    if [[ "$_SYS_OS" == "macos" ]]; then
        pkill -f "bw serve --port ${BW_SERVE_PORT}" 2>/dev/null
    else
        systemctl --user stop bw-serve.service
    fi
    rm -f "${_BW_SESSION_DIR}/bw-session.env"
    clear_bw_cache
    echo "[bw-serve] Stopped and session cleared."
}

bw_serve_status() {
    if _bw_serve_ok; then
        echo "[bw-serve] Running on ${BW_SERVE_ADDR}"
        if [[ "$_SYS_OS" == "macos" ]]; then
            pgrep -fl "bw serve" 2>/dev/null
        else
            systemctl --user status bw-serve.service --no-pager
        fi
    else
        echo "[bw-serve] Not reachable on ${BW_SERVE_ADDR}"
        if [[ "$_SYS_OS" != "macos" ]]; then
            echo "[bw-serve] Recent logs:"
            journalctl --user -u bw-serve.service --no-pager -n 5 2>/dev/null
        fi
    fi
}

bw_serve_sync() {
    local session_file="${_BW_SESSION_DIR}/bw-session.env"
    if [[ ! -f "$session_file" ]]; then
        echo "[bw-serve] No active session. Run bw_serve_start first." >&2
        return 1
    fi
    BW_SESSION=$(command grep '^BW_SESSION=' "$session_file" | cut -d= -f2-)
    if [[ -z "$BW_SESSION" ]]; then
        echo "[bw-serve] Invalid session file." >&2
        return 1
    fi
    echo "[bw-serve] Syncing vault..."
    BW_SESSION="$BW_SESSION" bw sync && echo "[bw-serve] Vault synced." || {
        echo "[bw-serve] Sync failed." >&2
        return 1
    }
    # Clear local cache so next _bw_get fetches fresh values
    clear_bw_cache
}

# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------

clear_bw_cache() {
    _BW_CACHE=()
    _BW_CACHE_TS=()
    echo "Bitwarden in-memory cache cleared."
}

# ---------------------------------------------------------------------------
# Environment loaders (Pattern B — bulk export via bw serve)
# ---------------------------------------------------------------------------

# Mask a secret: first 4 + ... + last 4
_bw_mask() {
    emulate -L zsh
    local len=${#1}
    if (( len <= 8 )); then
        print -r -- "${1:0:2}...${1: -2}"
    else
        print -r -- "${1:0:4}...${1: -4}"
    fi
}

# Generic loader: takes an array of "bw_item_name|ENV_VAR_NAME" pairs
_bw_load_items() {
    emulate -L zsh
    setopt typeset_silent

    local -a items=("$@")
    local total=${#items[@]} current=0 loaded=0 skipped=0 failed=0
    local bw_name env_name val masked

    if ! _bw_serve_ok; then
        print -u2 "[bw] Service not running, starting..."
        bw_serve_start || return 1
    fi

    for item in "${items[@]}"; do
        bw_name=${item%|*}
        env_name=${item#*|}
        ((current++))

        val=$(_bw_get "$bw_name") || {
            print -u2 -f "  [%2d/%d] %-35s %s\n" "$current" "$total" "$env_name" "FAILED"
            ((failed++))
            continue
        }

        masked=$(_bw_mask "$val")
        print -u2 -f "  [%2d/%d] %-35s %s\n" "$current" "$total" "$env_name" "$masked"

        if [[ -z "${(P)env_name}" || "${(P)env_name}" != "$val" ]]; then
            export "$env_name=$val"
            ((loaded++))
        else
            ((skipped++))
        fi
    done

    print "[bw] Done: $loaded loaded, $skipped unchanged, $failed failed (of $total)"
}

load_sops_age_keys() {
    emulate -L zsh
    setopt typeset_silent
    print "Loading SOPS Age keys"

    local public_key secret_key combined
    public_key=$(_bw_get "SOPS_AGE_PUB_KEY") || {
        print -u2 "Failed to retrieve SOPS Age public key."
        return 1
    }
    secret_key=$(_bw_get "SOPS_AGE_SECRET_KEY") || {
        print -u2 "Failed to retrieve SOPS Age secret key."
        return 1
    }

    combined="${public_key}"$'\n'"${secret_key}"
    if [[ "$SOPS_AGE_KEYS" == "$combined" ]]; then
        print "SOPS_AGE_KEYS already set with correct values, skipping."
        return 0
    fi

    export SOPS_AGE_KEYS="$combined"
    print "SOPS_AGE_KEYS set successfully"
}

load_bw() {
    _bw_load_items "${_BW_SECRETS[@]}"
    load_sops_age_keys
}

load_wrangler_token() {
    _bw_load_items "${_BW_WRANGLER_SECRETS[@]}"
}

unset_bw_vars() {
    local item env_name

    # Unset all vars from secret mappings
    for item in "${_BW_SECRETS[@]}" "${_BW_WRANGLER_SECRETS[@]}"; do
        env_name=${item#*|}
        unset "$env_name"
    done

    # Unset legacy/special vars not in mappings
    for env_name in "${_BW_EXTRA_UNSET[@]}"; do
        unset "$env_name"
    done

    clear_bw_cache
    echo "All Bitwarden-loaded environment variables have been unset."
}
