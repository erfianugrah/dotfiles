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
  tmux
  npm
  docker-compose
  kubectl
  python
  pip
  gh
)

if [[ -z "$TMUX" ]]; then
  if tmux list-sessions &> /dev/null; then
    tmux attach -t default || tmux new-session -s default
  else
    tmux new-session -s default
  fi
fi

ZSH_TMUX_AUTOSTART=true

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
# export TF_LOG=debug
# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

eval "$(zoxide init zsh)"

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
    # After attempting to unlock, check if BW_SESSION is still empty
    if [[ -z $BW_SESSION ]]; then
      echo "Failed to set BW_SESSION environment variable." >&2
      return 1
    else
      echo "BW_SESSION set successfully."
    fi
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

load_from_bitwarden_and_set_env "CLOUDFLARE_EMAIL" "CLOUDFLARE_EMAIL"
load_from_bitwarden_and_set_env "CLOUDFLARE_ACCOUNT_ID" "CLOUDFLARE_ACCOUNT_ID"
load_from_bitwarden_and_set_env "CLOUDFLARE_ZONE_ID" "CLOUDFLARE_ZONE_ID"
load_from_bitwarden_and_set_env "CLOUDFLARE_API_KEY" "CLOUDFLARE_API_KEY"
load_from_bitwarden_and_set_env "CLOUDFLARE_API_TOKEN" "CLOUDFLARE_API_TOKEN"

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

load_sops_age_keys

tx_switch() {
  # Check if a session name is provided as an argument
  local session_name="${1:-default}"

  # Create a new session in detached mode (-d) with the given name
  tmux new-session -d -s "$session_name"

  # Switch the tmux client to the newly created session
  tmux switch-client -t "$session_name"
}

if [[ -n "$TMUX" ]]; then
    export TERM="screen-256color"
fi
