# ---------------------------------------------------------------------------
# Encryption / Decryption — SOPS + Age
# ---------------------------------------------------------------------------

# bcrypt_hash [rounds] - prompt for a password (hidden, with confirmation),
# print its bcrypt hash. Verifies the hash round-trips before printing.
# Default cost factor is 12. Needs the `bcrypt` python package.
bcrypt_hash() {
    local rounds="${1:-12}"
    if ! [[ "$rounds" == <-> ]]; then
        echo "Usage: bcrypt_hash [rounds]  (rounds is an integer, default 12)" >&2
        return 1
    fi
    BCRYPT_ROUNDS="$rounds" python3 - <<'PY'
import bcrypt, getpass, os, sys
rounds = int(os.environ["BCRYPT_ROUNDS"])
pw = getpass.getpass("Password: ").encode()
if pw != getpass.getpass("Confirm : ").encode():
    print("Passwords do not match.", file=sys.stderr)
    sys.exit(1)
h = bcrypt.hashpw(pw, bcrypt.gensalt(rounds=rounds))
assert bcrypt.checkpw(pw, h)  # proves the hash matches what you typed
print(h.decode())
PY
}

# ---------------------------------------------------------------------------
# SOPS + Age helpers
# ---------------------------------------------------------------------------

# Extract Age private key from SOPS_AGE_KEYS (explicit match, not tail -n 1)
_sops_age_private_key() {
    local key
    key=$(print -r -- "$SOPS_AGE_KEYS" | grep '^AGE-SECRET-KEY-' | head -1)
    if [[ -z "$key" ]]; then
        echo "Error: No AGE-SECRET-KEY found in SOPS_AGE_KEYS" >&2
        return 1
    fi
    print -r -- "$key"
}

# Extract Age public key from SOPS_AGE_KEYS
_sops_age_public_key() {
    local key
    key=$(print -r -- "$SOPS_AGE_KEYS" | grep -oE 'age1[a-z0-9]+' | head -1)
    if [[ -z "$key" ]]; then
        echo "Error: Failed to extract public key from SOPS_AGE_KEYS" >&2
        return 1
    fi
    print -r -- "$key"
}

encrypt_k3s_secret() {
    local public_key
    public_key=$(_sops_age_public_key) || return 1

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

    local age_key
    age_key=$(_sops_age_private_key) || return 1

    # Inline env: SOPS_AGE_KEY only exists for duration of sops command
    SOPS_AGE_KEY="$age_key" sops --decrypt --encrypted-regex '^(data|stringData)$' --in-place "$1" || {
        echo "Error: Decryption failed for $1" >&2
        return 1
    }
}

