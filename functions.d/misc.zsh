# ---------------------------------------------------------------------------
# Ansible shortcuts
# ---------------------------------------------------------------------------

time_now() {
    if command -v gdate &>/dev/null; then
        gdate -u +"%Y-%m-%dT%H:%M:%S.%3NZ"
    elif date -u +"%3N" &>/dev/null 2>&1; then
        date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"
    else
        date -u +"%Y-%m-%dT%H:%M:%S.000Z"
    fi
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
