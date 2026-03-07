encrypt_k3s_secret() {
    local public_key
    public_key=$(echo "$SOPS_AGE_KEYS" | grep -oP "public key: \K([A-Za-z0-9]+)" || true)
    
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
    public_key=$(echo "$SOPS_AGE_KEYS" | grep -oP "public key: \K([A-Za-z0-9]+)" || true)
    
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
        
        find "$dir" -type f -not -path '*.git*' -print0 | while IFS= read -r -d $'\0' file; do
            echo "Encrypting file: $file"
            if ! sops --encrypt --age "$public_key" --in-place "$file"; then
                echo "Error: Encryption failed for $file" >&2
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
        
        find "$dir" -type f -not -path '*.git*' -print0 | while IFS= read -r -d $'\0' file; do
            echo "Decrypting file: $file"
            if ! sops --decrypt --in-place "$file"; then
                echo "Error: Decryption failed for $file" >&2
            fi
        done
        return 0
    fi

    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    echo "Decrypting file: $1"
    if ! sops --decrypt --in-place "$1"; then
        echo "Error: Decryption failed for $1" >&2
        return 1
    fi
}

encrypt_all() {
    if [ -z "$(ls -A .)" ]; then
        echo "Error: Directory is empty" >&2
        return 1
    fi

    find . -type f -not -path '*.git*' -print0 | while IFS= read -r -d $'\0' file; do
        if [[ "$(basename "$file")" == "encrypt_script.sh" ]]; then
            echo "Skipping encryption of the script itself: $file"
            continue
        fi

        echo "Encrypting file: $file"
        if ! encrypt "$file"; then
            echo "Error: Encryption failed for $file" >&2
            # Decide if you want to continue or exit on error
            # return 1
        fi
    done
}

decrypt_all() {
    if [ -z "$(ls -A .)" ]; then
        echo "Error: Directory is empty" >&2
        return 1
    fi

    find . -type f -not -path '*.git*' -print0 | while IFS= read -r -d $'\0' file; do
        if [[ "$(basename "$file")" == "encrypt_script.sh" ]]; then
            echo "Skipping decryption of the script itself: $file"
            continue
        fi

        echo "Decrypting file: $file"
        if ! decrypt "$file"; then
            echo "Error: Decryption failed for $file" >&2
            # Decide if you want to continue or exit on error
            # return 1
        fi
    done

}
encrypt_tf() {
    local named_files=("secrets.tfvars" "terraform.tfvars" "blueprint-export.yaml")
    local count=0

    for file in "${named_files[@]}" *.tfstate*; do
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

    for file in "${named_files[@]}" *.tfstate*; do
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
ansible_on() {
   ansible-playbook -i my-playbooks/inventory.yml my-playbooks/poweron.yml --ask-become-pass
}

ansible_off() {
   ansible-playbook -i my-playbooks/inventory.yml my-playbooks/shutdown.yml --ask-become-pass
}

ansible_update() {
   ansible-playbook -i my-playbooks/inventory.yml my-playbooks/update.yml --ask-become-pass
}

# ---------------------------------------------------------------------------
# Bitwarden Serve API — core accessor layer
# ---------------------------------------------------------------------------
# Instead of bulk-exporting secrets via `bw list items`, we query the local
# bw serve REST API (127.0.0.1:8087). Run `bw_serve_start` once after login.
# ---------------------------------------------------------------------------

BW_SERVE_PORT="${BW_SERVE_PORT:-8087}"
BW_SERVE_ADDR="http://127.0.0.1:${BW_SERVE_PORT}"

declare -A _BW_CACHE _BW_CACHE_TS
_BW_CACHE_TTL=300  # 5 minute in-memory cache

# Check if bw serve is reachable
_bw_serve_ok() {
    curl -sf "${BW_SERVE_ADDR}/status" >/dev/null 2>&1
}

# Fetch a single item's .notes field from bw serve by exact name
_bw_api_get_note() {
    local item_name="$1"
    local response
    response=$(curl -sf "${BW_SERVE_ADDR}/list/object/items?search=${item_name}") || {
        echo "bw serve not reachable on ${BW_SERVE_ADDR}. Run bw_serve_start first." >&2
        return 1
    }
    echo "$response" | jq -r \
        --arg name "$item_name" \
        '.data.data[] | select(.name == $name) | .notes // empty' | head -1
}

# Cached accessor — returns the note value, fetching only if cache is stale
_bw_get() {
    local item_name="$1"
    local now=$(date +%s)

    if [[ -n "${_BW_CACHE[$item_name]}" ]] && \
       (( now - ${_BW_CACHE_TS[$item_name]:-0} < _BW_CACHE_TTL )); then
        echo "${_BW_CACHE[$item_name]}"
        return 0
    fi

    local val
    val=$(_bw_api_get_note "$item_name") || return 1
    if [[ -z "$val" ]]; then
        echo "No value found for '$item_name' in Bitwarden." >&2
        return 1
    fi

    _BW_CACHE[$item_name]="$val"
    _BW_CACHE_TS[$item_name]="$now"
    echo "$val"
}

# ---------------------------------------------------------------------------
# bw serve lifecycle management
# ---------------------------------------------------------------------------

# Spinner for visual feedback during waits
_bw_spinner() {
    local pid=$1
    local msg="${2:-Working}"
    local spin='|/-\'
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  %s %s" "${spin:i++%4:1}" "$msg" >&2
        sleep 0.15
    done
    printf "\r" >&2
}

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

    # Write session to runtime dir (mode 600, readable only by current user)
    local session_file="${XDG_RUNTIME_DIR:-/tmp}/bw-session.env"
    echo "BW_SESSION=$session" > "$session_file"
    chmod 600 "$session_file"
    echo "[bw-serve] Session written to $session_file"

    # Reset failed state if any, then (re)start the systemd service
    systemctl --user reset-failed bw-serve.service 2>/dev/null
    systemctl --user restart bw-serve.service
    echo "[bw-serve] systemd service restarted, waiting for API..."

    # Wait for the API to become available with spinner
    local wait=0
    local max_wait=20
    while ! _bw_serve_ok; do
        ((wait++))
        if (( wait > max_wait )); then
            echo "" >&2
            echo "[bw-serve] Failed to start within ${max_wait}s. Checking logs:" >&2
            journalctl --user -u bw-serve.service --no-pager -n 5 >&2
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
    systemctl --user stop bw-serve.service
    rm -f "${XDG_RUNTIME_DIR:-/tmp}/bw-session.env"
    clear_bw_cache
    echo "[bw-serve] Stopped and session cleared."
}

