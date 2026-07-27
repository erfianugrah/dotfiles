# ---------------------------------------------------------------------------
# Astro project maintenance - find + upgrade every astro project under $HOME
# ---------------------------------------------------------------------------
# astro_upgrade_all          dry-run: table of project / runner / lockfile root
# astro_upgrade_all --run    execute `bunx|npx @astrojs/upgrade` in each root
# astro_upgrade_all -x foo   extra exclude (substring, repeatable)
# astro_upgrade_all --include revista   only dirs matching substring
#
# Project root = dir holding the package.json that declares the astro dep.
# Runner is picked from the NEAREST lockfile walking UP from that dir, so
# monorepo lockfiles at the workspace root resolve correctly.
# Note: @astrojs/upgrade is interactive - --run stops per project.

astro_upgrade_all() {
    local root="$HOME"
    local run=0
    local -a includes excludes
    # Default excludes: vendored/build/third-party checkouts. Edit freely.
    excludes=(
        "/node_modules/"
        "/.git/"
        "/worktrees/"
        "/.worktrees/"
        "/knotea-build/"   # build checkout of knotea
        "/opencode/"       # third-party clone
    )

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --run|-y)   run=1 ;;
            -x|--exclude) shift; excludes+=("${1:?missing exclude value}") ;;
            --include)    shift; includes+=("${1:?missing include value}") ;;
            -h|--help)
                echo "usage: astro_upgrade_all [--run] [-x exclude]... [--include match]..."
                echo "  (default)   dry-run: table of project / runner / lockfile root"
                echo "  --run|-y    execute bunx|npx @astrojs/upgrade per project (interactive!)"
                echo "  -x|--exclude s   skip dirs containing s (repeatable)"
                echo "  --include s      only dirs containing s (repeatable)"
                return 0 ;;
            *) echo "unknown arg: $1" >&2; return 1 ;;
        esac
        shift
    done

    local -a dirs runners lockdirs
    local pj dir e i runner lockdir matched cur lf

    while IFS= read -r pj; do
        matched=0
        for e in "${excludes[@]}"; do [[ "$pj" == *"$e"* ]] && { matched=1; break; }; done
        (( matched )) && continue

        dir="${pj:h}"
        if (( ${#includes[@]} > 0 )); then
            matched=1
            for i in "${includes[@]}"; do [[ "$dir" == *"$i"* ]] && { matched=0; break; }; done
            (( matched )) && continue
        fi

        jq -e '((.dependencies // {}) + (.devDependencies // {})) | has("astro")' \
            "$pj" >/dev/null 2>&1 || continue

        # lockfile walk-up -> runner
        runner="npx"; lockdir=""
        cur="$dir"
        while :; do
            for lf in bun.lockb bun.lock package-lock.json pnpm-lock.yaml yarn.lock; do
                if [[ -f "$cur/$lf" ]]; then
                    case "$lf" in
                        bun.lockb|bun.lock) runner="bunx" ;;
                        package-lock.json)  runner="npx" ;;
                        pnpm-lock.yaml)     runner="pnpm dlx" ;;
                        yarn.lock)          runner="yarn dlx" ;;
                    esac
                    lockdir="$cur"
                    break 2
                fi
            done
            [[ "$cur" == "$root" || "$cur" == "/" ]] && break
            cur="${cur:h}"
        done

        dirs+=("$dir"); runners+=("$runner"); lockdirs+=("$lockdir")
    done < <(rg -l --no-messages -g 'package.json' -g '!**/node_modules/**' \
               '"astro"\s*:' "$root" | sort)

    (( ${#dirs[@]} == 0 )) && { echo "no astro projects found"; return 0; }

    local rel lock
    local pass=0 fail=0
    printf '%-58s %-9s %s\n' "PROJECT" "RUNNER" "LOCKFILE ROOT"
    printf '%.0s-' {1..90}; echo
    for i in {1..${#dirs[@]}}; do
        rel="${dirs[$i]#$HOME/}"
        lock="${lockdirs[$i]#$HOME/}"
        printf '%-58s %-9s %s\n' "$rel" "${runners[$i]}" "${lock:-<none>}"
    done
    echo

    if (( ! run )); then
        echo "dry-run. re-run with --run to execute (${#dirs[@]} projects)."
        return 0
    fi

    for i in {1..${#dirs[@]}}; do
        rel="${dirs[$i]#$HOME/}"
        echo "==> [$i/${#dirs[@]}] $rel  (${runners[$i]} @astrojs/upgrade)"
        # intentional word-split: runner may be "pnpm dlx" etc.
        if (cd "${dirs[$i]}" && ${=runners[$i]} @astrojs/upgrade); then
            (( pass++ ))
        else
            (( fail++ )); echo "!! failed: $rel" >&2
        fi
        echo
    done
    echo "done: $pass ok, $fail failed out of ${#dirs[@]}"
    (( fail == 0 ))
}

alias astro-upgrade-all='astro_upgrade_all'
