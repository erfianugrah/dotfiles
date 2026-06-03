# ---------------------------------------------------------------------------
# Local Model Loader — wait for llm-compose proxy models to load into VRAM
# ---------------------------------------------------------------------------

wait_for_model() {
    local model_preset="${1:-gemma4}"
    local url="http://localhost:11434/v1/models"
    local timeout=60
    local elapsed=0

    echo -n "Waiting for model '$model_preset' to load... "
    while true; do
        # Check if the model with the given preset is marked as 'loaded: true'
        local loaded=$(curl -s "$url" | jq -r ".data[] | select(.meta.preset == \"$model_preset\") | .meta.loaded" 2>/dev/null)
        if [[ "$loaded" == "true" ]]; then
            echo -e "\r\033[32m✓ Loaded\033[0m"
            return 0
        fi
        if [[ $elapsed -ge $timeout ]]; then
            echo -e "\r\033[31m✗ Timeout after ${timeout}s\033[0m"
            return 1
        fi
        echo -n "."
        sleep 1
        ((elapsed++))
    done
}

alias wait_model='wait_for_model'

# ---------------------------------------------------------------------------
# Ansible shortcuts
# ---------------------------------------------------------------------------

time_now() {
    if command -v gdate &>/dev/null; then
        gdate -u +"%Y-%m-%dT%H:%M:%S.%3NZ"
    elif [[ "$(date -u +%3N 2>/dev/null)" =~ ^[0-9]+$ ]]; then
        date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"
    else
        date -u +"%Y-%m-%dT%H:%M:%S.000Z"
    fi
}

ANSIBLE_PLAYBOOK_DIR="${ANSIBLE_PLAYBOOK_DIR:-$HOME/my-playbooks}"

ansible_on() {
   ansible-playbook -i "${ANSIBLE_PLAYBOOK_DIR}/inventory.yml" "${ANSIBLE_PLAYBOOK_DIR}/poweron.yml" --ask-become-pass
}

ansible_off() {
   ansible-playbook -i "${ANSIBLE_PLAYBOOK_DIR}/inventory.yml" "${ANSIBLE_PLAYBOOK_DIR}/shutdown.yml" --ask-become-pass
}

ansible_update() {
   ansible-playbook -i "${ANSIBLE_PLAYBOOK_DIR}/inventory.yml" "${ANSIBLE_PLAYBOOK_DIR}/update.yml" --ask-become-pass
}

# ---------------------------------------------------------------------------
# Tmux / terminal helpers
# ---------------------------------------------------------------------------

tx_switch() {
    local session_name="${1:-default}"
    tmux new-session -d -s "$session_name"
    tmux switch-client -t "$session_name"
}

p10k_colours() {
  for i in {0..255}; do print -Pn "%K{$i}  %k%F{$i}${(l:3::0:)i}%f " ${${(M)$((i%6)):#3}:+$'\n'}; done
}

# ---------------------------------------------------------------------------
# install_pi — install/update the pi coding agent (standalone Bun binary)
# ---------------------------------------------------------------------------
# The official installer (pi.dev/install.sh) and `npm install -g` produce the
# Node build, which has no `bun:sqlite` and so breaks Bun-only extensions like
# session-fts ("bun:sqlite module not found"). This fetches the standalone
# Bun-compiled release binary instead — it embeds the Bun runtime, matching the
# Linux box. Idempotent: re-run to update to the latest release.
#
# Layout: ~/.local/opt/pi/ (extracted tarball) + ~/.local/bin/pi (symlink).
# Wired into `install_packages` via packages/standalone.txt (pi=install_pi).
# ---------------------------------------------------------------------------
install_pi() {
  local repo="earendil-works/pi"
  local prefix="$HOME/.local/opt" bindir="$HOME/.local/bin"
  local GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' DIM=$'\033[2m' RESET=$'\033[0m'

  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) print "${RED}install_pi: unsupported OS $(uname -s)${RESET}" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) print "${RED}install_pi: unsupported arch $(uname -m)${RESET}" >&2; return 1 ;;
  esac

  local asset="pi-${os}-${arch}.tar.gz"
  local url="https://github.com/${repo}/releases/latest/download/${asset}"
  local tmp; tmp="$(mktemp -d)" || return 1

  print "install_pi: downloading ${DIM}${asset}${RESET}..."
  if ! curl -fsSL -o "${tmp}/${asset}" "$url"; then
    print "${RED}install_pi: download failed: ${url}${RESET}" >&2; rm -rf "$tmp"; return 1
  fi

  # Warn if a conflicting npm/Node pi would shadow the binary on PATH.
  local existing; existing="$(command -v pi 2>/dev/null)"
  if [[ -n "$existing" && "$existing" != "${bindir}/pi" ]]; then
    print "${YELLOW}install_pi: existing pi at ${existing} (likely the npm build) will be shadowed.${RESET}"
    print "${DIM}            remove it with: npm uninstall -g @earendil-works/pi-coding-agent${RESET}"
  fi

  mkdir -p "$prefix" "$bindir"
  rm -rf "${prefix}/pi"
  tar xzf "${tmp}/${asset}" -C "$prefix"   # tarball top dir is pi/ -> ~/.local/opt/pi
  rm -rf "$tmp"

  # macOS Gatekeeper: clear quarantine on the unsigned binary, else it's blocked.
  if [[ "$os" == "darwin" ]] && command -v xattr &>/dev/null; then
    xattr -dr com.apple.quarantine "${prefix}/pi" 2>/dev/null
  fi

  ln -sf "${prefix}/pi/pi" "${bindir}/pi"
  hash -r 2>/dev/null

  print "${GREEN}install_pi: installed${RESET} ${bindir}/pi ${DIM}($("${bindir}/pi" --version 2>/dev/null))${RESET}"
  [[ ":$PATH:" == *":${bindir}:"* ]] || \
    print "${YELLOW}install_pi: ${bindir} is not on PATH — add it to use \`pi\`.${RESET}" >&2
}

# ---------------------------------------------------------------------------
# Yazi file manager — cd on exit
# ---------------------------------------------------------------------------

yy() {
	local tmp="$(mktemp -t "yazi-cwd.XXXXXX")"
	yazi "$@" --cwd-file="$tmp"
	if cwd="$(cat -- "$tmp")" && [ -n "$cwd" ] && [ "$cwd" != "$PWD" ]; then
		builtin cd -- "$cwd"
	fi
	rm -f -- "$tmp"
}