bw_serve_status() {
    if _bw_serve_ok; then
        echo "[bw-serve] Running on ${BW_SERVE_ADDR}"
        systemctl --user status bw-serve.service --no-pager
    else
        echo "[bw-serve] Not reachable on ${BW_SERVE_ADDR}"
        echo "[bw-serve] Recent logs:"
        journalctl --user -u bw-serve.service --no-pager -n 5 2>/dev/null
    fi
}

bw_serve_sync() {
    local session_file="${XDG_RUNTIME_DIR:-/tmp}/bw-session.env"
    if [[ ! -f "$session_file" ]]; then
        echo "[bw-serve] No active session. Run bw_serve_start first." >&2
        return 1
    fi
    source "$session_file"
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

# Generic loader: takes an array of "bw_item_name|ENV_VAR_NAME" pairs
_bw_load_items() {
    local items=("$@")
    local total=${#items[@]}
    local current=0
    local loaded=0
    local skipped=0
    local failed=0

    if ! _bw_serve_ok; then
        echo "[bw] Service not running, starting..." >&2
        bw_serve_start || return 1
    fi

    for item in "${items[@]}"; do
        local bw_name=${item%|*}
        local env_name=${item#*|}
        local val
        ((current++))

        printf "\r  [%d/%d] Loading %-40s" "$current" "$total" "$env_name" >&2

        val=$(_bw_get "$bw_name") || {
            ((failed++))
            continue
        }

        # Only export if unset or changed
        if [[ -z "${(P)env_name}" ]]; then
            export "$env_name=$val"
            ((loaded++))
        elif [[ "${(P)env_name}" != "$val" ]]; then
            export "$env_name=$val"
            ((loaded++))
        else
            ((skipped++))
        fi
    done

    printf "\r%*s\r" 60 "" >&2
    echo "[bw] Done: $loaded loaded, $skipped unchanged, $failed failed (of $total)"
}

load_sops_age_keys() {
    echo "Loading SOPS Age keys"

    local public_key secret_key
    public_key=$(_bw_get "SOPS_AGE_PUB_KEY") || {
        echo "Failed to retrieve SOPS Age public key." >&2
        return 1
    }
    secret_key=$(_bw_get "SOPS_AGE_SECRET_KEY") || {
        echo "Failed to retrieve SOPS Age secret key." >&2
        return 1
    }

    local combined="${public_key}\n${secret_key}"
    if [[ "$SOPS_AGE_KEYS" == "$combined" ]]; then
        echo "SOPS_AGE_KEYS already set with correct values, skipping."
        return 0
    fi

    export SOPS_AGE_KEYS="$combined"
    echo "SOPS_AGE_KEYS set successfully"
}

load_bw() {
    local items=(
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
    )

    _bw_load_items "${items[@]}"
    load_sops_age_keys
}

load_cf_work() {
    local items=(
        "CF_WORK_API_KEY|CLOUDFLARE_API_KEY"
        "CF_WORK_EMAIL|CLOUDFLARE_EMAIL"
        "ONEWEB_CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ID"
        "AWS_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY"
        "AWS_ACCESS_KEY_ID|AWS_ACCESS_KEY_ID"
        "PAPIREPO_API_KEY|PAPIREPO_API_KEY"
        "CLOUDLET_API_KEY|CLOUDLET_API_KEY"
    )

    _bw_load_items "${items[@]}"
}

load_wrangler_token() {
    _bw_load_items "CLOUDFLARE_WRANGLER_TOKEN|CLOUDFLARE_API_TOKEN"
}

unset_bw_vars() {
    # Unset all variables that could be set by load_bw
    unset CLOUDFLARE_EMAIL
    unset GIT_AUTHOR_EMAIL
    unset GIT_COMMITTER_EMAIL
    unset GIT_AUTHOR_NAME
    unset GIT_COMMITTER_NAME
    unset CLOUDFLARE_ACCOUNT_ID
    unset CLOUDFLARE_ZONE_ID
    unset CLOUDFLARE_API_KEY
    unset CLOUDFLARE_ACCESS_OLLAMA_ID
    unset CLOUDFLARE_ACCESS_OLLAMA_SECRET
    unset CARGO_REGISTRY_TOKEN
    unset SOPS_AGE_KEYS

    # Also unset cf_work variables
    unset AWS_SECRET_ACCESS_KEY
    unset AWS_ACCESS_KEY_ID
    unset PAPIREPO_API_KEY
    unset CLOUDLET_API_KEY

    # Unset wrangler token
    unset CLOUDFLARE_API_TOKEN

    # Unset authentik / ipinfo
    unset AUTHENTIK_TOKEN
    unset CLOUDFLARE_TOKEN
    unset IPINFO_TOKEN

    # Clear the cache
    clear_bw_cache

    echo "All Bitwarden-loaded environment variables have been unset."
}

tx_switch() {
    # Check if a session name is provided as an argument
    local session_name="${1:-default}"

    # Create a new session in detached mode (-d) with the given name
    tmux new-session -d -s "$session_name"

    # Switch the tmux client to the newly created session
    tmux switch-client -t "$session_name"
}

p10k_colours() {
  for i in {0..255}; do print -Pn "%K{$i}  %k%F{$i}${(l:3::0:)i}%f " ${${(M)$((i%6)):#3}:+$'\n'}; done
}

yy() {
	local tmp="$(mktemp -t "yazi-cwd.XXXXXX")"
	yazi "$@" --cwd-file="$tmp"
	if cwd="$(cat -- "$tmp")" && [ -n "$cwd" ] && [ "$cwd" != "$PWD" ]; then
		builtin cd -- "$cwd"
	fi
	rm -f -- "$tmp"
}
fix_file_limits() {
    local YELLOW="\033[1;33m"
    local GREEN="\033[1;32m"
    local RESET="\033[0m"
    
    # Print current limits
    print "${YELLOW}Current file descriptor limits:${RESET}"
    print "Soft limit: $(ulimit -Sn)"
    print "Hard limit: $(ulimit -Hn)"

    # Check current open files for the current user
    print "\n${YELLOW}Current open files for your user:${RESET}"
    lsof -u $USER | wc -l

    # System-wide file descriptor usage
    print "\n${YELLOW}System-wide file descriptor usage:${RESET}"
    print "Current open files: $(cat /proc/sys/fs/file-nr | cut -f1)"
    print "Maximum open files: $(cat /proc/sys/fs/file-max)"

    # Ask to increase limits
    print "\n${YELLOW}Would you like to increase the file descriptor limits? (y/N)${RESET}"
    read "response?> "
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        # Backup existing limits file if it exists
        if [[ -f /etc/security/limits.conf ]]; then
            sudo cp /etc/security/limits.conf /etc/security/limits.conf.backup
        fi
        
        print "${YELLOW}Setting new file descriptor limits...${RESET}"
        
        # Add new limits to /etc/security/limits.conf
        print "* soft nofile 65536" | sudo tee -a /etc/security/limits.conf
        print "* hard nofile 65536" | sudo tee -a /etc/security/limits.conf
        print "root soft nofile 65536" | sudo tee -a /etc/security/limits.conf
        print "root hard nofile 65536" | sudo tee -a /etc/security/limits.conf
        
        # Set current session limits
        ulimit -n 65536
        
        print "\n${GREEN}New limits have been set.${RESET}"
        print "${YELLOW}Please note: You'll need to log out and log back in for permanent changes to take effect.${RESET}"
    fi

    # Quick fix for current session
    print "\n${YELLOW}Would you like to temporarily increase limits for current session? (y/N)${RESET}"
    read "response?> "
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        ulimit -n 65536
        print "${GREEN}Current session limits increased to 65536${RESET}"
    fi

    print "\n${YELLOW}To verify the current limits, run:${RESET}"
    print "ulimit -Sn  # Shows soft limit"
    print "ulimit -Hn  # Shows hard limit"
}

# Optional: Add command alias
alias fixfiles='fix_file_limits'

# Terraform debugging functions
tf_debug_on() {
    export TF_LOG=debug
    echo "Terraform debug logging enabled (TF_LOG=debug)"
}

tf_debug_off() {
    unset TF_LOG
    echo "Terraform debug logging disabled"
}

# Toggle Terraform debug mode
tf_debug_toggle() {
    if [[ -n "$TF_LOG" ]]; then
        tf_debug_off
    else
        tf_debug_on
    fi
}

# ---------------------------------------------------------------------------
# Generic Terraform/OpenTofu output accessor
# ---------------------------------------------------------------------------
# Works with any tofu/terraform project. Detects the IaC tool automatically.
# Caches `tofu output -json` per invocation to avoid repeated slow calls.
#
# Usage:
#   tf_out                              # list all outputs (summary view)
#   tf_out <name>                       # show a single output
#   tf_out <name> <key>                 # extract a key from an object output
#   tf_out <name> <key> <subkey>        # nested key extraction (dot-path also works)
#   tf_out --list                       # list output names only
#   tf_out --sensitive                  # show sensitivity & type for each output
#   tf_out --raw <name> [key]           # raw value for piping (no labels/colors)
#   tf_out --json [name]                # full JSON (all outputs or single output)
#   tf_out --search <pattern>           # grep output names by regex pattern
#   tf_out --keys <name>                # list keys of an object output
#   tf_out --type <type>                # filter outputs by value type (string/object/...)
#   tf_out --diff <name>                # show output value diff vs last state backup
#   tf_out --env <name> [prefix]        # export object keys as env vars
#   tf_out --copy <name> [key]          # copy value to clipboard (xclip/wl-copy)
#   tf_out --table <name>               # render object output as aligned table
#   tf_out --count                      # count of outputs by type
# ---------------------------------------------------------------------------

_tf_detect_cmd() {
  if [[ -d ".terraform" && -f ".terraform/terraform.tfstate" ]] && command -v terraform &>/dev/null; then
    echo "terraform"
  elif command -v tofu &>/dev/null; then
    echo "tofu"
  elif command -v terraform &>/dev/null; then
    echo "terraform"
  else
    echo "Error: Neither tofu nor terraform found in PATH" >&2
    return 1
  fi
}

# Resolve an output name: exact match first, then fuzzy, with --raw support
_tf_resolve_name() {
  local all_json="$1" name="$2"

  # Exact match
  if echo "$all_json" | jq -e --arg n "$name" '.[$n]' >/dev/null 2>&1; then
    echo "$name"
    return 0
  fi

  # Fuzzy match
  local matches
  matches=$(echo "$all_json" | jq -r 'keys[]' | grep -iE "$name")
  if [[ -z "$matches" ]]; then
    echo "Error: Output '$name' not found" >&2
    echo "Available: $(echo "$all_json" | jq -r 'keys[]' | tr '\n' ', ' | sed 's/,$//')" >&2
    return 1
  fi

  local match_count
  match_count=$(echo "$matches" | wc -l)
  if [[ $match_count -eq 1 ]]; then
    echo "$matches"
    return 0
  fi

  echo "Error: '$name' is ambiguous. Matches:" >&2
  echo "$matches" | sed 's/^/  /' >&2
  return 1
}

# Extract a value by dot-path or positional key args from JSON
# e.g., _tf_jq_path "value" "client_id"    => .value.client_id
# e.g., _tf_jq_path "value" "a.b.c"        => .value.a.b.c  (dot-path)
_tf_extract_value() {
  local json="$1" output_name="$2"
  shift 2
  local keys=("$@")

  local base
  base=$(echo "$json" | jq --arg n "$output_name" '.[$n].value')

  if [[ ${#keys[@]} -eq 0 ]]; then
    echo "$base"
    return 0
  fi

  # Support dot-path in first key: "a.b.c" => ["a","b","c"]
  local path_expr=".value"
  for key in "${keys[@]}"; do
    # Split on dots
    local IFS='.'
    local parts=($key)
    for part in "${parts[@]}"; do
      path_expr="${path_expr}.${part}"
    done
  done

  local result
  result=$(echo "$json" | jq -r --arg n "$output_name" ".[\$n]${path_expr} // empty")

  if [[ -z "$result" ]]; then
    # Show available keys at the level that failed
    echo "Error: Path '${keys[*]}' not found in output '$output_name'" >&2
    local val_type
    val_type=$(echo "$json" | jq -r --arg n "$output_name" '.[$n].value | type')
    if [[ "$val_type" == "object" ]]; then
      echo "Available keys: $(echo "$json" | jq -r --arg n "$output_name" '.[$n].value | keys[]' | tr '\n' ', ' | sed 's/,$//')" >&2
    fi
    return 1
  fi

  echo "$result"
}

# Copy to clipboard (auto-detect wayland vs X11)
_tf_clipboard() {
  local val="$1"
  if command -v wl-copy &>/dev/null; then
    echo -n "$val" | wl-copy
    echo "Copied to clipboard (wl-copy)"
  elif command -v xclip &>/dev/null; then
    echo -n "$val" | xclip -selection clipboard
    echo "Copied to clipboard (xclip)"
  elif command -v pbcopy &>/dev/null; then
    echo -n "$val" | pbcopy
    echo "Copied to clipboard (pbcopy)"
  else
    echo "Error: No clipboard tool found (install wl-copy, xclip, or pbcopy)" >&2
    return 1
  fi
}

tf_out() {
  local tf_cmd
  tf_cmd=$(_tf_detect_cmd) || return 1

  # Fetch all outputs once
  local all_json
  all_json=$($tf_cmd output -json 2>/dev/null)
  if [[ $? -ne 0 || -z "$all_json" || "$all_json" == "{}" ]]; then
    if [[ ! -d ".terraform" ]]; then
      echo "Error: Not in a terraform/tofu project directory (no .terraform/)" >&2
      return 1
    fi
    echo "No outputs found. Run '$tf_cmd apply' first." >&2
    return 1
  fi

  local output_count
  output_count=$(echo "$all_json" | jq 'length')

  case "${1:-}" in
    --help|-h)
      cat <<'HELP'
Usage: tf_out [command] [args...]

Browse & extract:
  tf_out                              List all outputs (summary)
  tf_out <name>                       Show single output with metadata
  tf_out <name> <key>                 Extract key from object output
  tf_out <name> <key.subkey>          Dot-path nested extraction
  tf_out <name> <key> <subkey>        Multi-arg nested extraction

Listing & filtering:
  tf_out --list                       Output names only
  tf_out --sensitive                  Sensitivity & type matrix
  tf_out --search <pattern>           Regex search output names
  tf_out --type <type>                Filter by value type (string/object/array/number/boolean)
  tf_out --count                      Count outputs by type

Data formats:
  tf_out --json [name]                Full JSON (all or single output)
  tf_out --raw <name> [key]           Raw value for piping (no labels)
  tf_out --table <name>               Render object as aligned key=value table
  tf_out --keys <name>                List keys of an object output

Actions:
  tf_out --copy <name> [key]          Copy value to clipboard
  tf_out --env <name> [PREFIX]        Export object keys as PREFIX_KEY=value env vars
  tf_out --diff <name>                Diff output vs last state backup

Fuzzy matching: partial names auto-resolve when unambiguous.
HELP
      echo ""
      echo "Using: $tf_cmd ($output_count outputs in $(basename "$PWD"))"
      return 0
      ;;

    --list)
      echo "$all_json" | jq -r 'keys[]' | sort
      return 0
      ;;

    --json)
      if [[ -n "${2:-}" ]]; then
        local name
        name=$(_tf_resolve_name "$all_json" "$2") || return 1
        echo "$all_json" | jq --arg n "$name" '.[$n]'
      else
        echo "$all_json" | jq '.'
      fi
      return 0
      ;;

    --sensitive)
      {
        printf "%s\t%s\t%s\n" "OUTPUT" "SENSITIVE" "TYPE"
        printf "%s\t%s\t%s\n" "------" "---------" "----"
        echo "$all_json" | jq -r '
          to_entries | sort_by(.key)[] |
          "\(.key)\t\(if .value.sensitive then "yes" else "no" end)\t\(.value.value | type)"
        '
      } | column -t -s $'\t'
      return 0
      ;;

    --search)
      local pattern="${2:?Error: --search requires a pattern}"
      local results
      results=$(echo "$all_json" | jq -r --arg p "$pattern" '
        to_entries[]
        | select(.key | test($p; "i"))
        | "\(.key)\t\(.value.value | type)\t\(if .value.sensitive then " [sensitive]" else "" end)"
      ' | sort)
      if [[ -z "$results" ]]; then
        echo "No outputs matching '$pattern'" >&2
        return 1
      fi
      echo "$results" | while IFS=$'\t' read -r k typ sens; do
        printf "  %-40s %s%s\n" "$k" "$typ" "$sens"
      done
      return 0
      ;;

    --type)
      local target_type="${2:?Error: --type requires a type (string/object/array/number/boolean)}"
      echo "$all_json" | jq -r --arg t "$target_type" 'to_entries[] | select(.value.value | type == $t) | .key' | sort
      return 0
      ;;

    --count)
      echo "Outputs by type ($output_count total):"
      echo "$all_json" | jq -r '[to_entries[].value.value | type] | group_by(.) | map({type: .[0], count: length}) | sort_by(.type)[] | "  \(.type): \(.count)"'
      local sens_count
      sens_count=$(echo "$all_json" | jq '[to_entries[].value | select(.sensitive)] | length')
      echo "  ---"
      echo "  sensitive: $sens_count"
      echo "  public: $((output_count - sens_count))"
      return 0
      ;;

    --keys)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --keys requires an output name}") || return 1
      local val_type
      val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
      if [[ "$val_type" != "object" ]]; then
        echo "Error: Output '$name' is a $val_type, not an object" >&2
        return 1
      fi
      echo "$all_json" | jq -r --arg n "$name" '.[$n].value | keys[]'
      return 0
      ;;

    --table)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --table requires an output name}") || return 1
      local val_type
      val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
      if [[ "$val_type" != "object" ]]; then
        echo "Error: Output '$name' is a $val_type, not an object" >&2
        return 1
      fi
      echo "$name:"
      echo "$all_json" | jq -r --arg n "$name" '
        .[$n].value | to_entries[] |
        "\(.key)\t\(if (.value | type) == "object" or (.value | type) == "array" then (.value | tojson) else (.value | tostring) end)"
      ' | while IFS=$'\t' read -r k v; do
        printf "  %-30s %s\n" "$k" "$v"
      done
      return 0
      ;;

    --raw)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --raw requires an output name}") || return 1
      shift 2
      if [[ $# -eq 0 ]]; then
        # No key args — output raw value directly
        local val_type
        val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
        if [[ "$val_type" == "object" || "$val_type" == "array" ]]; then
          echo "$all_json" | jq --arg n "$name" '.[$n].value'
        else
          echo "$all_json" | jq -r --arg n "$name" '.[$n].value'
        fi
      else
        _tf_extract_value "$all_json" "$name" "$@"
      fi
      return $?
      ;;

    --copy)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --copy requires an output name}") || return 1
      shift 2
      local val
      val=$(_tf_extract_value "$all_json" "$name" "$@") || return 1
      # If it's JSON, compact it for clipboard
      if [[ "$val" == "{"* || "$val" == "["* ]]; then
        val=$(echo "$val" | jq -c '.')
      fi
      _tf_clipboard "$val"
      return 0
      ;;

    --env)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --env requires an output name}") || return 1
      local prefix="${3:-}"
      local val_type
      val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
      if [[ "$val_type" != "object" ]]; then
        # For non-object, export as single var
        local env_var_name="${prefix:-$(echo "$name" | tr '[:lower:]-' '[:upper:]_')}"
        local env_val
        env_val=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value')
        export "$env_var_name=$env_val"
        echo "export $env_var_name=***"
        return 0
      fi
      # For objects, build export commands via jq then eval them
      local env_lines
      if [[ -n "$prefix" ]]; then
        env_lines=$(echo "$all_json" | jq -r --arg n "$name" --arg p "$prefix" '
          .[$n].value | to_entries[] |
          "\($p)_\(.key | gsub("-";"_") | ascii_upcase)=\(.value | tostring)"
        ')
      else
        env_lines=$(echo "$all_json" | jq -r --arg n "$name" '
          .[$n].value | to_entries[] |
          "\(.key | gsub("-";"_") | ascii_upcase)=\(.value | tostring)"
        ')
      fi
      echo "$env_lines" | while IFS='=' read -r env_k env_v; do
        export "$env_k=$env_v"
        echo "export $env_k=***"
      done
      return 0
      ;;

    --diff)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --diff requires an output name}") || return 1
      local backup="terraform.tfstate.backup"
      if [[ ! -f "$backup" ]]; then
        echo "Error: No state backup found ($backup)" >&2
        return 1
      fi
      local old_val new_val
      old_val=$($tf_cmd show -json "$backup" 2>/dev/null | jq --arg n "$name" '.values.outputs[$n].value // "not present"' 2>/dev/null)
      new_val=$(echo "$all_json" | jq --arg n "$name" '.[$n].value')
      if [[ "$old_val" == "$new_val" ]]; then
        echo "No change for '$name'"
      else
        echo "--- backup"
        echo "+++ current"
        diff --color=auto <(echo "$old_val" | jq -S '.') <(echo "$new_val" | jq -S '.') 2>/dev/null || {
          echo "Old: $old_val"
          echo "New: $new_val"
        }
      fi
      return 0
      ;;

    --*)
      echo "Error: Unknown flag '$1'. Try 'tf_out --help'" >&2
      return 1
      ;;
  esac

  # --- Single output by name (with optional key extraction) ---
  if [[ -n "${1:-}" ]]; then
    local name
    name=$(_tf_resolve_name "$all_json" "$1") || return 1
    shift

    local sensitive val_type
    sensitive=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].sensitive')
    val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')

    # If extra args, treat as key extraction
    if [[ $# -gt 0 ]]; then
      if [[ "$val_type" != "object" ]]; then
        echo "Error: Output '$name' is a $val_type, cannot extract key '$1'" >&2
        return 1
      fi
      _tf_extract_value "$all_json" "$name" "$@"
      return $?
    fi

    # Display full output with metadata
    echo "Output: $name"
    echo "Type: $val_type"
    [[ "$sensitive" == "true" ]] && echo "Sensitive: yes"

    case "$val_type" in
      object)
        local key_count
        key_count=$(echo "$all_json" | jq --arg n "$name" '.[$n].value | keys | length')
        echo "Keys ($key_count): $(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | keys | join(", ")')"
        echo ""
        echo "$all_json" | jq -C --arg n "$name" '.[$n].value'
        ;;
      array)
        local arr_len
        arr_len=$(echo "$all_json" | jq --arg n "$name" '.[$n].value | length')
        echo "Length: $arr_len"
        echo ""
        echo "$all_json" | jq -C --arg n "$name" '.[$n].value'
        ;;
      *)
        echo "Value: $(echo "$all_json" | jq -r --arg n "$name" '.[$n].value')"
        ;;
    esac
    return 0
  fi

  # --- No args: summary listing ---
  echo "Outputs ($output_count total, via $tf_cmd, project: $(basename "$PWD")):"
  echo ""

  # Use jq to build the entire summary in one pass (avoids subshell variable issues)
  echo "$all_json" | jq -r '
    to_entries | sort_by(.key) | to_entries[] |
    .value as $entry |
    $entry.key as $name |
    $entry.value.sensitive as $sens |
    ($entry.value.value | type) as $typ |
    if $sens then
      if $typ == "object" then
        "  \($name)\t[sensitive, \($typ): \($entry.value.value | keys | join(", "))]"
      else
        "  \($name)\t[sensitive, \($typ)]"
      end
    elif $typ == "object" then
      "  \($name)\t{\($entry.value.value | keys | join(", "))}"
    elif $typ == "array" then
      "  \($name)\t[array, \($entry.value.value | length) items]"
    else
      "  \($name)\t\($entry.value.value | tostring | if length > 60 then .[:57] + "..." else . end)"
    end
  ' | while IFS=$'\t' read -r col1 col2; do
    printf "%-42s %s\n" "$col1" "$col2"
  done
}

