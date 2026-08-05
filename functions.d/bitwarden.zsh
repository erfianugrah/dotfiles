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

# Cross-shell env cache. _BW_CACHE above is a per-process associative array,
# so it can never help a freshly-spawned shell (new tmux window = new zsh =
# empty cache = 20 sequential HTTP round-trips to the serve daemon, ~2.2s).
# This file carries the already-resolved exports so later shells just source
# it. Lives in XDG_RUNTIME_DIR: tmpfs, 0700, wiped on logout/reboot - so the
# secrets never touch disk and never outlive the login session.
_BW_ENV_CACHE="${_BW_SESSION_DIR}/bw-env.zsh"

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
    "RESEARCH_TOKEN|RESEARCH_TOKEN"
    "EXA_SEARCH_API_KEY|EXA_API_KEY"
    "SUPABASE_MGMT_PAT|SUPABASE_ACCESS_TOKEN"
    "KNOTEA_ADMIN_KEY|KNOT_API_TOKEN"
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

# Check if bw serve is reachable AND reports an unlocked vault.
# Reachability alone is not enough: a daemon with an expired session still
# answers /status and /sync (with success!) while serving stale data.
_bw_serve_ok() {
    local response
    response=$(curl -sf "${BW_SERVE_ADDR}/status" 2>/dev/null) || return 1
    [[ $(print -r -- "$response" | jq -r '.data.template.status // empty' 2>/dev/null) == "unlocked" ]]
}

# Session older than this is suspect: the serve daemon's access token
# expires silently (observed 2026-07-29: /status "unlocked", /sync
# "success", data days stale). Restart with bw_serve_start when this fires.
_BW_SESSION_MAX_AGE="${_BW_SESSION_MAX_AGE:-43200}"  # 12h

