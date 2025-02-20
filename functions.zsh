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
    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    SOPS_AGE_KEY=$(echo -e "$SOPS_AGE_KEYS" | tail -n 1)
    export SOPS_AGE_KEY
    
    if ! sops --decrypt --in-place "$1"; then
        echo "Error: Decryption failed for $1" >&2
        return 1
    fi
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

declare -A BW_CACHE
BW_CACHE_DURATION=60  # Cache duration in seconds

unlock_bw_if_locked() {
    if [[ -z $BW_SESSION ]]; then
        echo 'bw locked - unlocking into a new session' >&2
        local max_retries=3
        local retries=0

        while [[ $retries -lt $max_retries ]]; do
            export BW_SESSION="$(bw unlock --raw)"
            
            if [[ -z $BW_SESSION ]]; then
                echo "Unlock attempt failed. Please try again." >&2
                ((retries++))
                
                if [[ $retries -eq $max_retries ]]; then
                    echo "Failed to set BW_SESSION environment variable after $max_retries attempts." >&2
                    return 1
                fi
            else
                echo "BW_SESSION set successfully."
                return 0
            fi
        done
    fi
    return 0
}

fetch_items() {
    local current_time=$(date +%s)
    local items_to_fetch=("$@")
    
    unlock_bw_if_locked || return 1
    
    echo "Fetching items: ${items_to_fetch[*]}"
    
    # Construct jq filter for the requested items
    local jq_filter='.[] | select(.name == "'
    jq_filter+=$(printf '%s" or .name == "' "${items_to_fetch[@]}")
    jq_filter+='")'

    # Fetch requested items in bulk
    local items=$(bw list items --session $BW_SESSION | jq -c "$jq_filter")
    if [[ -z $items ]]; then
        echo "Failed to fetch items from Bitwarden." >&2
        return 1
    fi

    echo "Successfully fetched items from Bitwarden."

    echo "$items" | while read -r item; do
        [[ -z $item ]] && continue
        local name=$(echo "$item" | jq -r '.name')
        local value=$(echo "$item" | jq -r '.notes')
        if [[ -n $name && -n $value && $value != "null" ]]; then
            BW_CACHE[$name]="${current_time}|${value}"
            echo "Cached item: $name"
        fi
    done
}

load_from_bitwarden_and_set_env() {
    local item_name="$1"
    local env_var_name="$2"
    local current_time=$(date +%s)

    echo "Loading $item_name into $env_var_name"

    # Check if env var is already set
    if [[ -n ${(P)env_var_name} ]]; then
        # Get the cached value
        if [[ -n ${BW_CACHE[$item_name]} ]]; then
            local cached_value=$(echo ${BW_CACHE[$item_name]} | cut -d'|' -f2)
            if [[ ${(P)env_var_name} == "$cached_value" ]]; then
                echo "$env_var_name already set with correct value, skipping."
                return 0
            fi
        fi
    fi

    # Check cache first
    if [[ -n ${BW_CACHE[$item_name]} ]]; then
        local cache_time=$(echo ${BW_CACHE[$item_name]} | cut -d'|' -f1)
        if (( current_time - cache_time < BW_CACHE_DURATION )); then
            local value=$(echo ${BW_CACHE[$item_name]} | cut -d'|' -f2)
            export "$env_var_name=$value"
            echo "Set $env_var_name from cache."
            return 0
        fi
    fi

    # Fetch single item if not in cache or expired
    fetch_items "$item_name" || return 1

    # Set env var from updated cache
    if [[ -n ${BW_CACHE[$item_name]} ]]; then
        local value=$(echo ${BW_CACHE[$item_name]} | cut -d'|' -f2)
        export "$env_var_name=$value"
        echo "Set $env_var_name successfully."
        return 0
    fi

    echo "No item found containing '$item_name'" >&2
    return 1
}