cf_permissions() {
  local input_command=$1
  local category=$2
  local command=""
  
  # Map input to actual command
  case "$input_command" in
    terraform|tf)
      command="terraform"
      ;;
    tofu|t)
      command="tofu"
      ;;
    *)
      echo "Usage: cf_permissions [terraform|tf|tofu|t] [account|zone|user|r2|roles|all]"
      return 1
      ;;
  esac
  
  # Check if the command exists
  if ! command -v $command &> /dev/null; then
    echo "Error: Command '$command' not found. Please ensure it is installed and in your PATH."
    return 1
  fi
  
  # Validate category
  if [[ "$category" != "account" && "$category" != "zone" && "$category" != "user" && "$category" != "r2" && "$category" != "roles" && "$category" != "all" ]]; then
    echo "Usage: cf_permissions [terraform|tf|tofu|t] [account|zone|user|r2|roles|all]"
    return 1
  fi
  
  # Show permissions based on category
  if [[ "$category" == "all" ]]; then
    echo "=== ACCOUNT PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.account)"
    echo "\n=== ZONE PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.zone)"
    echo "\n=== USER PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.user)"
    echo "\n=== R2 PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.r2)"
    echo "\n=== ACCOUNT ROLES ==="
    $command console <<< "data.cloudflare_account_roles.account_roles.roles"
  elif [[ "$category" == "roles" ]]; then
    $command console <<< "data.cloudflare_account_roles.account_roles.roles"
  else
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.$category)"
  fi
}

