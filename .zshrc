# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH
export PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/usr/lib/wsl/lib:$PATH

# Path to your oh-my-zsh installation.
export ZSH=$HOME/.oh-my-zsh

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="powerlevel10k/powerlevel10k"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.

plugins=(
  git
  git-auto-fetch
  git-prompt
  sudo
  vscode
  github
  brew
  ansible
  zsh-autosuggestions
  zsh-syntax-highlighting
  terraform
)

source $ZSH/oh-my-zsh.sh
source ~/zsh-defer/zsh-defer.plugin.zsh
# User configuration

# export MANPATH="/usr/local/man:$MANPATH"
# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='code'
# fi

# Attempt to set EDITOR to vim, nano, then code, in that order of preference
if command -v vim &> /dev/null; then
  export EDITOR='vim'
elif command -v nano &> /dev/null; then
  export EDITOR='nano'
elif command -v code &> /dev/null; then
  export EDITOR='code --wait'
else
  echo "No preferred editor found. Consider installing vim, nano, or Visual Studio Code."
fi

# Compilation flags
# export ARCHFLAGS="-arch x86_64"

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"
   
POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true
alias k=kubectl
alias t=tofu
alias tf=terraform
alias w=wrangler
alias cft=cf-terraforming
alias p=python3
alias bw='NODE_OPTIONS="--no-deprecation" bw'
export CACHE_DIR="$HOME/.cache/zsh"
# export TF_LOG=debug
# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

eval "$(zoxide init zsh)"

encrypt_k3s_secret() {
    sops --encrypt --age $(echo $SOPS_AGE_KEYS  | grep -oP "public key: \K(.*)") --encrypted-regex '^(data|stringData)$' --in-place "$1"
}
decrypt_k3s_secret() {
    # Extract the secret key from the combined environment variable
    local secret_key=$(echo -e $SOPS_AGE_KEYS | tail -n 1)

    # Write the secret key to a temporary file
    local temp_key_file=$(mktemp)
    echo "$secret_key" > "$temp_key_file"

    # Use the temporary file for decryption
    SOPS_AGE_KEY_FILE="$temp_key_file" sops --decrypt --encrypted-regex '^(data|stringData)$' --in-place "$1"

    # Cleanup
    rm -f "$temp_key_file"
}
encrypt() {
    sops --encrypt --age $(echo $SOPS_AGE_KEYS | grep -oP "public key: \K(.*)") --in-place "$1"
}
decrypt() {
    # Extract the secret key from the combined environment variable
    local secret_key=$(echo -e $SOPS_AGE_KEYS | tail -n 1)

    # Write the secret key to a temporary file
    local temp_key_file=$(mktemp)
    echo "$secret_key" > "$temp_key_file"

    # Use the temporary file for decryption
    SOPS_AGE_KEY_FILE="$temp_key_file" sops --decrypt --in-place "$1"

    # Cleanup
    rm -f "$temp_key_file"
}

encrypt_tf() {
  encrypt secrets.tfvars && encrypt terraform.tfstate && encrypt terraform.tfstate.backup
}
decrypt_tf() {
  decrypt secrets.tfvars && decrypt terraform.tfstate && decrypt terraform.tfstate.backup
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
  if [[ -z $BW_SESSION ]] ; then
    >&2 echo 'bw locked - unlocking into a new session'
    export BW_SESSION="$(bw unlock --raw)"
  fi
}

# General function to load data from Bitwarden with caching
load_from_bitwarden_with_cache() {
  local item_name="$1"
  local cache_file="$CACHE_DIR/${item_name}.cache"
  local max_age=14400 # 24 hours

  if [[ -f "$cache_file" && $(($(date +%s) - $(stat -c %Y "$cache_file"))) -lt $max_age ]]; then
    echo "$(cat "$cache_file")"
  else
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
    echo "$item_value" > "$cache_file"
    echo "$item_value"
  fi
}

# Function to load Cloudflare Email with caching
load_cloudflare_email() {
  export CLOUDFLARE_EMAIL="$(load_from_bitwarden_with_cache "CLOUDFLARE_EMAIL")"
}

load_cloudflare_email "$@"

load_cloudflare_account_id() {
  export CLOUDFLARE_ACCOUNT_ID="$(load_from_bitwarden_with_cache "CLOUDFLARE_ACCOUNT_ID")"
}

load_cloudflare_account_id "$@"

load_cloudflare_zone_id() {
  export CLOUDFLARE_ZONE_ID="$(load_from_bitwarden_with_cache "CLOUDFLARE_ZONE_ID")"
}

load_cloudflare_zone_id "$@"

load_cloudflare_api_key() {
  export CLOUDFLARE_API_KEY="$(load_from_bitwarden_with_cache "CLOUDFLARE_API_KEY")"
}

load_cloudflare_api_key "$@"

load_cloudflare_api_token() {
  export CLOUDFLARE_API_TOKEN="$(load_from_bitwarden_with_cache "CLOUDFLARE_API_TOKEN")"
}

load_cloudflare_api_token "$@"

load_sops_age_keys() {
  unlock_bw_if_locked

  local cache_file_pub="$CACHE_DIR/sops_age_pub_key.cache"
  local cache_file_sec="$CACHE_DIR/sops_age_sec_key.cache"
  local max_age=14400 # 24 hours

  # Check if the cache files exist and are fresh
  if [[ -f "$cache_file_pub" && -f "$cache_file_sec" && $(($(date +%s) - $(stat -c %Y "$cache_file_pub"))) -lt $max_age && $(($(date +%s) - $(stat -c %Y "$cache_file_sec"))) -lt $max_age ]]; then
    local public_key="$(<"$cache_file_pub")"
    local secret_key="$(<"$cache_file_sec")"
  else
    # Fetch the public key
    local public_key=$(bw list items --search "SOPS_AGE_PUB_KEY" --session $BW_SESSION | jq -r '.[] | select(.name == "SOPS_AGE_PUB_KEY") | .notes')
    # Fetch the secret key
    local secret_key=$(bw list items --search "SOPS_AGE_SECRET_KEY" --session $BW_SESSION | jq -r '.[] | select(.name == "SOPS_AGE_SECRET_KEY") | .notes')

    if [[ -z $public_key || $public_key == "null" || -z $secret_key || $secret_key == "null" ]]; then
      echo "Failed to retrieve SOPS Age keys from Bitwarden." >&2
      return 1
    fi

    # Save the fetched keys to cache
    echo "$public_key" > "$cache_file_pub"
    echo "$secret_key" > "$cache_file_sec"
  fi

  # Combine the keys into one environment variable
  export SOPS_AGE_KEYS="${public_key}\n${secret_key}"
}

load_sops_age_keys "$@"