# ---------------------------------------------------------------------------
# Terraform / OpenTofu — debug, outputs, permissions
# ---------------------------------------------------------------------------

# --- Debug toggles --------------------------------------------------------

tf_debug_on() {
    export TF_LOG=debug
    echo "Terraform debug logging enabled (TF_LOG=debug)"
}

tf_debug_off() {
    unset TF_LOG
    echo "Terraform debug logging disabled"
}

tf_debug_toggle() {
    if [[ -n "$TF_LOG" ]]; then
        tf_debug_off
    else
        tf_debug_on
    fi
}

# ---------------------------------------------------------------------------
# tf_out — Generic Terraform/OpenTofu output accessor
# ---------------------------------------------------------------------------
# Works with any tofu/terraform project. Detects the IaC tool automatically.
# Caches output JSON to a tmpfile keyed by $PWD; cleaned up on shell exit.
#
# Usage:
#   tf_out                              # grouped, color-coded summary
#   tf_out <name>                       # show a single output
#   tf_out <name> <key>                 # extract a key from an object output
#   tf_out <name> <key> <subkey>        # nested key extraction (dot-path also works)
#   tf_out -i  | --pick                 # fzf interactive picker
#   tf_out -l  | --list                 # list output names only
#   tf_out -s  | --sensitive            # show sensitivity & type for each output
#   tf_out -r  | --raw <name> [key]     # raw value for piping (no labels/colors)
#   tf_out -j  | --json [name]          # full JSON (all outputs or single output)
#   tf_out -f  | --search <pattern>     # grep output names by regex pattern
#   tf_out -k  | --keys <name>          # list keys of an object output
#   tf_out -y  | --type <type>          # filter outputs by value type
#   tf_out -d  | --diff <name>          # show output value diff vs last state backup
#   tf_out -e  | --env <name> [prefix]  # export object keys as env vars
#   tf_out -c  | --copy <name> [key]    # copy value to clipboard
#   tf_out -t  | --table <name>         # render object output as aligned table
#   tf_out -n  | --count                # count of outputs by type
#   tf_out -T  | --tokens               # show API token outputs only
#   tf_out -S  | --s3                   # show S3 credential outputs only
#   tf_out --flush                      # clear cached output for current project
# ---------------------------------------------------------------------------

# --- Helpers --------------------------------------------------------------

_tf_detect_cmd() {
  if [[ -d ".terraform" && -f ".terraform/terraform.tfstate" ]] && command -v terraform &>/dev/null; then
    echo "terraform"
  elif command -v tofu &>/dev/null; then
    echo "tofu"
  elif command -v terraform &>/dev/null; then
    echo "terraform"
  else
    echo "Error: Neither tofu nor terraform found in PATH" >&2
    return 1
  fi
}

# Resolve an output name: exact match first, then fuzzy
_tf_resolve_name() {
  local all_json="$1" name="$2"

  # Exact match
  if echo "$all_json" | jq -e --arg n "$name" '.[$n]' >/dev/null 2>&1; then
    echo "$name"
    return 0
  fi

  # Fuzzy match
  local matches
  matches=$(echo "$all_json" | jq -r 'keys[]' | grep -iE "$name")
  if [[ -z "$matches" ]]; then
    echo "Error: Output '$name' not found" >&2
    echo "Available: $(echo "$all_json" | jq -r 'keys[]' | tr '\n' ', ' | sed 's/,$//')" >&2
    return 1
  fi

  local match_count
  match_count=$(echo "$matches" | wc -l)
  if [[ $match_count -eq 1 ]]; then
    echo "$matches"
    return 0
  fi

  echo "Error: '$name' is ambiguous. Matches:" >&2
  echo "$matches" | sed 's/^/  /' >&2
  return 1
}