load_sops_age_keys() {
    if [[ -n $SOPS_AGE_KEYS ]]; then
        echo "SOPS_AGE_KEYS is already set, checking if values match..."
        local current_public_key=""
        local current_secret_key=""
        
        if [[ -n ${BW_CACHE["SOPS_AGE_PUB_KEY"]} && -n ${BW_CACHE["SOPS_AGE_SECRET_KEY"]} ]]; then
            current_public_key=$(echo ${BW_CACHE["SOPS_AGE_PUB_KEY"]} | cut -d'|' -f2)
            current_secret_key=$(echo ${BW_CACHE["SOPS_AGE_SECRET_KEY"]} | cut -d'|' -f2)
            local current_keys="${current_public_key}\n${current_secret_key}"
            
            if [[ "$SOPS_AGE_KEYS" == "$current_keys" ]]; then
                echo "SOPS_AGE_KEYS already contains correct values, skipping."
                return 0
            fi
        fi
        echo "SOPS_AGE_KEYS values differ, updating..."
    fi

    echo "Loading SOPS Age keys"
    local current_time=$(date +%s)
    local need_fetch=0
    local public_key=""
    local secret_key=""

    # Check cache for both keys
    if [[ -n ${BW_CACHE["SOPS_AGE_PUB_KEY"]} && -n ${BW_CACHE["SOPS_AGE_SECRET_KEY"]} ]]; then
        local pub_cache_time=$(echo ${BW_CACHE["SOPS_AGE_PUB_KEY"]} | cut -d'|' -f1)
        local secret_cache_time=$(echo ${BW_CACHE["SOPS_AGE_SECRET_KEY"]} | cut -d'|' -f1)
        
        if (( current_time - pub_cache_time < BW_CACHE_DURATION && 
              current_time - secret_cache_time < BW_CACHE_DURATION )); then
            public_key=$(echo ${BW_CACHE["SOPS_AGE_PUB_KEY"]} | cut -d'|' -f2)
            secret_key=$(echo ${BW_CACHE["SOPS_AGE_SECRET_KEY"]} | cut -d'|' -f2)
            echo "Got SOPS keys from cache."
        else
            need_fetch=1
        fi
    else
        need_fetch=1
    fi

    # Fetch both keys together if either is missing or expired
    if (( need_fetch == 1 )); then
        echo "Fetching SOPS keys from Bitwarden"
        unlock_bw_if_locked || return 1
        
        # Single bw list call for both keys
        local sops_keys=$(bw list items --session $BW_SESSION | jq -r '.[] | select(.name | test("SOPS_AGE_.*_KEY")) | {name: .name, notes: .notes}')
        
        while IFS= read -r key_info; do
            [[ -z $key_info ]] && continue
            local name=$(echo "$key_info" | jq -r '.name')
            local value=$(echo "$key_info" | jq -r '.notes')
            
            if [[ $name == "SOPS_AGE_PUB_KEY" ]]; then
                public_key=$value
                BW_CACHE[$name]="${current_time}|${value}"
                echo "Got public key"
            elif [[ $name == "SOPS_AGE_SECRET_KEY" ]]; then
                secret_key=$value
                BW_CACHE[$name]="${current_time}|${value}"
                echo "Got secret key"
            fi
        done < <(echo "$sops_keys" | jq -c '.')
    fi

    if [[ -z $public_key || $public_key == "null" || -z $secret_key || $secret_key == "null" ]]; then
        echo "Failed to retrieve SOPS Age keys from Bitwarden." >&2
        return 1
    fi

    export SOPS_AGE_KEYS="${public_key}\n${secret_key}"
    echo "SOPS_AGE_KEYS set successfully"
    return 0
}

clear_bw_cache() {
    unset BW_CACHE
    declare -A BW_CACHE
    echo "Bitwarden cache cleared."
}

