# ---------------------------------------------------------------------------
# functions.zsh — modular loader
# ---------------------------------------------------------------------------
# Sources all modules from functions.d/ in defined order.
# Each module is self-contained and can be loaded independently.
# ---------------------------------------------------------------------------

_FUNCTIONS_D="${0:A:h}/functions.d"

if [[ ! -d "$_FUNCTIONS_D" ]]; then
  echo "Warning: functions.d/ directory not found at $_FUNCTIONS_D" >&2
  return 1
fi

# Load order matters: crypto has no deps, bitwarden depends on nothing shell-wise,
# terraform and system are independent, misc is lightweight utilities.
_fn_modules=(system crypto bitwarden terraform misc)

for _fn_mod in "${_fn_modules[@]}"; do
  if [[ -f "${_FUNCTIONS_D}/${_fn_mod}.zsh" ]]; then
    source "${_FUNCTIONS_D}/${_fn_mod}.zsh"
  else
    echo "Warning: Module ${_fn_mod}.zsh not found in functions.d/" >&2
  fi
done

unset _fn_mod _fn_modules _FUNCTIONS_D