# Extract a value by dot-path or positional key args from JSON
_tf_extract_value() {
  local json="$1" output_name="$2"
  shift 2
  local keys=("$@")

  local base
  base=$(echo "$json" | jq --arg n "$output_name" '.[$n].value')

  if [[ ${#keys[@]} -eq 0 ]]; then
    echo "$base"
    return 0
  fi

  # Support dot-path in first key: "a.b.c" => ["a","b","c"]
  local path_expr=".value"
  for key in "${keys[@]}"; do
    local IFS='.'
    local parts=($key)
    for part in "${parts[@]}"; do
      path_expr="${path_expr}.${part}"
    done
  done

  local result
  result=$(echo "$json" | jq -r --arg n "$output_name" ".[\$n]${path_expr} // empty")

  if [[ -z "$result" ]]; then
    echo "Error: Path '${keys[*]}' not found in output '$output_name'" >&2
    local val_type
    val_type=$(echo "$json" | jq -r --arg n "$output_name" '.[$n].value | type')
    if [[ "$val_type" == "object" ]]; then
      echo "Available keys: $(echo "$json" | jq -r --arg n "$output_name" '.[$n].value | keys[]' | tr '\n' ', ' | sed 's/,$//')" >&2
    fi
    return 1
  fi

  echo "$result"
}

# Copy to clipboard (auto-detect wayland vs X11)
_tf_clipboard() {
  local val="$1"
  if command -v wl-copy &>/dev/null; then
    echo -n "$val" | wl-copy
    echo "Copied to clipboard (wl-copy)"
  elif command -v xclip &>/dev/null; then
    echo -n "$val" | xclip -selection clipboard
    echo "Copied to clipboard (xclip)"
  elif command -v pbcopy &>/dev/null; then
    echo -n "$val" | pbcopy
    echo "Copied to clipboard (pbcopy)"
  else
    echo "Error: No clipboard tool found (install wl-copy, xclip, or pbcopy)" >&2
    return 1
  fi
}

# --- Output cache ---------------------------------------------------------
# Caches `tofu output -json` to a tmpfile per project directory.
# TTL-based: re-fetches if the cache file is older than _TF_CACHE_TTL seconds.
# All cache files are cleaned up on shell exit via a trap.

_TF_CACHE_TTL="${_TF_CACHE_TTL:-300}"  # 5 minutes default
_TF_CACHE_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/tf_out_cache.$$"

# Track our cache dir for cleanup
_tf_cache_init() {
  if [[ ! -d "$_TF_CACHE_DIR" ]]; then
    mkdir -p "$_TF_CACHE_DIR"
    chmod 700 "$_TF_CACHE_DIR"
  fi
}

# Cleanup: remove our cache dir on shell exit
_tf_cache_cleanup() {
  [[ -d "$_TF_CACHE_DIR" ]] && rm -rf "$_TF_CACHE_DIR"
}

# Register cleanup via zshexit hook (additive — won't clobber existing traps)
if [[ -z "$_TF_CACHE_TRAP_SET" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook zshexit _tf_cache_cleanup
  # Also handle TERM/INT for non-clean exits
  trap '_tf_cache_cleanup' HUP TERM INT
  _TF_CACHE_TRAP_SET=1
fi

# Return cached JSON or fetch fresh. Sets _tf_cached_json variable.
_tf_cache_get() {
  local tf_cmd="$1"
  _tf_cache_init

  # Cache key: hash of the absolute project path
  local project_dir="$PWD"
  local cache_key
  cache_key=$(printf '%s' "$project_dir" | md5sum | cut -d' ' -f1)
  local cache_file="${_TF_CACHE_DIR}/${cache_key}.json"

  # Check if cache is fresh
  if [[ -f "$cache_file" ]]; then
    local file_age=$(( $(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null) ))
    if (( file_age < _TF_CACHE_TTL )); then
      _tf_cached_json=$(<"$cache_file")
      return 0
    fi
  fi

  # Fetch fresh
  _tf_cached_json=$($tf_cmd output -json 2>/dev/null)
  if [[ $? -ne 0 || -z "$_tf_cached_json" || "$_tf_cached_json" == "{}" ]]; then
    return 1
  fi

  # Write cache (mode 600 — sensitive data; set before write to avoid TOCTOU)
  install -m 600 /dev/null "$cache_file"
  echo "$_tf_cached_json" > "$cache_file"
  return 0
}

# Flush cache for the current project directory
_tf_cache_flush() {
  local cache_key
  cache_key=$(printf '%s' "$PWD" | md5sum | cut -d' ' -f1)
  local cache_file="${_TF_CACHE_DIR}/${cache_key}.json"
  if [[ -f "$cache_file" ]]; then
    rm -f "$cache_file"
    echo "Cache cleared for $(basename "$PWD")"
  else
    echo "No cache to clear for $(basename "$PWD")"
  fi
}

# --- Main function --------------------------------------------------------

tf_out() {
  local tf_cmd
  tf_cmd=$(_tf_detect_cmd) || return 1

  # Handle --flush before fetching outputs
  if [[ "${1:-}" == "--flush" || "${1:-}" == "-F" ]]; then
    _tf_cache_flush
    return 0
  fi

  # Fetch outputs (cached)
  local _tf_cached_json=""
  _tf_cache_get "$tf_cmd"
  local all_json="$_tf_cached_json"

  if [[ -z "$all_json" || "$all_json" == "{}" ]]; then
    if [[ ! -d ".terraform" ]]; then
      echo "Error: Not in a terraform/tofu project directory (no .terraform/)" >&2
      return 1
    fi
    echo "No outputs found. Run '$tf_cmd apply' first." >&2
    return 1
  fi

  local output_count
  output_count=$(echo "$all_json" | jq 'length')

  # Colors
  local c_reset='\033[0m' c_bold='\033[1m' c_dim='\033[2m'
  local c_red='\033[31m' c_green='\033[32m' c_yellow='\033[33m'
  local c_blue='\033[34m' c_magenta='\033[35m' c_cyan='\033[36m'

  case "${1:-}" in
    --help|-h)
      cat <<HELP
Usage: tf_out [command] [args...]

Browse & extract:
  tf_out                              Grouped, color-coded summary
  tf_out <name>                       Show single output with metadata
  tf_out <name> <key>                 Extract key from object output
  tf_out <name> <key.subkey>          Dot-path nested extraction
  tf_out <name> <key> <subkey>        Multi-arg nested extraction

Interactive:
  tf_out -i  | --pick                 fzf interactive picker

Listing & filtering:
  tf_out -l  | --list                 Output names only
  tf_out -s  | --sensitive            Sensitivity & type matrix
  tf_out -f  | --search <pattern>     Regex search output names
  tf_out -y  | --type <type>          Filter by value type (string/object/array/number/boolean)
  tf_out -n  | --count                Count outputs by type
  tf_out -T  | --tokens               Show API token outputs only
  tf_out -S  | --s3                   Show S3 credential outputs only

Data formats:
  tf_out -j  | --json [name]          Full JSON (all or single output)
  tf_out -r  | --raw <name> [key]     Raw value for piping (no labels)
  tf_out -t  | --table <name>         Render object as aligned key=value table
  tf_out -k  | --keys <name>          List keys of an object output

Actions:
  tf_out -c  | --copy <name> [key]    Copy value to clipboard
  tf_out -e  | --env <name> [PREFIX]  Export object keys as PREFIX_KEY=value env vars
  tf_out -d  | --diff <name>          Diff output vs last state backup

Cache:
  tf_out -F  | --flush                Clear cached output for current project

Fuzzy matching: partial names auto-resolve when unambiguous.
Cache TTL: ${_TF_CACHE_TTL}s (set _TF_CACHE_TTL to override). Auto-cleaned on shell exit.
HELP
      echo ""
      echo "Using: $tf_cmd ($output_count outputs in $(basename "$PWD"))"
      return 0
      ;;

    --list|-l)
      echo "$all_json" | jq -r 'keys[]' | sort
      return 0
      ;;

    --json|-j)
      if [[ -n "${2:-}" ]]; then
        local name
        name=$(_tf_resolve_name "$all_json" "$2") || return 1
        echo "$all_json" | jq --arg n "$name" '.[$n]'
      else
        echo "$all_json" | jq '.'
      fi
      return 0
      ;;

    --sensitive|-s)
      {
        printf "%s\t%s\t%s\n" "OUTPUT" "SENSITIVE" "TYPE"
        printf "%s\t%s\t%s\n" "------" "---------" "----"
        echo "$all_json" | jq -r '
          to_entries | sort_by(.key)[] |
          "\(.key)\t\(if .value.sensitive then "yes" else "no" end)\t\(.value.value | type)"
        '
      } | column -t -s $'\t'
      return 0
      ;;

    --search|-f)
      local pattern="${2:?Error: --search requires a pattern}"
      local results
      results=$(echo "$all_json" | jq -r --arg p "$pattern" '
        to_entries[]
        | select(.key | test($p; "i"))
        | "\(.key)\t\(.value.value | type)\t\(if .value.sensitive then " [sensitive]" else "" end)"
      ' | sort)
      if [[ -z "$results" ]]; then
        echo "No outputs matching '$pattern'" >&2
        return 1
      fi
      local max_w
      max_w=$(echo "$results" | awk -F'\t' '{l=length($1); if(l>m) m=l} END{print m+2}')
      echo "$results" | while IFS=$'\t' read -r k typ sens; do
        printf "  %-${max_w}s %s%s\n" "$k" "$typ" "$sens"
      done
      return 0
      ;;

    --type|-y)
      local target_type="${2:?Error: --type requires a type (string/object/array/number/boolean)}"
      echo "$all_json" | jq -r --arg t "$target_type" 'to_entries[] | select(.value.value | type == $t) | .key' | sort
      return 0
      ;;

    --count|-n)
      echo "Outputs by type ($output_count total):"
      echo "$all_json" | jq -r '[to_entries[].value.value | type] | group_by(.) | map({type: .[0], count: length}) | sort_by(.type)[] | "  \(.type): \(.count)"'
      local sens_count
      sens_count=$(echo "$all_json" | jq '[to_entries[].value | select(.sensitive)] | length')
      echo "  ---"
      echo "  sensitive: $sens_count"
      echo "  public: $((output_count - sens_count))"
      return 0
      ;;

    --keys|-k)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --keys requires an output name}") || return 1
      local val_type
      val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
      if [[ "$val_type" != "object" ]]; then
        echo "Error: Output '$name' is a $val_type, not an object" >&2
        return 1
      fi
      echo "$all_json" | jq -r --arg n "$name" '.[$n].value | keys[]'
      return 0
      ;;

    --table|-t)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --table requires an output name}") || return 1
      local val_type
      val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
      if [[ "$val_type" != "object" ]]; then
        echo "Error: Output '$name' is a $val_type, not an object" >&2
        return 1
      fi
      echo "$name:"
      echo "$all_json" | jq -r --arg n "$name" '
        .[$n].value | to_entries[] |
        "\(.key)\t\(if (.value | type) == "object" or (.value | type) == "array" then (.value | tojson) else (.value | tostring) end)"
      ' | while IFS=$'\t' read -r k v; do
        printf "  %-30s %s\n" "$k" "$v"
      done
      return 0
      ;;

    --raw|-r)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --raw requires an output name}") || return 1
      shift 2
      if [[ $# -eq 0 ]]; then
        local val_type
        val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
        if [[ "$val_type" == "object" || "$val_type" == "array" ]]; then
          echo "$all_json" | jq --arg n "$name" '.[$n].value'
        else
          echo "$all_json" | jq -r --arg n "$name" '.[$n].value'
        fi
      else
        _tf_extract_value "$all_json" "$name" "$@"
      fi
      return $?
      ;;

    --copy|-c)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --copy requires an output name}") || return 1
      shift 2
      local val
      val=$(_tf_extract_value "$all_json" "$name" "$@") || return 1
      if [[ "$val" == "{"* || "$val" == "["* ]]; then
        val=$(echo "$val" | jq -c '.')
      fi
      _tf_clipboard "$val"
      return 0
      ;;

    --env|-e)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --env requires an output name}") || return 1
      local prefix="${3:-}"
      local val_type
      val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')
      if [[ "$val_type" != "object" ]]; then
        local env_var_name="${prefix:-$(echo "$name" | tr '[:lower:]-' '[:upper:]_')}"
        local env_val
        env_val=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value')
        export "$env_var_name=$env_val"
        echo "export $env_var_name=***"
        return 0
      fi
      local env_lines
      if [[ -n "$prefix" ]]; then
        env_lines=$(echo "$all_json" | jq -r --arg n "$name" --arg p "$prefix" '
          .[$n].value | to_entries[] |
          "\($p)_\(.key | gsub("-";"_") | ascii_upcase)=\(.value | tostring)"
        ')
      else
        env_lines=$(echo "$all_json" | jq -r --arg n "$name" '
          .[$n].value | to_entries[] |
          "\(.key | gsub("-";"_") | ascii_upcase)=\(.value | tostring)"
        ')
      fi
      # Use array + for loop instead of pipe|while to avoid subshell (exports would be lost)
      local -a lines=("${(@f)env_lines}")
      local line
      for line in "${lines[@]}"; do
        local env_k="${line%%=*}"
        local env_v="${line#*=}"
        export "$env_k=$env_v"
        echo "export $env_k=***"
      done
      return 0
      ;;

    --diff|-d)
      local name
      name=$(_tf_resolve_name "$all_json" "${2:?Error: --diff requires an output name}") || return 1
      local backup="terraform.tfstate.backup"
      if [[ ! -f "$backup" ]]; then
        echo "Error: No state backup found ($backup)" >&2
        return 1
      fi
      local old_val new_val
      old_val=$($tf_cmd show -json "$backup" 2>/dev/null | jq --arg n "$name" '.values.outputs[$n].value // "not present"' 2>/dev/null)
      new_val=$(echo "$all_json" | jq --arg n "$name" '.[$n].value')
      if [[ "$old_val" == "$new_val" ]]; then
        echo "No change for '$name'"
      else
        echo "--- backup"
        echo "+++ current"
        diff --color=auto <(echo "$old_val" | jq -S '.') <(echo "$new_val" | jq -S '.') 2>/dev/null || {
          echo "Old: $old_val"
          echo "New: $new_val"
        }
      fi
      return 0
      ;;

    --tokens|-T)
      _tf_grouped_list "$all_json" "token" "$c_yellow" "$c_reset" "$c_dim" "$c_bold"
      return 0
      ;;

    --s3|-S)
      _tf_grouped_list "$all_json" "s3" "$c_magenta" "$c_reset" "$c_dim" "$c_bold"
      return 0
      ;;

    --pick|-i)
      if ! command -v fzf &>/dev/null; then
        echo "Error: fzf is required for interactive mode. Install with: brew install fzf" >&2
        return 1
      fi
      # Write JSON to a tmpfile so fzf preview can read it (avoids quoting hell)
      local fzf_tmp
      fzf_tmp=$(mktemp)
      chmod 600 "$fzf_tmp"
      echo "$all_json" > "$fzf_tmp"
      local selected
      selected=$(echo "$all_json" | jq -r '
        to_entries | sort_by(.key)[] |
        "\(.key)\t\(.value.value | type)\t\(if .value.sensitive then "sensitive" else "public" end)"
      ' | column -t -s $'\t' | fzf \
          --header="Select output (enter=view, ctrl-y=copy, ctrl-c=cancel)" \
          --preview-window=right:50%:wrap \
          --preview="jq -C --arg n {1} '.[\$n]' < '$fzf_tmp'" \
          --bind="ctrl-y:execute-silent(jq -r --arg n {1} '.[\$n].value | if type == \"object\" or type == \"array\" then tojson else . end' < '$fzf_tmp' | ${${commands[wl-copy]:-${commands[xclip]:+xclip -selection clipboard}}:-pbcopy} 2>/dev/null)" \
          --ansi)
      rm -f "$fzf_tmp"
      if [[ -n "$selected" ]]; then
        local picked_name
        picked_name=$(echo "$selected" | awk '{print $1}')
        tf_out "$picked_name"
      fi
      return 0
      ;;

    --*)
      echo "Error: Unknown flag '$1'. Try 'tf_out --help'" >&2
      return 1
      ;;
  esac

  # --- Single output by name (with optional key extraction) ---
  if [[ -n "${1:-}" ]]; then
    local name
    name=$(_tf_resolve_name "$all_json" "$1") || return 1
    shift

    local sensitive val_type
    sensitive=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].sensitive')
    val_type=$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | type')

    # If extra args, treat as key extraction
    if [[ $# -gt 0 ]]; then
      if [[ "$val_type" != "object" ]]; then
        echo "Error: Output '$name' is a $val_type, cannot extract key '$1'" >&2
        return 1
      fi
      _tf_extract_value "$all_json" "$name" "$@"
      return $?
    fi

    # Display full output with metadata
    printf "${c_bold}Output:${c_reset} %s\n" "$name"
    printf "${c_dim}Type:${c_reset}   %s\n" "$val_type"
    [[ "$sensitive" == "true" ]] && printf "${c_red}Sensitive: yes${c_reset}\n"

    case "$val_type" in
      object)
        local key_count
        key_count=$(echo "$all_json" | jq --arg n "$name" '.[$n].value | keys | length')
        printf "${c_dim}Keys (%s):${c_reset} %s\n" "$key_count" "$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value | keys | join(", ")')"
        echo ""
        echo "$all_json" | jq -C --arg n "$name" '.[$n].value'
        ;;
      array)
        local arr_len
        arr_len=$(echo "$all_json" | jq --arg n "$name" '.[$n].value | length')
        printf "${c_dim}Length:${c_reset} %s\n" "$arr_len"
        echo ""
        echo "$all_json" | jq -C --arg n "$name" '.[$n].value'
        ;;
      *)
        printf "${c_green}Value:${c_reset} %s\n" "$(echo "$all_json" | jq -r --arg n "$name" '.[$n].value')"
        ;;
    esac
    return 0
  fi

  # --- No args: grouped, color-coded summary ---
  printf "${c_bold}Outputs${c_reset} ${c_dim}(%s total, via %s, project: %s)${c_reset}\n\n" \
    "$output_count" "$tf_cmd" "$(basename "$PWD")"

  # Categorize outputs via jq (single pass), then render each group
  local categorized
  categorized=$(echo "$all_json" | jq -r '
    to_entries | sort_by(.key)[] |
    .key as $name | .value.sensitive as $sens | (.value.value | type) as $typ |
    (if ($name | test("_s3_credentials$"; "i")) then "s3"
     elif ($name | test("^cloudflare_api_token_|_token$|_api_key$"; "i")) then "token"
     elif $typ == "object" then "object"
     elif $typ == "array" then "array"
     else "scalar"
     end) as $cat |
    {cat: $cat, name: $name, sensitive: $sens, type: $typ, value: .value.value} |
    "\(.cat)\t\(.name)\t\(.sensitive)\t\(.type)\t\(
      if .cat == "s3" then
        (.value | keys | join(", "))
      elif .cat == "token" then
        (.name | gsub("^cloudflare_api_token_"; "") | gsub("_"; " "))
      elif .type == "object" then
        (.value | keys | join(", "))
      elif .type == "array" then
        "\(.value | length) items"
      else
        (.value | tostring | if length > 50 then .[:47] + "..." else . end)
      end
    )"
  ')

  local cat_labels=("token:API Tokens" "s3:S3 Credentials" "object:Objects" "array:Arrays" "scalar:Values")
  local cat_colors=("token:$c_yellow" "s3:$c_magenta" "object:$c_cyan" "array:$c_blue" "scalar:$c_green")

  # Declare loop variables once outside to avoid zsh's typeset re-declaration printing
  local cat_entries cat_label cat_color entry_count

  for cat_id in token s3 object array scalar; do
    cat_entries=$(echo "$categorized" | awk -F'\t' -v c="$cat_id" '$1 == c')
    [[ -z "$cat_entries" ]] && continue

    # Look up label and color
    for pair in "${cat_labels[@]}"; do
      if [[ "${pair%%:*}" == "$cat_id" ]]; then cat_label="${pair#*:}"; break; fi
    done
    for pair in "${cat_colors[@]}"; do
      if [[ "${pair%%:*}" == "$cat_id" ]]; then cat_color="${pair#*:}"; break; fi
    done

    entry_count=$(echo "$cat_entries" | wc -l)
    printf "${c_bold}${cat_color}%s${c_reset} ${c_dim}(%s)${c_reset}\n" "$cat_label" "$entry_count"

    # Compute max name width for this category (+ 2 for padding)
    local max_w
    max_w=$(echo "$cat_entries" | awk -F'\t' '{l=length($2); if(l>m) m=l} END{print m+2}')

    echo "$cat_entries" | while IFS=$'\t' read -r _cat _name _sens _typ _desc; do
      local sens_marker=""
      [[ "$_sens" == "true" ]] && sens_marker="${c_red}*${c_reset}"

      printf "  ${cat_color}%-${max_w}s${c_reset} ${c_dim}%s${c_reset}%b\n" \
        "$_name" "$_desc" "$sens_marker"
    done
    echo ""
  done

  printf "${c_dim}* = sensitive  |  tf_out -h for help  |  tf_out -i for interactive${c_reset}\n"
}