encrypt() {
    if [[ -z "${1:-}" ]]; then
        echo "Usage: encrypt <file|directory>" >&2
        return 1
    fi

    local public_key
    public_key=$(_sops_age_public_key) || return 1

    # If argument is a directory, encrypt all files in it
    if [[ -d "$1" ]]; then
        local dir="$1"
        if [[ -z "$(ls -A "$dir")" ]]; then
            echo "Error: Directory $dir is empty" >&2
            return 1
        fi
        
        for file in "$dir"/*; do
            if [[ -f "$file" ]]; then
                echo "Encrypting: $file"
                if ! sops --encrypt --age "$public_key" --in-place "$file"; then
                    echo "Error: Encryption failed for $file" >&2
                    return 1
                fi
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
    echo "Encrypted: $1"
}

decrypt() {
    if [[ -z "${1:-}" ]]; then
        echo "Usage: decrypt <file|directory>" >&2
        return 1
    fi

    local age_key
    age_key=$(_sops_age_private_key) || return 1

    # If argument is a directory, decrypt all files in it
    if [[ -d "$1" ]]; then
        local dir="$1"
        if [[ -z "$(ls -A "$dir")" ]]; then
            echo "Error: Directory $dir is empty" >&2
            return 1
        fi
        
        for file in "$dir"/*; do
            if [[ -f "$file" ]]; then
                echo "Decrypting: $file"
                SOPS_AGE_KEY="$age_key" sops --decrypt --in-place "$file" || {
                    echo "Error: Decryption failed for $file" >&2
                    return 1
                }
            fi
        done
        return 0
    fi

    if [[ ! -f "$1" ]]; then
        echo "Error: File $1 does not exist" >&2
        return 1
    fi

    SOPS_AGE_KEY="$age_key" sops --decrypt --in-place "$1" || {
        echo "Error: Decryption failed for $1" >&2
        return 1
    }
    echo "Decrypted: $1"
}

# encrypt_all / decrypt_all — operate on current directory
encrypt_all() { encrypt .; }
decrypt_all() { decrypt .; }

encrypt_tf() {
    local named_files=("secrets.tfvars" "terraform.tfvars" "blueprint-export.yaml")
    local count=0

    for file in "${named_files[@]}"; do
        if [[ -f "$file" ]]; then
            encrypt "$file" || return 1
            ((count++))
        fi
    done

    # Glob separately — use (N) nullglob qualifier to avoid error when no matches
    for file in *.tfstate*(N); do
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

    for file in "${named_files[@]}"; do
        if [[ -f "$file" ]]; then
            decrypt "$file" || return 1
            ((count++))
        fi
    done

    # Glob separately — use (N) nullglob qualifier to avoid error when no matches
    for file in *.tfstate*(N); do
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

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# sops_rotate_age - rotate a compromised age key across everything it touches
# ---------------------------------------------------------------------------
#
# Scans recursively for ANY file containing the old public key, classifies
# each hit as sops-encrypted (rotate via updatekeys) or prose (text replace),
# updates .sops.yaml recipients, and reports git state per repo so you can
# commit. Optionally cross-checks GitHub for repos you don't have locally.
#
# Key safety note: `sops updatekeys` re-wraps the SAME data key (DEK) under
# the new recipient. Sufficient when only the private key leaked (DEKs were
# never exposed). If the ciphertext itself is also public, you need full
# re-encryption instead: set SOPS_ROTATE_FULL=1 (slow; new DEK per file).
#
# Usage:
#   sops_rotate_age <old_pubkey> [new_pubkey] [root]
#
#   old_pubkey   required. The compromised age public key.
#   new_pubkey   optional. Resolved from SOPS_AGE_KEYS env var, else the first
#                non-old key in SOPS_AGE_KEY_FILE / ~/.config/sops/age/keys.txt.
#                If multiple candidates exist, prompts to pick one.
#   root         optional, defaults to $HOME. Directories always skipped:
#                .git, node_modules, pi session logs, Trash.
#
# Flags (env vars):
#   SOPS_ROTATE_DRY=1      dry run (report only, change nothing)
#   SOPS_ROTATE_FULL=1     full re-encrypt (new DEK), not just re-wrap
#   SOPS_ROTATE_CHECK_GH=0 skip the GitHub missing-repo cross-check (default on)
#   SOPS_ROTATE_PULL=1     auto-pull repos that are behind remote (default: prompt)
sops_rotate_age() {
    emulate -L zsh
    setopt extended_glob null_glob

    local old_key="$1" new_key="$2" root="${3:-$HOME}"
    local dry="${SOPS_ROTATE_DRY:-0}"
    local full="${SOPS_ROTATE_FULL:-0}"
    local check_gh="${SOPS_ROTATE_CHECK_GH:-1}"

    if [[ -z "$old_key" ]]; then
        echo "Usage: sops_rotate_age <old_pubkey> [new_pubkey] [root]" >&2
        return 1
    fi

    # --- resolve new key: arg -> env var -> keys file -> prompt ---
    if [[ -z "$new_key" ]]; then
        local -a candidates
        if [[ -n "$SOPS_AGE_KEYS" ]]; then
            candidates=(${(f)"$(print -r -- "$SOPS_AGE_KEYS" | grep -oE 'age1[a-z0-9]+' | grep -v "^$old_key$" | sort -u)"})
        fi
        if (( ${#candidates} == 0 )); then
            local keyfile="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
            [[ -f "$keyfile" ]] && candidates=(${(f)"$(grep -oE 'age1[a-z0-9]+' "$keyfile" | grep -v "^$old_key$" | sort -u)"})
        fi
        if (( ${#candidates} == 0 )); then
            echo "[sops-rotate] No new key found in SOPS_AGE_KEYS or keys file." >&2
            return 1
        elif (( ${#candidates} == 1 )); then
            new_key="${candidates[1]}"
        else
            if [[ -t 0 ]]; then
                echo "[sops-rotate] Multiple candidate new keys:"
                select k in "${candidates[@]}"; do
                    [[ -n "$k" ]] && new_key="$k" && break
                done
            else
                # non-interactive: refuse to guess - pass the key explicitly
                echo "[sops-rotate] Multiple candidate new keys and no TTY to pick from:" >&2
                printf '  %s\n' "${candidates[@]}" >&2
                echo "[sops-rotate] Pass the new key as argument 2." >&2
                return 1
            fi
        fi
    fi
    echo "[sops-rotate] old: $old_key"
    echo "[sops-rotate] new: $new_key"
    [[ "$dry" == "1" ]] && echo "[sops-rotate] DRY RUN - no changes will be made"
    [[ "$full" == "1" ]] && echo "[sops-rotate] FULL re-encrypt mode (new DEK per file)"

    # --- GitHub cross-check: repos with the key that aren't local ---
    if [[ "$check_gh" == "1" ]] && (( $+commands[gh] )); then
        echo ""
        echo "[sops-rotate] Checking GitHub for repos with the old key..."
        local gh_owner
        gh_owner=$(gh api user --jq '.login' 2>/dev/null)
        if [[ -n "$gh_owner" ]]; then
            local -a gh_repos
            gh_repos=(${(f)"$(gh search code "$old_key" --owner "$gh_owner" --json repository --jq '.[].repository.name' 2>/dev/null | sort -u)"})
            local -a missing
            for r in "${gh_repos[@]}"; do
                # a repo counts as local if a dir with its name exists under ~ and is a git repo
                local found=0
                for d in "$root"/*(/N) "$root"/infra/*(/N) "$root"/work/*(/N); do
                    if [[ "${d:t}" == "$r" && -d "$d/.git" ]]; then found=1; break; fi
                done
                (( found == 0 )) && missing+=("$r")
            done
            if (( ${#missing} > 0 )); then
                echo "[sops-rotate] GitHub repos with the old key NOT found locally:"
                for r in "${missing[@]}"; do echo "  - $gh_owner/$r"; done
                echo "[sops-rotate] Clone them first, then re-run. Continuing with local files..."
            fi
        fi
    fi

    # --- scan: every file containing the old key ---
    echo ""
    echo "[sops-rotate] Scanning $root ..."
    local -a hits
    hits=(${(f)"$(rg -l --hidden "$old_key" "$root" 2>/dev/null \
        | grep -v '/\.git/' \
        | grep -v '/node_modules/' \
        | grep -v '/\.pi/agent/sessions/' \
        | grep -v '/\.local/share/Trash/' \
        | grep -v '/memledger/' \
        | grep -v '/\.config/sops/age/keys\.txt$' \
        | sort)"})
    if (( ${#hits} == 0 )); then
        echo "[sops-rotate] No files contain the old key."
        return 0
    fi
    echo "[sops-rotate] ${#hits} file(s) contain the old key"

    # --- git pull check per affected repo ---
    local -A repos
    for f in "${hits[@]}"; do
        local toplevel=
        toplevel=$(git -C "${f:h}" rev-parse --show-toplevel 2>/dev/null)
        [[ -n "$toplevel" ]] && repos[$toplevel]=1
    done
    for repo in ${(k)repos}; do
        if git -C "$repo" fetch --quiet 2>/dev/null && git -C "$repo" status -sb 2>/dev/null | grep -q 'behind'; then
            echo "[sops-rotate] $repo is BEHIND remote."
            if [[ "${SOPS_ROTATE_PULL:-0}" == "1" ]]; then
                git -C "$repo" pull --ff-only && echo "  pulled."
            elif [[ -t 0 ]]; then
                read -q "?  pull it now? [y/N] " && echo && git -C "$repo" pull --ff-only || echo "  skipped (uncommitted prose hits may be stale)"
            fi
        fi
    done

    # --- prose / .sops.yaml updates FIRST (rotation depends on .sops.yaml recipients) ---
    local files_rotated=0 files_prose=0 files_failed=0
    local -a prose_files sops_files
    for f in "${hits[@]}"; do
        if rg -q '^sops:' "$f" 2>/dev/null || rg -q '"sops":' "$f" 2>/dev/null; then
            sops_files+=("$f")
        else
            prose_files+=("$f")
        fi
    done

    for f in "${prose_files[@]}"; do
        if [[ "$dry" == "1" ]]; then
            echo "  DRY prose: $f"
        else
            sd "$old_key" "$new_key" "$f"
            echo "  prose: $f"
        fi
        ((files_prose++))
    done

    # --- rotate sops-encrypted files ---
    for f in "${sops_files[@]}"; do
        # ensure a .sops.yaml exists somewhere up the tree; else drop a temp one beside the file
            local dir="${f:h}" tempcfg=""
            local cfgdir="$dir"
            # absolutize: hits should be absolute, but guard against bare filenames (":h" -> "." loops forever)
            [[ "$cfgdir" != /* ]] && cfgdir="$PWD/$cfgdir"
            local prev=""
            while [[ "$cfgdir" != "/" && ! -f "$cfgdir/.sops.yaml" && "$cfgdir" != "$prev" ]]; do
                prev="$cfgdir"
                cfgdir="${cfgdir:h}"
            done
            if [[ ! -f "$cfgdir/.sops.yaml" ]]; then
                tempcfg="$dir/.sops.yaml"
                if [[ "$dry" != "1" ]]; then
                    printf 'creation_rules:\n  - age: %s\n' "$new_key" > "$tempcfg"
                fi
            fi
            if [[ "$dry" == "1" ]]; then
                echo "  DRY rotate: $f"
                ((files_rotated++))
            elif [[ "$full" == "1" ]]; then
                # full re-encrypt: decrypt with old key, encrypt fresh (new DEK)
                local ftype
                case "${f:e:l}" in
                    yaml|yml) ftype=yaml ;;
                    json) ftype=json ;;
                    env|conf|ini) ftype=dotenv ;;
                    *) ftype=binary ;;
                esac
                if sops -d "$f" 2>/dev/null | sops -e --age "$new_key" --input-type "$ftype" --output-type "$ftype" /dev/stdin > "$f.rot.tmp" 2>/dev/null; then
                    mv "$f.rot.tmp" "$f"
                    echo "  re-encrypted: $f"
                    ((files_rotated++))
                else
                    rm -f "$f.rot.tmp"
                    echo "  FAILED (re-encrypt): $f" >&2
                    ((files_failed++))
                fi
            else
                if ( cd "$dir" && echo y | sops updatekeys "$f" >/dev/null 2>&1 ); then
                    echo "  rotated: $f"
                    ((files_rotated++))
                else
                    echo "  FAILED: $f" >&2
                    ((files_failed++))
                fi
            fi
            [[ -n "$tempcfg" && "$dry" != "1" ]] && rm -f "$tempcfg"
    done

    echo ""
    echo "[sops-rotate] Done: $files_rotated rotated, $files_prose prose-updated, $files_failed failed."

    # --- git state report ---
    if (( files_rotated + files_prose > 0 )) && [[ "$dry" != "1" ]]; then
        echo ""
        echo "[sops-rotate] Repos with uncommitted rotation changes:"
        for repo in ${(k)repos}; do
            local dirty
            dirty=$(git -C "$repo" status --porcelain 2>/dev/null | head -5)
            [[ -n "$dirty" ]] && echo "  $repo"
        done
        echo "Commit each after verifying decryption works."
    fi
    (( files_failed > 0 )) && return 1
    return 0
}
# GPG git-signing cache (key B9D283E8AE4E56B4)
# ---------------------------------------------------------------------------
# gpg-agent caches the passphrase (7d sliding / 30d hard, see
# ~/.gnupg/gpg-agent.conf). Headless shells - tmux loops, pi -p subagents -
# have no TTY for pinentry, so a cold cache kills `git commit` with
# "gpg failed to sign the data". gpg_unlock warms the cache WITHOUT a TTY
# when bw serve is unlocked (item GPG_KEY_PASSPHRASE, passphrase in notes);
# otherwise it prompts once via pinentry.

_GPG_SIGNING_KEY="B9D283E8AE4E56B4"
# Keygrip is a public identifier (like the key fingerprint), NOT key material.
_GPG_SIGNING_KEYGRIP="17BB7DE98DD50550DE2641A694060FE9311D2BB4" # gitleaks:allow

# _gpg_cache_warm - returns 0 if the agent can sign with no passphrase prompt
_gpg_cache_warm() {
    echo cache-probe | gpg --batch --no-tty --pinentry-mode error \
        --clearsign -u "$_GPG_SIGNING_KEY" >/dev/null 2>&1
}

# gpg_seed_bw - silently warm the agent from Vaultwarden. NEVER prompts:
# no-op when warm, exit 1 when bw serve is unreachable/locked or the item
# is missing. Silent on the warm path so it is safe for hooks (preexec)
# and for bw_serve_start to call on every unlock.
gpg_seed_bw() {
    emulate -L zsh
    _gpg_cache_warm && return 0
    (( $+functions[_bw_serve_ok] )) && _bw_serve_ok || return 1
    local pw
    pw=$(_bw_api_get_note GPG_KEY_PASSPHRASE 2>/dev/null) || return 1
    [[ -n "$pw" ]] || return 1
    # Arch ships the helper off-PATH at /usr/lib/gnupg/.
    local preset="${commands[gpg-preset-passphrase]:-/usr/lib/gnupg/gpg-preset-passphrase}"
    print -rn -- "$pw" | "$preset" --preset "$_GPG_SIGNING_KEYGRIP" 2>/dev/null
    unset pw
    _gpg_cache_warm
}

# gpg_unlock - warm the gpg-agent cache for the git signing key.
# (1) no-op if already warm; (2) seed from Vaultwarden via bw serve
#     (headless-safe); (3) one pinentry prompt (interactive fallback).
gpg_unlock() {
    emulate -L zsh

    if _gpg_cache_warm; then
        echo "[gpg] cache already warm for $_GPG_SIGNING_KEY"
        return 0
    fi

    # Headless path: preset from Vaultwarden (bw serve must be unlocked).
    if gpg_seed_bw; then
        echo "[gpg] cache seeded from Vaultwarden (GPG_KEY_PASSPHRASE)"
        return 0
    fi
    if (( $+functions[_bw_serve_ok] )) && _bw_serve_ok; then
        print -u2 "[gpg] bw preset failed - wrong passphrase in GPG_KEY_PASSPHRASE,"
        print -u2 "      or a stale bw serve session (run bw_serve_start and retry)."
    fi

    # Interactive fallback: force exactly one pinentry prompt.
    if [[ -t 0 ]]; then
        export GPG_TTY="${GPG_TTY:-$(tty)}"
        echo "[gpg] prompting once via pinentry..."
        if echo cache-warm | gpg --clearsign -u "$_GPG_SIGNING_KEY" >/dev/null && _gpg_cache_warm; then
            echo "[gpg] cache warm until TTL expiry (7d idle / 30d max)"
            return 0
        fi
        print -u2 "[gpg] signing failed after prompt"
        return 1
    fi

    print -u2 "[gpg] no TTY and no bw seed available - cannot warm the cache here."
    print -u2 "      Run 'gpg_unlock' in an interactive shell, or store the passphrase as"
    print -u2 "      the notes of a Vaultwarden item named GPG_KEY_PASSPHRASE."
    return 1
}

# Auto-seed from bw before any signing git op, so pinentry never fires in an
# interactive shell while bw serve is unlocked. Silent + cheap: no-ops on the
# warm path, exits 1 without output when bw is unavailable (git then behaves
# as before - pinentry only when bw genuinely cannot seed).
if [[ -o interactive ]]; then
    autoload -Uz add-zsh-hook
    _gpg_preseed() {
        case "$1" in
            git\ commit*|git\ tag*|git\ merge*|git\ rebase*|git\ cherry-pick*|git\ revert*|git\ am*)
                gpg_seed_bw ;;
        esac
    }
    add-zsh-hook preexec _gpg_preseed
fi
