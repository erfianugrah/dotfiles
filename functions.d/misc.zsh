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