# Helper: list outputs filtered by category (for --tokens, --s3)
_tf_grouped_list() {
  local all_json="$1" filter="$2" color="$3" c_reset="$4" c_dim="$5" c_bold="$6"

  local pattern
  case "$filter" in
    token) pattern='test("^cloudflare_api_token_|_token$|_api_key$"; "i") and (test("_s3_credentials$"; "i") | not)' ;;
    s3)    pattern='test("_s3_credentials$"; "i")' ;;
  esac

  local entries
  entries=$(echo "$all_json" | jq -r --arg p "$pattern" "
    to_entries | sort_by(.key)[]
    | select(.key | $pattern)
    | \"\(.key)\t\(if .value.sensitive then \"sensitive\" else \"public\" end)\t\(.value.value | type)\t\(
        if (.value.value | type) == \"object\" then (.value.value | keys | join(\", \"))
        elif .value.sensitive then \"[sensitive \(.value.value | type)]\"
        else (.value.value | tostring | if length > 50 then .[:47] + \"...\" else . end)
        end)\"
  ")

  if [[ -z "$entries" ]]; then
    echo "No ${filter} outputs found." >&2
    return 1
  fi

  local entry_count
  entry_count=$(echo "$entries" | wc -l)
  printf "${c_bold}${color}%s outputs${c_reset} ${c_dim}(%s)${c_reset}\n\n" "${(C)filter}" "$entry_count"

  # Compute max name width dynamically (+ 2 for padding)
  local max_w
  max_w=$(echo "$entries" | awk -F'\t' '{l=length($1); if(l>m) m=l} END{print m+2}')

  echo "$entries" | while IFS=$'\t' read -r _name _sens _typ _desc; do
    local sens_marker=""
    [[ "$_sens" == "sensitive" ]] && sens_marker=" ${c_dim}[sensitive]${c_reset}"
    printf "  ${color}%-${max_w}s${c_reset} ${c_dim}%s${c_reset}%b\n" "$_name" "$_desc" "$sens_marker"
  done
}

