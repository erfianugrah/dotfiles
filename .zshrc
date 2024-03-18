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
if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vim'
elseif
  export EDITOR='nvim'
else
  export EDITOR='code'
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
# export TF_LOG=debug
# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

eval "$(zoxide init zsh)"

encrypt_k3s_secret() {
    sops --encrypt --age $(cat $SOPS_AGE_KEY_FILE | grep -oP "public key: \K(.*)") --encrypted-regex '^(data|stringData)$' --in-place "$1"
}
decrypt_k3s_secret() {
    sops --decrypt --age $(cat $SOPS_AGE_KEY_FILE | grep -oP "public key: \K(.*)") --encrypted-regex '^(data|stringData)$' --in-place "$1"
}
encrypt() {
    sops --encrypt --age $(cat $SOPS_AGE_KEY_FILE | grep -oP "public key: \K(.*)") --in-place "$1"
}
decrypt() {
    sops --decrypt --age $(cat $SOPS_AGE_KEY_FILE | grep -oP "public key: \K(.*)") --in-place "$1"
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


load_cloudflare_email() {
  unlock_bw_if_locked

  # Search for the item containing the Cloudflare API key
  local search_result
  search_result=$(bw list items --search "CLOUDFLARE_EMAIL" --session $BW_SESSION)

  # Parse the ID of the first matching item
  local secure_note_id
  secure_note_id=$(echo "$search_result" | jq -r '.[0].id')

  # Check if an ID was found
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing 'CLOUDFLARE_EMAIL'" >&2
    return 1
  fi

  # Fetch the Cloudflare API key from Bitwarden using the found ID
  local cloudflare_email
  cloudflare_email=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')

  # Check if the API key was successfully retrieved
  if [[ -z $cloudflare_email || $cloudflare_email == "null" ]]; then
    echo "Failed to retrieve Cloudflare API key from Bitwarden." >&2
    return 1
  fi

  export CLOUDFLARE_EMAIL="$cloudflare_email"
}

load_cloudflare_email "$@"

load_cloudflare_account_id() {
  unlock_bw_if_locked

  # Search for the item containing the Cloudflare API key
  local search_result
  search_result=$(bw list items --search "CLOUDFLARE_ACCOUNT_ID" --session $BW_SESSION)

  # Parse the ID of the first matching item
  local secure_note_id
  secure_note_id=$(echo "$search_result" | jq -r '.[0].id')

  # Check if an ID was found
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing 'CLOUDFLARE_ACCOUNT_ID'" >&2
    return 1
  fi

  # Fetch the Cloudflare API key from Bitwarden using the found ID
  local cloudflare_account_id
  cloudflare_account_id=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')

  # Check if the API key was successfully retrieved
  if [[ -z $cloudflare_account_id || $cloudflare_account_id == "null" ]]; then
    echo "Failed to retrieve Cloudflare API key from Bitwarden." >&2
    return 1
  fi

  export CLOUDFLARE_ACCOUNT_ID="$cloudflare_account_id"
}

load_cloudflare_account_id "$@"

load_cloudflare_zone_id() {
  unlock_bw_if_locked

  # Search for the item containing the Cloudflare API key
  local search_result
  search_result=$(bw list items --search "CLOUDFLARE_ZONE_ID" --session $BW_SESSION)

  # Parse the ID of the first matching item
  local secure_note_id
  secure_note_id=$(echo "$search_result" | jq -r '.[0].id')

  # Check if an ID was found
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing 'CLOUDFLARE_ZONE_ID'" >&2
    return 1
  fi

  # Fetch the Cloudflare API key from Bitwarden using the found ID
  local cloudflare_zone_id
  cloudflare_zone_id=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')

  # Check if the API key was successfully retrieved
  if [[ -z $cloudflare_zone_id || $cloudflare_zone_id == "null" ]]; then
    echo "Failed to retrieve Cloudflare API key from Bitwarden." >&2
    return 1
  fi

  export CLOUDFLARE_ZONE_ID="$cloudflare_zone_id"
}

load_cloudflare_zone_id "$@"

load_cloudflare_api_key() {
  unlock_bw_if_locked

  # Search for the item containing the Cloudflare API key
  local search_result
  search_result=$(bw list items --search "CLOUDFLARE_API_KEY" --session $BW_SESSION)

  # Parse the ID of the first matching item
  local secure_note_id
  secure_note_id=$(echo "$search_result" | jq -r '.[0].id')

  # Check if an ID was found
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing 'CLOUDFLARE_API_KEY'" >&2
    return 1
  fi

  # Fetch the Cloudflare API key from Bitwarden using the found ID
  local cloudflare_api_key
  cloudflare_api_key=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')

  # Check if the API key was successfully retrieved
  if [[ -z $cloudflare_api_key || $cloudflare_api_key == "null" ]]; then
    echo "Failed to retrieve Cloudflare API key from Bitwarden." >&2
    return 1
  fi

  export CLOUDFLARE_API_KEY="$cloudflare_api_key"
}

load_cloudflare_api_key "$@"

load_cloudflare_api_token() {
  unlock_bw_if_locked

  # Search for the item containing the Cloudflare API key
  local search_result
  search_result=$(bw list items --search "CLOUDFLARE_API_TOKEN" --session $BW_SESSION)

  # Parse the ID of the first matching item
  local secure_note_id
  secure_note_id=$(echo "$search_result" | jq -r '.[0].id')

  # Check if an ID was found
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing 'CLOUDFLARE_API_TOKEN'" >&2
    return 1
  fi

  # Fetch the Cloudflare API key from Bitwarden using the found ID
  local cloudflare_api_token
  cloudflare_api_token=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')

  # Check if the API key was successfully retrieved
  if [[ -z $cloudflare_api_token || $cloudflare_api_token == "null" ]]; then
    echo "Failed to retrieve Cloudflare API key from Bitwarden." >&2
    return 1
  fi

  export CLOUDFLARE_API_TOKEN="$cloudflare_api_token"
}

load_cloudflare_api_token "$@"

load_sops_age_key() {
  unlock_bw_if_locked

  # Search for the item containing the SOPS Age key
  local search_result
  search_result=$(bw list items --search "SOPS_AGE_KEY" --session $BW_SESSION)

  # Parse the ID of the first matching item
  local secure_note_id
  secure_note_id=$(echo "$search_result" | jq -r '.[0].id')

  # Check if an ID was found
  if [[ -z $secure_note_id || $secure_note_id == "null" ]]; then
    echo "No item found containing 'SOPS_AGE_KEY'" >&2
    return 1
  fi

  # Fetch the SOPS Age key from Bitwarden using the found ID
  local sops_age_key
  sops_age_key=$(bw get item $secure_note_id --session $BW_SESSION | jq -r '.notes')

  # Check if the key was successfully retrieved
  if [[ -z $sops_age_key || $sops_age_key == "null" ]]; then
    echo "Failed to retrieve SOPS Age key from Bitwarden." >&2
    return 1
  fi

  # Save the key to a temporary file and export its path
  local temp_key_file=$(mktemp)
  echo "$sops_age_key" > "$temp_key_file"
  export SOPS_AGE_KEY_FILE="$temp_key_file"
}