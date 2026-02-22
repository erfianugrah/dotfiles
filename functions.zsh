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
    local files=("secrets.tfvars" "terraform.tfstate" "terraform.tfstate.backup")
    
    for file in "${files[@]}" *.tfstate*; do
        if [[ -f "$file" ]]; then
            encrypt "$file" || return 1
        fi
    done
}

decrypt_tf() {
    local files=("secrets.tfvars" "terraform.tfstate" "terraform.tfstate.backup")
    
    for file in "${files[@]}" *.tfstate*; do
        if [[ -f "$file" ]]; then
            decrypt "$file" || return 1
        fi
    done
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

load_ingka_gh(){
    git config --local user.name "Erfi Anugrah"
    git config --local user.email "erfi.anugrah@ingka.com"
    git config --local user.signingkey EF78DC0E13F5E990
    git config --local commit.gpgsign true
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

# Cloudflare credentials retrieval script for use after 'tofu apply' or 'terraform apply'

get_cf_credential() {
  local cred_type=$1
  local cred_name=$2
  local show_value=${3:-true}  # Default to showing the value
  
  # Determine which command to use (terraform or tofu)
  local tf_cmd="tofu"
  
  # Check if we're in a git repo with a .terraform directory
  if [[ -d ".terraform" ]]; then
    # Look for terraform init state file for Terraform
    if [[ -f ".terraform/terraform.tfstate" ]]; then
      # Check if terraform binary exists
      if command -v terraform &> /dev/null; then
        tf_cmd="terraform"
      fi
    fi
  fi

  echo "Using $tf_cmd command"
  
  # If no arguments are provided, show usage and available credentials
  if [[ -z "$cred_type" ]]; then
    echo "Usage: get_cf_credential <type> <name> [show_value]"
    echo "Types: token, s3, output, all"
    echo "show_value: true (default) or false"
    echo
    echo "Available tokens:"
    $tf_cmd output -json | jq -r 'keys[] | select(startswith("cloudflare_api_token_")) | select(contains("s3_credentials") | not)' | sed 's/cloudflare_api_token_//'
    echo
    echo "Available S3 credentials tokens:"
    $tf_cmd output -json | jq -r 'keys[] | select(contains("s3_credentials"))' | sed 's/cloudflare_api_token_//; s/_s3_credentials//'
    echo
    echo "Available outputs:"
    $tf_cmd output -json | jq -r 'keys[] | select(startswith("cloudflare_api_token_") | not)' | sort
    return 0
  fi

  case "$cred_type" in
    token)
      if [[ -z "$cred_name" ]]; then
        # List all token names if no specific name is provided
        echo "Available tokens:"
        $tf_cmd output -json | jq -r 'keys[] | select(startswith("cloudflare_api_token_")) | select(contains("s3_credentials") | not)' | sed 's/cloudflare_api_token_//'
        return 0
      fi
      
      local full_token_name="cloudflare_api_token_${cred_name}"
      if $tf_cmd output -json | jq -e --arg name "$full_token_name" '.[$name]' > /dev/null 2>&1; then
        local value=$($tf_cmd output -json | jq -r --arg name "$full_token_name" '.[$name].value')
        [[ "$show_value" == "true" ]] && echo "$value" || echo "Token value retrieved (hidden)"
      else
        echo "Error: Token '$cred_name' not found" >&2
        return 1
      fi
      ;;
      
    s3)
      if [[ -z "$cred_name" ]]; then
        # List all S3 credential tokens if no specific name is provided
        echo "Available S3 credentials:"
        $tf_cmd output -json | jq -r 'keys[] | select(contains("s3_credentials"))' | sed 's/cloudflare_api_token_//; s/_s3_credentials//'
        return 0
      fi
      
      # Try the exact name with s3_credentials suffix
      local full_cred_name="cloudflare_api_token_${cred_name}_s3_credentials"
      
      # If that doesn't exist, try to find if there's any match ending with the name
      if ! $tf_cmd output -json | jq -e --arg name "$full_cred_name" '.[$name]' > /dev/null 2>&1; then
        # Try to find a matching s3 credential output
        local matching_cred=$($tf_cmd output -json | jq -r 'keys[] | select(contains("s3_credentials"))' | grep -E "${cred_name}")
        
        if [[ -n "$matching_cred" ]]; then
          full_cred_name="$matching_cred"
        else
          echo "Error: S3 credentials for token '$cred_name' not found" >&2
          return 1
        fi
      fi
      
      echo "S3 credentials for '${full_cred_name/cloudflare_api_token_/}':"
      local access_key_id=$($tf_cmd output -json | jq -r --arg name "$full_cred_name" '.[$name].value.access_key_id')
      local secret_key=$($tf_cmd output -json | jq -r --arg name "$full_cred_name" '.[$name].value.secret_access_key')
      
      echo "Access Key ID: $access_key_id"
      if [[ "$show_value" == "true" ]]; then
        echo "Secret Access Key: $secret_key"
      else
        echo "Secret Access Key: [hidden]"
      fi
      ;;
    
    output)
      if [[ -z "$cred_name" ]]; then
        # List all general outputs if no specific name is provided
        echo "Available outputs:"
        $tf_cmd output -json | jq -r 'keys[] | select(startswith("cloudflare_api_token_") | not)' | sort
        return 0
      fi
      
      if $tf_cmd output -json | jq -e --arg name "$cred_name" '.[$name]' > /dev/null 2>&1; then
        if [[ "$show_value" == "true" ]]; then
          # Attempt to extract the value, handling different types of outputs
          local is_sensitive=$($tf_cmd output -json | jq -r --arg name "$cred_name" '.[$name].sensitive')
          local value_type=$($tf_cmd output -json | jq -r --arg name "$cred_name" 'if .[$name].value | type == "object" then "object" else "simple" end')
          
          echo "Output: $cred_name"
          echo "Sensitive: $is_sensitive"
          
          if [[ "$value_type" == "object" ]]; then
            echo "Value (object):"
            $tf_cmd output -json | jq --arg name "$cred_name" '.[$name].value'
          else
            echo "Value: $($tf_cmd output -json | jq -r --arg name "$cred_name" '.[$name].value')"
          fi
        else
          echo "Output: $cred_name"
          echo "Value: [hidden]"
        fi
      else
        echo "Error: Output '$cred_name' not found" >&2
        return 1
      fi
      ;;
      
    all)
      # Display all tokens and their values
      echo "=== API Tokens ==="
      echo ""
      
      local tokens=($($tf_cmd output -json | jq -r 'keys[] | select(startswith("cloudflare_api_token_")) | select(contains("s3_credentials") | not)'))
      for token_name in $tokens; do
        local simple_name=${token_name#cloudflare_api_token_}
        echo "Token: $simple_name"
        if [[ "$show_value" == "true" ]]; then
          echo "Value: $($tf_cmd output -json | jq -r --arg name "$token_name" '.[$name].value')"
        else
          echo "Value: [hidden]"
        fi
        echo ""
      done
      
      echo "=== S3-Compatible Credentials ==="
      echo ""
      
      local s3_creds=($($tf_cmd output -json | jq -r 'keys[] | select(contains("s3_credentials"))'))
      for cred_name in $s3_creds; do
        local simple_name=${cred_name#cloudflare_api_token_}
        simple_name=${simple_name%_s3_credentials}
        
        echo "For token: $simple_name"
        echo "Access Key ID: $($tf_cmd output -json | jq -r --arg name "$cred_name" '.[$name].value.access_key_id')"
        if [[ "$show_value" == "true" ]]; then
          echo "Secret Access Key: $($tf_cmd output -json | jq -r --arg name "$cred_name" '.[$name].value.secret_access_key')"
        else
          echo "Secret Access Key: [hidden]"
        fi
        echo ""
      done
      
      echo "=== Other Outputs ==="
      echo ""
      
      local outputs=($($tf_cmd output -json | jq -r 'keys[] | select(startswith("cloudflare_api_token_") | not)' | sort))
      for output_name in $outputs; do
        echo "Output: $output_name"
        local is_sensitive=$($tf_cmd output -json | jq -r --arg name "$output_name" '.[$name].sensitive')
        echo "Sensitive: $is_sensitive"
        
        if [[ "$show_value" == "true" ]]; then
          # Check if the output is a complex object
          if $tf_cmd output -json | jq -e --arg name "$output_name" '.[$name].value | type == "object"' > /dev/null 2>&1; then
            echo "Value (object):"
            $tf_cmd output -json | jq --arg name "$output_name" '.[$name].value'
          else
            echo "Value: $($tf_cmd output -json | jq -r --arg name "$output_name" '.[$name].value')"
          fi
        else
          echo "Value: [hidden]"
        fi
        echo ""
      done
      ;;
      
    *)
      echo "Error: Invalid credential type '$cred_type'. Use 'token', 's3', 'output', or 'all'" >&2
      return 1
      ;;
  esac
}

# Allow script to be sourced without executing function
if [[ "${ZSH_EVAL_CONTEXT:-}" == "toplevel" || "${BASH_SOURCE[0]:-}" == "${0:-}" ]]; then
  get_cf_credential "$@"
fi

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