# ---------------------------------------------------------------------------
# cf_permissions — browse Cloudflare permission groups via TF console
# ---------------------------------------------------------------------------

cf_permissions() {
  local input_command=$1
  local category=$2
  local command=""
  
  case "$input_command" in
    terraform|tf)
      command="terraform"
      ;;
    tofu|t)
      command="tofu"
      ;;
    *)
      echo "Usage: cf_permissions [terraform|tf|tofu|t] [account|zone|user|r2|roles|all]"
      return 1
      ;;
  esac
  
  if ! command -v $command &> /dev/null; then
    echo "Error: Command '$command' not found. Please ensure it is installed and in your PATH."
    return 1
  fi
  
  if [[ "$category" != "account" && "$category" != "zone" && "$category" != "user" && "$category" != "r2" && "$category" != "roles" && "$category" != "all" ]]; then
    echo "Usage: cf_permissions [terraform|tf|tofu|t] [account|zone|user|r2|roles|all]"
    return 1
  fi
  
  if [[ "$category" == "all" ]]; then
    echo "=== ACCOUNT PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.account)"
    echo "\n=== ZONE PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.zone)"
    echo "\n=== USER PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.user)"
    echo "\n=== R2 PERMISSIONS ==="
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.r2)"
    echo "\n=== ACCOUNT ROLES ==="
    $command console <<< "data.cloudflare_account_roles.account_roles.roles"
  elif [[ "$category" == "roles" ]]; then
    $command console <<< "data.cloudflare_account_roles.account_roles.roles"
  else
    $command console <<< "keys(data.cloudflare_api_token_permission_groups.all.$category)"
  fi
}

