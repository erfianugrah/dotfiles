#!/usr/bin/env zsh
# perf.zsh - repeatable, cross-platform (Linux/macOS/WSL) perf benchmark for
# this dotfiles setup. Reports metrics + PASS/WARN/FAIL against perception
# thresholds (romkatv/zsh-bench "how fast is fast" values).
#
# Usage:   zsh tests/perf.zsh
# Env:     PERF_ITERS (default 10)   - reps for wall-clock metrics
#          ZB_ITERS   (default 4)    - zsh-bench iterations
#          NO_ZSH_BENCH=1            - skip the zsh-bench section
#
# No GNU-isms: timing via zmodload zsh/datetime (EPOCHREALTIME), stats via
# zsh math. Optional tools (tmux, pi, git) are probed, not assumed.

emulate -L zsh -o no_aliases
zmodload zsh/datetime || { print "zsh/datetime required"; exit 1; }

typeset -gi PERF_ITERS=${PERF_ITERS:-10}
typeset -gi ZB_ITERS=${ZB_ITERS:-4}

typeset -gi _P_PASS=0 _P_WARN=0 _P_FAIL=0

# _p_metric <name> <value-ms> <warn-threshold> <fail-threshold>
_p_metric() {
  local name=$1 val=$2 warn=$3 fail=$4 verdict
  if (( val > fail )); then verdict=FAIL; (( ++_P_FAIL ))
  elif (( val > warn )); then verdict=WARN; (( ++_P_WARN ))
  else verdict=PASS; (( ++_P_PASS )); fi
  printf "  [%-4s] %-34s %8.1f ms  (warn>%.0f fail>%.0f)\n" \
    $verdict $name $val $warn $fail
}

# _p_time <reps> <cmd...> -> mean wall ms per run in $REPLY
_p_time() {
  local -i reps=$1; shift
  local -F t0=$EPOCHREALTIME
  local -i i
  for (( i = 0; i < reps; ++i )); do "$@" >/dev/null 2>&1; done
  REPLY=$(( (EPOCHREALTIME - t0) * 1000 / reps ))
}

_p_section() { print -- "\n-- $1 --"; }

# ---------------------------------------------------------------------------
_p_section "shell startup (zsh -i -c exit, mean of $PERF_ITERS)"
_p_time $PERF_ITERS zsh -i -c exit
_p_metric "interactive startup" $REPLY 150 400

# command-lookup miss cost: walks every PATH dir; on WSL with DrvFs mounts
# this is the single biggest shell tax. Threshold: a miss should be <1ms.
_p_section "PATH lookup miss (command -v on nonexistent cmd)"
_p_time 50 command -v definitely-not-a-real-cmd-perf-probe
_p_metric "PATH miss cost" $REPLY 1 10
typeset -a _linux_only=(${path:#/mnt/*})
if (( ${#_linux_only} != ${#path} )); then
  local -i removed=$(( ${#path} - ${#_linux_only} ))
  local -F with_mnt=$REPLY
  path=(${path:#/mnt/*})
  _p_time 50 command -v definitely-not-a-real-cmd-perf-probe
  printf "  [INFO] %d /mnt/* PATH entries: miss %.1f ms with, %.1f ms without\n" \
    $removed $with_mnt $REPLY
fi

# ---------------------------------------------------------------------------
if (( $+commands[tmux] )) && tmux ls >/dev/null 2>&1; then
  _p_section "tmux (server already running)"
  local -F t0=$EPOCHREALTIME
  tmux new-session -d -s perf-probe-$$ 'exit' 2>/dev/null
  _p_metric "new-session API call" $(( (EPOCHREALTIME - t0) * 1000 )) 20 100
  local -i n=3 i
  local -F total=0
  for (( i = 0; i < n; ++i )); do
    t0=$EPOCHREALTIME
    tmux new-session -d -s perf-probe-$$-$i 'zsh -ic exit' 2>/dev/null
    while tmux has-session -t perf-probe-$$-$i 2>/dev/null; do sleep 0.02; done
    (( total += EPOCHREALTIME - t0 ))
  done
  tmux kill-session -t perf-probe-$$ 2>/dev/null
  _p_metric "pane shell ready (mean of $n)" $(( total * 1000 / n )) 200 600
else
  print "  [SKIP] tmux not running"
fi

# ---------------------------------------------------------------------------
if [[ -z ${NO_ZSH_BENCH:-} ]]; then
  _p_section "zsh-bench (user-visible latency, virtual TTY)"
  local _zb=${ZSH_BENCH_DIR:-/tmp/zsh-bench}
  if [[ ! -x $_zb/zsh-bench ]] && (( $+commands[git] )); then
    print "  cloning romkatv/zsh-bench -> $_zb"
    git clone -q --depth 1 https://github.com/romkatv/zsh-bench $_zb
  fi
  if [[ -x $_zb/zsh-bench ]]; then
    local _out=$("$_zb/zsh-bench" --iters $ZB_ITERS 2>/dev/null)
    local k v
    for k in first_prompt_lag_ms first_command_lag_ms command_lag_ms input_lag_ms; do
      v=${${(M)${(f)_out}:#$k=*}#*=}
      [[ -n $v ]] || continue
      case $k in
        first_prompt_lag_ms)  _p_metric "first prompt lag"  $v 25 100 ;;
        first_command_lag_ms) _p_metric "first command lag" $v 100 400 ;;
        command_lag_ms)       _p_metric "command lag"       $v 10 50 ;;
        input_lag_ms)         _p_metric "input lag"         $v 5 20 ;;
      esac
    done
  else
    print "  [SKIP] zsh-bench unavailable"
  fi
fi

# ---------------------------------------------------------------------------
if (( $+commands[pi] )); then
  _p_section "pi startup (fail-fast bogus model, mean of 3)"
  local -F ptotal=0 pt0
  local -i pi_i
  for (( pi_i = 0; pi_i < 3; ++pi_i )); do
    pt0=$EPOCHREALTIME
    pi -p --no-session --model nonexistent/perf-probe hi >/dev/null 2>&1
    (( ptotal += EPOCHREALTIME - pt0 ))
  done
  _p_metric "pi warm start (full config)" $(( ptotal * 1000 / 3 )) 600 2000
fi

# ---------------------------------------------------------------------------
print -- "\n========================================"
print " perf: $_P_PASS pass, $_P_WARN warn, $_P_FAIL fail"
print "========================================"
(( _P_FAIL == 0 ))