#!/bin/zsh

# Function to update and upgrade Ubuntu and Homebrew packages
update_all() {
    echo "🔄 Starting system update process..."
    echo "=================================="
    
    # Check if running on Ubuntu/Debian (apt available)
    if command -v apt &> /dev/null; then
        echo "📦 Updating Ubuntu packages..."
        echo "----------------------------------"
        
        # Update package lists
        if sudo apt update; then
            echo "✅ Package lists updated"
        else
            echo "❌ Failed to update package lists"
            return 1
        fi
        
        # Upgrade packages
        if sudo apt upgrade -y; then
            echo "✅ Packages upgraded"
        else
            echo "❌ Failed to upgrade packages"
            return 1
        fi
        
        # Remove unnecessary packages
        if sudo apt autoremove -y; then
            echo "✅ Unnecessary packages removed"
        else
            echo "⚠️  Warning: Failed to remove unnecessary packages"
        fi
        
        # Clean package cache
        if sudo apt autoclean; then
            echo "✅ Package cache cleaned"
        else
            echo "⚠️  Warning: Failed to clean package cache"
        fi
        
        echo "✅ Ubuntu packages updated successfully!"
        echo ""
    else
        echo "ℹ️  apt not found - skipping Ubuntu updates"
        echo ""
    fi
    
    # Check if Homebrew is installed
    if command -v brew &> /dev/null; then
        echo "🍺 Updating Homebrew packages..."
        echo "----------------------------------"
        
        # Update Homebrew itself
        if brew update; then
            echo "✅ Homebrew updated"
        else
            echo "❌ Failed to update Homebrew"
            return 1
        fi
        
        # Upgrade all installed packages
        if brew upgrade; then
            echo "✅ Packages upgraded"
        else
            echo "❌ Failed to upgrade packages"
            return 1
        fi
        
        # Clean up old versions
        if brew cleanup; then
            echo "✅ Old versions cleaned up"
        else
            echo "⚠️  Warning: Failed to clean up old versions"
        fi
        
        # Check for issues
        echo "🔍 Running Homebrew diagnostics..."
        if brew doctor; then
            echo "✅ Homebrew diagnostics passed"
        else
            echo "⚠️  Warning: Homebrew diagnostics found issues"
        fi
        
        echo "✅ Homebrew packages updated successfully!"
        echo ""
    else
        echo "ℹ️  Homebrew not found - skipping Homebrew updates"
        echo ""
    fi
    
    echo "🎉 All available updates completed!"
    echo "=================================="
}

# Optional: Create an alias for shorter command
alias upall='update_all'