# ---------------------------------------------------------------------------
# Zsh completions for tf_out
# ---------------------------------------------------------------------------

# Helper: get cached or live output JSON for completions
_tf_out_get_json() {
  local tf_cmd cache_dir cache_key cache_file

  if command -v tofu &>/dev/null; then
    tf_cmd="tofu"
  elif command -v terraform &>/dev/null; then
    tf_cmd="terraform"
  else
    return 1
  fi

  cache_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/tf_out_cache.$$"
  cache_key=$(printf '%s' "$PWD" | md5sum | cut -d' ' -f1)
  cache_file="${cache_dir}/${cache_key}.json"

  if [[ -f "$cache_file" ]]; then
    cat "$cache_file"
  else
    timeout 2 $tf_cmd output -json 2>/dev/null
  fi
}

# Populate output names from cache/live into the reply array
_tf_out_complete_outputs() {
  local json_data
  json_data=$(_tf_out_get_json)
  if [[ -n "$json_data" && "$json_data" != "{}" ]]; then
    local -a names descs
    local name typ sens
    # Color codes for type badges
    local c_str=$'\033[33m' c_obj=$'\033[36m' c_arr=$'\033[34m'
    local c_num=$'\033[32m' c_bool=$'\033[35m'
    local c_red=$'\033[31m' c_dim=$'\033[2m' c_reset=$'\033[0m'

    while IFS=$'\t' read -r name typ sens; do
      names+=("$name")
      local tc
      case "$typ" in
        string)  tc="$c_str" ;;
        object)  tc="$c_obj" ;;
        array)   tc="$c_arr" ;;
        number)  tc="$c_num" ;;
        boolean) tc="$c_bool" ;;
        *)       tc="$c_dim" ;;
      esac
      local badge="${tc}${typ}${c_reset}"
      [[ "$sens" == "true" ]] && badge+="  ${c_red}sensitive${c_reset}"
      descs+=("$name:${badge}")
    done < <(echo "$json_data" | jq -r 'to_entries | sort_by(.key)[] | "\(.key)\t\(.value.value | type)\t\(.value.sensitive)"')
    (( ${#names} )) && compadd -d descs -l -- "${names[@]}"
  fi
}

_tf_out() {
  # Position 2 = first argument (words[1] is "tf_out")
  if (( CURRENT == 2 )); then
    local curword="${words[CURRENT]}"

    if [[ "$curword" == -* ]]; then
      # Only show flags (long form with descriptions, no short duplicates)
      local -a flag_names flag_descs
      local c_flag=$'\033[33m' c_short=$'\033[2;36m' c_desc=$'\033[0m' c_r=$'\033[0m'
      flag_names=(--help --list --sensitive --raw --json --search --keys --type --diff --env --copy --table --count --tokens --s3 --flush --pick)
      flag_descs=(
        "--help:${c_desc}show help ${c_short}-h${c_r}"
        "--list:${c_desc}list output names ${c_short}-l${c_r}"
        "--sensitive:${c_desc}sensitivity matrix ${c_short}-s${c_r}"
        "--raw:${c_desc}raw value, pipe-friendly ${c_short}-r${c_r}"
        "--json:${c_desc}full JSON output ${c_short}-j${c_r}"
        "--search:${c_desc}regex search names ${c_short}-f${c_r}"
        "--keys:${c_desc}list object keys ${c_short}-k${c_r}"
        "--type:${c_desc}filter by type ${c_short}-y${c_r}"
        "--diff:${c_desc}diff vs backup state ${c_short}-d${c_r}"
        "--env:${c_desc}export as env vars ${c_short}-e${c_r}"
        "--copy:${c_desc}copy to clipboard ${c_short}-c${c_r}"
        "--table:${c_desc}object as table ${c_short}-t${c_r}"
        "--count:${c_desc}count by type ${c_short}-n${c_r}"
        "--tokens:${c_desc}API token outputs ${c_short}-T${c_r}"
        "--s3:${c_desc}S3 credential outputs ${c_short}-S${c_r}"
        "--flush:${c_desc}clear cache ${c_short}-F${c_r}"
        "--pick:${c_desc}interactive fzf picker ${c_short}-i${c_r}"
      )
      compadd -d flag_descs -l -- "${flag_names[@]}"
    else
      # Only show output names (no flags cluttering the list)
      _tf_out_complete_outputs
    fi
    return
  fi

  # Position 3 = second argument
  if (( CURRENT == 3 )); then
    local first_arg="${words[2]}"

    case "$first_arg" in
      --type|-y)
        compadd -- string object array number boolean
        ;;
      --help|-h|--list|-l|--sensitive|-s|--json|-j|--count|-n|--tokens|-T|--s3|-S|--flush|-F|--pick|-i)
        # No second arg needed
        ;;
      --search|-f)
        # Free-text pattern, no completion
        ;;
      --raw|-r|--keys|-k|--diff|-d|--env|-e|--copy|-c|--table|-t)
        _tf_out_complete_outputs
        ;;
      *)
        # First arg is an output name — complete its object keys
        local json_data
        json_data=$(_tf_out_get_json)
        if [[ -n "$json_data" && "$json_data" != "{}" ]]; then
          local val_type
          val_type=$(echo "$json_data" | jq -r --arg n "$first_arg" '.[$n].value | type' 2>/dev/null)
          if [[ "$val_type" == "object" ]]; then
            local -a keys
            keys=("${(@f)$(echo "$json_data" | jq -r --arg n "$first_arg" '.[$n].value | keys[]' 2>/dev/null)}")
            (( ${#keys} )) && compadd -- "${keys[@]}"
          fi
        fi
        ;;
    esac
    return
  fi
}

compdef _tf_out tf_out
