encrypt_k3s_secret() {
    # Extract the public key from SOPS_AGE_KEYS and use it for encryption
    local public_key=$(echo $SOPS_AGE_KEYS | grep -oP "public key: \K(.*)")
    
    # Ensure the public key is extracted correctly
    if [[ -z $public_key ]]; then
        echo "Failed to extract public key from SOPS_AGE_KEYS" >&2
        return 1
    fi

    # Perform encryption using the extracted public key
    sops --encrypt --age $public_key --encrypted-regex '^(data|stringData)$' --in-place "$1"
}

decrypt_k3s_secret() {
    # Extract the secret key from SOPS_AGE_KEYS
    local secret_key=$(echo -e $SOPS_AGE_KEYS | tail -n 1)

    # Create a temporary file to hold the secret key
    local temp_key_file=$(mktemp)

    # Write the secret key to the temporary file
    echo "$secret_key" > "$temp_key_file"

    # Set the SOPS_AGE_KEY_FILE environment variable to point to the temporary key file
    export SOPS_AGE_KEY_FILE="$temp_key_file"

    # Perform decryption
    sops --decrypt --encrypted-regex '^(data|stringData)$' --in-place "$1"

    # Clean up the temporary key file
    rm -f "$temp_key_file"
}

encrypt() {
    sops --encrypt --age $(echo $SOPS_AGE_KEYS | grep -oP "public key: \K(.*)") --in-place "$1"
}

decrypt() {
    local secret_key=$(echo -e $SOPS_AGE_KEYS | tail -n 1)

    local temp_key_file=$(mktemp)

    echo "$secret_key" > "$temp_key_file"

    SOPS_AGE_KEY_FILE="$temp_key_file" sops --decrypt --in-place "$1"

    rm -f "$temp_key_file"
}

encrypt_tf() {
  encrypt secrets.tfvars && encrypt terraform.tfstate && encrypt terraform.tfstate.backup
  for file in *.tfstate*; do
    encrypt "$file"
  done
}

decrypt_tf() {
  decrypt secrets.tfvars && decrypt terraform.tfstate && decrypt terraform.tfstate.backup
  for file in *.tfstate*; do
    decrypt "$file"
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

unlock_bw_if_locked() {
    local max_retries=3
    local retries=0

    if [[ -z $BW_SESSION ]]; then
        echo 'bw locked - unlocking into a new session' >&2

        while [[ $retries -lt $max_retries ]]; do
            export BW_SESSION="$(bw unlock --raw)"
            
            # After attempting to unlock, check if BW_SESSION is still empty
            if [[ -z $BW_SESSION ]]; then
                echo "Unlock attempt failed. Please try again." >&2
                ((retries++))
                
                # Check if maximum retries have been reached
                if [[ $retries -eq $max_retries ]]; then
                    echo "Failed to set BW_SESSION environment variable after $max_retries attempts." >&2
                    return 1
                fi
            else
                echo "BW_SESSION set successfully."
                return 0
            fi
        done
    else
        echo "BW_SESSION is already set."
    fi
}

load_from_bitwarden_and_set_env() {
  local item_name="$1"
  local env_var_name="$2"

  # Check if the environment variable is already set
  if [[ -n ${(P)env_var_name} ]]; then
    echo "$env_var_name environment variable is already set."
    return 0
  fi

  unlock_bw_if_locked
  local search_result=$(bw list items --search "$item_name" --session $BW_SESSION)
  local secure_note_id=$(echo "$search_result" | jq -r '.[0].id')
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing '$item_name'" >&2
    return 1
  fi
  local item_value=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')
  if [[ -z $item_value || $item_value == "null" ]]; then
    echo "Failed to retrieve $item_name from Bitwarden." >&2
    return 1
  fi

  # Set the environment variable
  export "$env_var_name=$item_value"

  # Recheck if the environment variable is set using Zsh compatible method
  if [[ -z ${(P)env_var_name} ]]; then
    echo "Failed to set environment variable for $item_name." >&2
    return 1
  else
    echo "$env_var_name set successfully."
  fi
}

load_sops_age_keys() {
  # Check if the SOPS_AGE_KEYS environment variable is already set
  if [[ -n $SOPS_AGE_KEYS ]]; then
    echo "SOPS_AGE_KEYS environment variable is already set."
    return 0
  fi

  unlock_bw_if_locked

  local public_key=$(bw list items --search "SOPS_AGE_PUB_KEY" --session $BW_SESSION | jq -r '.[] | select(.name == "SOPS_AGE_PUB_KEY") | .notes')
  local secret_key=$(bw list items --search "SOPS_AGE_SECRET_KEY" --session $BW_SESSION | jq -r '.[] | select(.name == "SOPS_AGE_SECRET_KEY") | .notes')

  if [[ -z $public_key || $public_key == "null" || -z $secret_key || $secret_key == "null" ]]; then
    echo "Failed to retrieve SOPS Age keys from Bitwarden." >&2
    return 1
  fi

  # Concatenate the keys with a newline and set them as a single environment variable
  export SOPS_AGE_KEYS="${public_key}\n${secret_key}"

  # Recheck if the environment variable is set
  if [[ -z $SOPS_AGE_KEYS ]]; then
    echo "Failed to set SOPS_AGE_KEYS environment variable." >&2
    return 1
  else
    echo "SOPS_AGE_KEYS environment variable set successfully."
  fi
}

tx_switch() {
  # Check if a session name is provided as an argument
  local session_name="${1:-default}"

  # Create a new session in detached mode (-d) with the given name
  tmux new-session -d -s "$session_name"

  # Switch the tmux client to the newly created session
  tmux switch-client -t "$session_name"
}

load_bw() {
  load_from_bitwarden_and_set_env "CLOUDFLARE_EMAIL" "CLOUDFLARE_EMAIL"
  load_from_bitwarden_and_set_env "CLOUDFLARE_EMAIL" "GIT_AUTHOR_EMAIL"
  load_from_bitwarden_and_set_env "CLOUDFLARE_EMAIL" "GIT_COMMITTER_EMAIL"
  load_from_bitwarden_and_set_env "MY_NAME" "GIT_AUTHOR_NAME"
  load_from_bitwarden_and_set_env "MY_NAME" "GIT_COMMITTER_NAME"
  load_from_bitwarden_and_set_env "CLOUDFLARE_ACCOUNT_ID" "CLOUDFLARE_ACCOUNT_ID"
  load_from_bitwarden_and_set_env "CLOUDFLARE_ZONE_ID" "CLOUDFLARE_ZONE_ID"
  load_from_bitwarden_and_set_env "CLOUDFLARE_API_KEY" "CLOUDFLARE_API_KEY"
  load_from_bitwarden_and_set_env "CLOUDFLARE_ACCESS_OLLAMA_ID" "CLOUDFLARE_ACCESS_OLLAMA_ID"
  load_from_bitwarden_and_set_env "CLOUDFLARE_ACCESS_OLLAMA_SECRET" "CLOUDFLARE_ACCESS_OLLAMA_SECRET"
  load_from_bitwarden_and_set_env "CARGO_ROOT_KEY" "CARGO_REGISTRY_TOKEN"
  load_sops_age_keys
}

load_wrangler_token() {
  load_from_bitwarden_and_set_env "CLOUDFLARE_API_TOKEN" "CLOUDFLARE_API_TOKEN"
}

p10k_colours() {
  for i in {0..255}; do print -Pn "%K{$i}  %k%F{$i}${(l:3::0:)i}%f " ${${(M)$((i%6)):#3}:+$'\n'}; done
}