load_bw() {
    local items=(
        "CLOUDFLARE_EMAIL|CLOUDFLARE_EMAIL"
        # "CLOUDFLARE_EMAIL|GIT_AUTHOR_EMAIL"
        # "CLOUDFLARE_EMAIL|GIT_COMMITTER_EMAIL"
        # "MY_NAME|GIT_AUTHOR_NAME"
        # "MY_NAME|GIT_COMMITTER_NAME"
        "CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ID"
        "CLOUDFLARE_ZONE_ID|CLOUDFLARE_ZONE_ID"
        "CLOUDFLARE_API_KEY|CLOUDFLARE_API_KEY"
        "CLOUDFLARE_ACCESS_OLLAMA_ID|CLOUDFLARE_ACCESS_OLLAMA_ID"
        "CLOUDFLARE_ACCESS_OLLAMA_SECRET|CLOUDFLARE_ACCESS_OLLAMA_SECRET"
        "CARGO_ROOT_KEY|CARGO_REGISTRY_TOKEN"
    )

    # Extract unique item names for bulk fetch
    local unique_items=()
    for item in "${items[@]}"; do
        local item_name=${item%|*}
        if [[ ! " ${unique_items[@]} " =~ " ${item_name} " ]]; then
            unique_items+=("$item_name")
        fi
    done

    # Bulk fetch all unique items
    fetch_items "${unique_items[@]}"

    # Set environment variables from cache
    for item in "${items[@]}"; do
        local item_name=${item%|*}
        local env_var=${item#*|}
        
        # Get the cached value
        local cached_value=""
        if [[ -n ${BW_CACHE[$item_name]} ]]; then
            cached_value=$(echo ${BW_CACHE[$item_name]} | cut -d'|' -f2)
        fi
        
        # Only set if the environment variable doesn't exist or has a different value
        if [[ -z ${(P)env_var} ]]; then
            load_from_bitwarden_and_set_env "$item_name" "$env_var"
        elif [[ ${(P)env_var} != "$cached_value" ]]; then
            echo "Updating $env_var with new value"
            load_from_bitwarden_and_set_env "$item_name" "$env_var"
        else
            echo "Skipping $env_var - value unchanged"
        fi
    done

    load_sops_age_keys
}

load_cf_work() {
    local items=(
        "CF_WORK_API_KEY|CLOUDFLARE_API_KEY"
        "CF_WORK_EMAIL|CLOUDFLARE_EMAIL"
        "AWS_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY"
        "AWS_ACCESS_KEY_ID|AWS_ACCESS_KEY_ID"
        "PAPIREPO_API_KEY|PAPIREPO_API_KEY"
        "CLOUDLET_API_KEY|CLOUDLET_API_KEY"
    )

    # Extract unique items and fetch in bulk
    local unique_items=()
    for item in "${items[@]}"; do
        local item_name=${item%|*}
        if [[ ! " ${unique_items[@]} " =~ " ${item_name} " ]]; then
            unique_items+=("$item_name")
        fi
    done

    # Bulk fetch all unique items
    fetch_items "${unique_items[@]}"

    # Set environment variables from cache
    for item in "${items[@]}"; do
        local item_name=${item%|*}
        local env_var=${item#*|}
        
        # Get the cached value
        local cached_value=""
        if [[ -n ${BW_CACHE[$item_name]} ]]; then
            cached_value=$(echo ${BW_CACHE[$item_name]} | cut -d'|' -f2)
        fi
        
        # Only set if the environment variable doesn't exist or has a different value
        if [[ -z ${(P)env_var} ]]; then
            load_from_bitwarden_and_set_env "$item_name" "$env_var"
        elif [[ ${(P)env_var} != "$cached_value" ]]; then
            echo "Updating $env_var with new value"
            load_from_bitwarden_and_set_env "$item_name" "$env_var"
        else
            echo "Skipping $env_var - value unchanged"
        fi
    done
}

load_wrangler_token() {
    load_from_bitwarden_and_set_env "CLOUDFLARE_WRANGLER_TOKEN" "CLOUDFLARE_API_TOKEN"
}
load_ingka_gh(){
    eval "$(ssh-agent -s)" 
    ssh-add ~/.ssh/id_ingka_gh
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
    unset BW_SESSION
    
    # Also unset cf_work variables
    unset AWS_SECRET_ACCESS_KEY
    unset AWS_ACCESS_KEY_ID
    unset PAPIREPO_API_KEY
    
    # Unset wrangler token
    unset CLOUDFLARE_API_TOKEN

    # Clear the cache
    clear_bw_cache

    echo "All Bitwarden-loaded environment variables have been unset"
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