# _bw_session_started - the BW_SESSION_STARTED epoch from the session file.
# Parsed inline rather than `zsh -c 'source ...'`: spawning a shell to read
# one integer cost ~0.2s on every interactive startup.
_bw_session_started() {
    emulate -L zsh
    local f="${_BW_SESSION_DIR}/bw-session.env" line
    [[ -f $f ]] || return 1
    while IFS= read -r line; do
        if [[ $line == BW_SESSION_STARTED=* ]]; then
            line=${line#BW_SESSION_STARTED=}
            [[ $line == <-> ]] || return 1
            print -r -- "$line"
            return 0
        fi
    done < "$f"
    return 1
}

# _bw_session_age - seconds since bw_serve_start wrote the session file, -1 if unknown
_bw_session_age() {
    local started
    started=$(_bw_session_started) || { echo -1; return; }
    echo $(( $(date +%s) - started ))
}

# ---------------------------------------------------------------------------
# Cross-shell env cache
# ---------------------------------------------------------------------------

# _bw_env_cache_write - snapshot the currently-exported secrets for later shells.
# Stamped with the bw session epoch, so bw_serve_start (which rewrites the
# session file with a new timestamp) implicitly invalidates it.
_bw_env_cache_write() {
    emulate -L zsh
    local stamp tmp item env_name
    stamp=$(_bw_session_started) || return 1
    tmp="${_BW_ENV_CACHE}.$$"
    install -m 600 /dev/null "$tmp" 2>/dev/null || return 1
    {
        print -r -- "# bw-env-cache session=${stamp}"
        for item in "${_BW_SECRETS[@]}"; do
            env_name=${item#*|}
            [[ -n ${(P)env_name} ]] && print -r -- "export ${env_name}=${(qq)${(P)env_name}}"
        done
        [[ -n $SOPS_AGE_KEYS ]] && print -r -- "export SOPS_AGE_KEYS=${(qq)SOPS_AGE_KEYS}"
    } >| "$tmp" || { rm -f "$tmp"; return 1 }
    mv -f "$tmp" "$_BW_ENV_CACHE" 2>/dev/null || { rm -f "$tmp"; return 1 }
}

# _bw_env_cache_load - source the snapshot if it matches the live bw session.
# Returns non-zero on miss/stale/untrusted so the caller falls back to a full
# load. The -O check matters: we are sourcing this file, so refuse anything
# not owned by us.
_bw_env_cache_load() {
    emulate -L zsh
    local f=$_BW_ENV_CACHE hdr stamp
    [[ -f $f && -r $f && -O $f ]] || return 1
    IFS= read -r hdr < "$f" || return 1
    [[ $hdr == '# bw-env-cache session='* ]] || return 1
    stamp=$(_bw_session_started) || return 1
    [[ ${hdr#\# bw-env-cache session=} == "$stamp" ]] || return 1
    source "$f"
}

_bw_env_cache_invalidate() {
    rm -f "$_BW_ENV_CACHE" 2>/dev/null
    return 0
}

# _bw_warn_if_stale - loud nudge on stderr when the serve session is suspect.
# Called by the accessors; never blocks, just converts silent staleness into
# a visible, actionable message.
_bw_warn_if_stale() {
    local age=$(_bw_session_age)
    if (( age < 0 )); then
        print -u2 "[bw] no session timestamp - if data looks stale, run bw_serve_start."
    elif (( age > _BW_SESSION_MAX_AGE )); then
        print -u2 "[bw] session is $(( age / 3600 ))h old - the serve daemon can silently go stale. Run bw_serve_start."
    fi
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
    _bw_warn_if_stale
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
    print -r -- "BW_SESSION_STARTED=$(date +%s)" >> "$session_file"
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

    # Warm the gpg-agent cache from the freshly unlocked vault (best effort,
    # silent, never prompts). This is what makes one bw unlock per boot cover
    # GPG signing too.
    (( $+functions[gpg_seed_bw] )) && gpg_seed_bw
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
        echo "[bw-serve] Running on ${BW_SERVE_ADDR} (unlocked)"
        local age=$(_bw_session_age)
        if (( age >= 0 )); then
            echo "[bw-serve] session age: $(( age / 3600 ))h (warn at $(( _BW_SESSION_MAX_AGE / 3600 ))h)"
        fi
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

# Sync the LIVE bw serve daemon via its REST /sync endpoint.
#
# Why not `bw sync`? The external CLI updates the on-disk encrypted vault
# but the running `bw serve` daemon keeps its own decrypted in-memory copy
# loaded at startup. After an external `bw sync`, the daemon's
# /list/object/items?search=... still returns stale results — newly-added
# items look missing. POST /sync triggers the daemon to refresh its own
# state, which is what we actually want.
bw_serve_sync() {
    if ! _bw_serve_ok; then
        echo "[bw-serve] Service not reachable on ${BW_SERVE_ADDR}. Run bw_serve_start." >&2
        return 1
    fi
    echo "[bw-serve] Syncing vault via daemon API..."
    local response
    response=$(curl -sf -X POST "${BW_SERVE_ADDR}/sync") || {
        echo "[bw-serve] Sync request failed." >&2
        return 1
    }
    if [[ $(print -r -- "$response" | jq -r '.success // false') != "true" ]]; then
        echo "[bw-serve] Sync API returned failure: $response" >&2
        return 1
    fi
    echo "[bw-serve] Vault synced."
    # Drop shell-side cache so next _bw_get refetches from the freshly-synced daemon.
    clear_bw_cache
}

# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------

clear_bw_cache() {
    _BW_CACHE=()
    _BW_CACHE_TS=()
    _bw_env_cache_invalidate
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

    # --no-sync: skip the POST /sync round-trip. Used by the shell-start path,
    # where the daemon was already synced by bw_serve_start and the sync cost
    # (~0.5s, plus it wipes _BW_CACHE) buys nothing. Explicit `load_bw` still
    # syncs, so "I just changed a vault item" keeps working.
    local do_sync=1
    while [[ $1 == --* ]]; do
        case $1 in
            --no-sync) do_sync=0; shift ;;
            --) shift; break ;;
            *) print -u2 "[bw] unknown flag: $1"; return 2 ;;
        esac
    done

    local -a items=("$@")
    local total=${#items[@]} current=0 loaded=0 skipped=0 failed=0
    local bw_name env_name val masked

    if ! _bw_serve_ok; then
        print -u2 "[bw] Service not running, starting..."
        bw_serve_start || return 1
    fi

    # Always sync first so newly-added vault items are visible. The
    # daemon caches the decrypted vault in memory; without a sync the
    # /list/object/items?search=... endpoint silently returns 0 results
    # for items added since daemon startup, making _bw_get fail with
    # "No value found" even though the item is in the web vault.
    # bw_serve_sync hits the daemon's POST /sync and clears the
    # shell-side cache on success.
    if (( do_sync )); then
        bw_serve_sync >/dev/null 2>&1 || {
            print -u2 "[bw] sync failed, using stale cache"
            clear_bw_cache >/dev/null 2>&1
        }
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
    (( failed == 0 ))
}

# load_sops_age_keys - load the current SOPS Age keypair from Bitwarden into
# SOPS_AGE_KEYS. Uses key 2 (notes SOPS_AGE_PUB_KEY_2 / SOPS_AGE_SECRET_KEY_2),
# the recipient adopted after the key-1 compromise in deb8318. Rotation is
# complete, so the old key-1 notes are no longer loaded.
load_sops_age_keys() {
    emulate -L zsh
    setopt typeset_silent
    print "Loading SOPS Age keys"

    local public_key secret_key combined
    public_key=$(_bw_get "SOPS_AGE_PUB_KEY_2") || {
        print -u2 "Failed to retrieve SOPS Age public key."
        return 1
    }
    secret_key=$(_bw_get "SOPS_AGE_SECRET_KEY_2") || {
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

# load_bw [--no-sync] - export every mapped secret + the SOPS Age keypair.
# On full success it snapshots the result to _BW_ENV_CACHE so subsequent
# shells skip the ~20 HTTP round-trips entirely.
load_bw() {
    local -a flags=()
    [[ $1 == --no-sync ]] && { flags=(--no-sync); shift }
    _bw_load_items "${flags[@]}" "${_BW_SECRETS[@]}" || return 1
    load_sops_age_keys || return 1
    _bw_env_cache_write
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

# ---------------------------------------------------------------------------
# bw_set - write path companion to load_bw
#
# Updating a secret used to be: edit the item in the web vault, hope the
# serve daemon notices (it silently lies about being synced), then re-export
# by hand in every shell. bw_set collapses that into one command:
#   1. rewrite the vault item's notes field via the bw CLI
#   2. POST /sync on the live serve daemon
#   3. VERIFY the daemon's read-back (never trust the sync's success flag -
#      a stale daemon answers /sync with success while serving old data)
#   4. re-export the env var in the current shell
# Other shells and long-running processes (pi) still hold the old value -
# that is fundamental to env vars; run load_bw there or restart them.
#
# Usage: bw_set <bw_item_or_env_name> [new_value]
#   Name resolves against _BW_SECRETS / _BW_WRANGLER_SECRETS (either side).
#   Omit the value to be prompted (hidden, stays out of shell history).
# ---------------------------------------------------------------------------
bw_set() {
    emulate -L zsh
    setopt typeset_silent
    local name=$1 value=$2

    if [[ -z $name ]]; then
        print -u2 "usage: bw_set <bw_item_or_env_name> [new_value]"
        return 1
    fi

    # Resolve against the secret mappings (accept either side of the pair)
    local bw_name= env_name= item
    for item in "${_BW_SECRETS[@]}" "${_BW_WRANGLER_SECRETS[@]}"; do
        if [[ ${item%|*} == "$name" || ${item#*|} == "$name" ]]; then
            bw_name=${item%|*}
            env_name=${item#*|}
            break
        fi
    done
    if [[ -z $bw_name ]]; then
        print -u2 "[bw] '$name' is not in _BW_SECRETS / _BW_WRANGLER_SECRETS - add the mapping first."
        return 1
    fi

    # Read the new value (hidden prompt if not given, keeps it out of history)
    if [[ -z $value ]]; then
        read -rs "value?New value for $bw_name: " || return 1
        print
    fi
    [[ -n $value ]] || { print -u2 "[bw] empty value, aborting."; return 1 }

    # CLI session (written by bw_serve_start)
    local session_file="${_BW_SESSION_DIR}/bw-session.env"
    if [[ ! -f $session_file ]]; then
        print -u2 "[bw] no CLI session file - run bw_serve_start first."
        return 1
    fi
    local BW_SESSION
    source "$session_file"

    # Fetch the item, rewrite its notes, push back to the server
    local item_json id
    if ! item_json=$(BW_SESSION="$BW_SESSION" bw get item "$bw_name" 2>/dev/null); then
        print -u2 "[bw] 'bw get item $bw_name' failed - item missing or CLI session stale (run bw_serve_start)."
        return 1
    fi
    id=$(print -r -- "$item_json" | jq -r '.id // empty')
    [[ -n $id ]] || { print -u2 "[bw] could not parse item id."; return 1 }

    if ! print -r -- "$item_json" | jq -c --arg v "$value" '.notes = $v' | bw encode | BW_SESSION="$BW_SESSION" bw edit item "$id" >/dev/null 2>&1; then
        print -u2 "[bw] 'bw edit item $id' failed."
        return 1
    fi
    print "[bw] vault item '$bw_name' updated."

    # Refresh the serve daemon's in-memory vault, then VERIFY read-back.
    # The 2026-07-29 lesson: a stale daemon answers /sync with success while
    # serving days-old data, so the sync's exit status proves nothing.
    bw_serve_sync >/dev/null 2>&1
    unset "_BW_CACHE[$bw_name]" "_BW_CACHE_TS[$bw_name]"
    local readback
    readback=$(_bw_api_get_note "$bw_name" 2>/dev/null)
    if [[ $readback == "$value" ]]; then
        print "[bw] serve daemon read-back verified."
    else
        print -u2 "[bw] WARNING: daemon read-back mismatch - serve session likely stale. Run bw_serve_start, then retry bw_serve_sync."
    fi

    # Re-export in this shell, and drop the cross-shell snapshot so the next
    # new shell re-reads rather than resurrecting the old value.
    export "$env_name=$value"
    _bw_env_cache_invalidate
    print "[bw] $env_name refreshed in this shell ($(_bw_mask "$value"))."
    print "[bw] other shells + running agents keep the old value - run load_bw there / restart them."
}
