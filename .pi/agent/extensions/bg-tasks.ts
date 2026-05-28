/**
 * bg-tasks — kick off long-running pi tasks in detached tmux sessions, then
 * check on them from anywhere. The "amux pattern" minus the Claude Code lock-in,
 * minus the web dashboard, minus 95% of the code.
 *
 * Four tools:
 *
 *   bg_task       Spawn `pi -p "<prompt>"` in a fresh detached tmux session.
 *                 Returns the session handle immediately so the parent pi can
 *                 keep going. Background pi inherits pi's settings (extensions,
 *                 skills, AGENTS.md, model) unless `minimal: true` is set.
 *
 *   bg_bash       Spawn an arbitrary bash command in a detached tmux session.
 *                 Same lifecycle as bg_task but runs the user's bash directly
 *                 instead of `pi -p`. Use for polling loops, long builds,
 *                 slow downloads — anything that would hit pi's `bash` tool
 *                 timeout. The command's quoting / substitutions / pipes /
 *                 redirects all work as if you'd typed them in your terminal.
 *
 *   bg_list       Enumerate all currently-known bg tasks (running + completed
 *                 in last 24h) with their status, kind (π=pi, $=bash), prompt
 *                 / command summary, elapsed time. Token-efficient one-line-per-task.
 *
 *   bg_status     Drill into ONE bg task: full prompt/command, last N output
 *                 lines, exit code, output bytes, working directory.
 *
 * State (per-task) lives at ~/.pi/agent/bg-tasks/<name>.json:
 *   {
 *     name, slug, kind: "pi"|"bash",
 *     prompt?: string,    // present when kind="pi" (bg_task)
 *     command?: string,   // present when kind="bash" (bg_bash)
 *     cwd, started_at,
 *     completed_at?, exit_code?, output_bytes?, model?
 *   }
 *
 * tmux session names: `pi-bg-<slug>-<unix-ts>`. The wrapper script that
 * launches pi inside tmux updates the JSON on exit so polling sees terminal
 * state without parsing tmux.
 *
 * No daemon. No DB. No dashboard. No external port. Just files + tmux.
 *
 * Limitations:
 *   - Requires `tmux` on PATH (Arch: pacman -S tmux; you already have it).
 *   - `bg_task` doesn't accept follow-up messages (pi -p is one-shot).
 *     For multi-turn delegation, use the existing `task` extension or
 *     attach to the tmux session manually with `tmux attach -t <name>`.
 *   - `bg_bash` runs in a fresh `bash <tempfile>` subshell — no inherited
 *     shell state from the parent pi. Set up env in the command itself.
 *   - bg_list only lists tasks whose state file is on disk; truly orphan
 *     tmux sessions (created outside this extension) are ignored.
 * See also: ~/.pi/agent/TOOLKIT.md (workflows, canonical invocations)
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ── constants ─────────────────────────────────────────────────────────────

const STATE_DIR = join(getAgentDir(), "bg-tasks");
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_OUTPUT_LINES_DEFAULT = 60;
const TMUX_PREFIX = "pi-bg-";

// ── types ─────────────────────────────────────────────────────────────────

interface TaskState {
  name: string; // tmux session name
  slug: string; // short user-given label
  // Exactly one of these is set depending on the task kind:
  //   prompt: spawned via bg_task — runs `pi -p <prompt>`
  //   command: spawned via bg_bash — runs an arbitrary bash command
  prompt?: string;
  command?: string;
  kind: "pi" | "bash"; // discriminator
  cwd: string;
  model?: string;
  minimal?: boolean;
  started_at: number;
  completed_at?: number;
  exit_code?: number;
  output_bytes?: number;
}

// ── state helpers ─────────────────────────────────────────────────────────

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function logPath(name: string): string {
  return `${statePath(name).replace(/\.json$/, "")}.log`;
}

function statePath(name: string): string {
  return join(STATE_DIR, `${name}.json`);
}

function saveState(s: TaskState) {
  ensureStateDir();
  writeFileSync(statePath(s.name), JSON.stringify(s, null, 2) + "\n");
}

function loadState(name: string): TaskState | null {
  const p = statePath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TaskState;
  } catch {
    return null;
  }
}

function listStates(): TaskState[] {
  ensureStateDir();
  const out: TaskState[] = [];
  for (const f of readdirSync(STATE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const s = loadState(f.replace(/\.json$/, ""));
    if (s) out.push(s);
  }
  // Newest first
  out.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  return out;
}

// GC: remove state files older than RECENT_WINDOW_MS. Two paths:
//
//   1. Tasks with `completed_at` set: GC `completed_at + 24h` ago. Normal flow.
//
//   2. Tasks with `completed_at` NULL but no live tmux session AND
//      `started_at + 24h` ago: "lost" tasks where tmux died before the
//      wrapper could patch state JSON (host reboot, OOM kill, etc.).
//      Without this branch they accumulate forever — caught 2026-05-28
//      with 13 orphans aged 71h-100h+ on a single host.
//
// Sibling .log files are removed alongside the JSON.
function gc() {
  ensureStateDir();
  const now = Date.now();
  const liveSessions = new Set(tmuxListSessions());
  for (const f of readdirSync(STATE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const s = loadState(f.replace(/\.json$/, ""));
    if (!s) continue;
    const isLive = liveSessions.has(s.name);
    const completedExpired =
      s.completed_at !== undefined && now - s.completed_at > RECENT_WINDOW_MS;
    const lostExpired =
      s.completed_at === undefined && !isLive && now - s.started_at > RECENT_WINDOW_MS;
    if (completedExpired || lostExpired) {
      for (const p of [statePath(s.name), logPath(s.name)]) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * Compute the human-readable status label for a task. Single source of
 * truth so bg_list (tool + slash command) and bg_status agree.
 *
 * `exit_code === -1` is the bg_kill sentinel — render as "killed" not the
 * eyeball-hostile "exit--1". Otherwise:
 *   running  — live tmux session, no completion recorded
 *   done     — completed with exit_code 0
 *   exit-N   — completed with non-zero exit code
 *   killed   — completed via bg_kill (exit_code -1)
 *   lost     — tmux gone but no completion recorded (crashed / OOM / reboot)
 */
export function computeStatusLabel(
  state: { exit_code?: number; completed_at?: number },
  isLive: boolean,
): string {
  const isDone = state.completed_at !== undefined;
  if (isLive && !isDone) return "running";
  if (isDone && state.exit_code === 0) return "done";
  if (isDone && state.exit_code === -1) return "killed";
  if (isDone) return `exit-${state.exit_code}`;
  return "lost";
}

/**
 * Read the last N lines of a bg task's output — try the live tmux pane
 * first, fall back to the persistent .log file when the pane is dead.
 * Without the .log fallback, tasks become invisible 30s after exit (the
 * wrapper's grace period). Caught 2026-05-28: bg_wait gets cancelled, the
 * underlying bg_bash keeps running, output ends up nowhere the agent
 * can reach.
 */
function captureOrLog(name: string, lines: number): string {
  if (tmuxHasSession(name)) {
    const cap = tmuxCapture(name, lines);
    if (cap) return cap;
  }
  const lp = logPath(name);
  try {
    const r = spawnSync("tail", ["-n", String(lines), lp], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0) return r.stdout?.toString("utf-8") ?? "";
  } catch { /* fall through */ }
  return "";
}

// ── tmux helpers ──────────────────────────────────────────────────────────

function tmuxHasSession(name: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
  return r.status === 0;
}

function tmuxCapture(name: string, lines: number): string {
  // capture-pane -p prints to stdout; -S -<N> means start N lines back from
  // the end of the scrollback (negative numbers count from end).
  const r = spawnSync("tmux", ["capture-pane", "-p", "-t", name, "-S", `-${lines}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return "";
  return r.stdout?.toString("utf-8") ?? "";
}

function tmuxListSessions(): string[] {
  const r = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return [];
  return (r.stdout?.toString("utf-8") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tmuxKillSession(name: string): void {
  spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
}

// ── slug helpers ──────────────────────────────────────────────────────────

function makeSlug(input: string): string {
  // Take first 4 alpha tokens, lowercase, hyphenated. Bounded to 30 chars.
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 4);
  const slug = tokens.join("-").slice(0, 30) || "task";
  return slug;
}

function makeSessionName(slug: string): string {
  // Compact unix-ts (seconds) — enough resolution; reads as a sortable suffix
  return `${TMUX_PREFIX}${slug}-${Math.floor(Date.now() / 1000)}`;
}

// ── wrapper script that runs inside tmux ──────────────────────────────────

// Build a bash command that:
//   1. Writes the prompt to a tempfile (avoids ALL shell-quoting issues —
//      prompts can contain backticks, $(...) substitutions, quotes, newlines)
//   2. Runs `pi -p "$(cat $promptfile)" $flags` with the flags array
//      passed verbatim through positional args (not eval-expanded)
//   3. Captures exit code, updates the state file with completed_at + exit_code
//   4. Keeps the tmux pane alive briefly so capture-pane has output, then exits
//
// CRITICAL: do not use `eval` on the prompt. Prompts contain user content
// with arbitrary characters. Backticks would trigger command substitution and
// hang the wrapper waiting for input from an interactive sub-bash.
//
// LIVE OUTPUT INVARIANT: the inner command's output MUST land on the tmux
// pane in real time, not buffered to a file and dumped at exit. bg_wait's
// whole premise is polling `tmux capture-pane` for a regex match in live
// output — if the pane stays empty until the wrapper exits, bg_wait can
// only ever match on already-completed tasks, which defeats the point.
// We achieve this with `<cmd> 2>&1 | tee "$OUT_FILE"` (writes to both pane
// and file) plus `stdbuf -oL -eL` on the inner cmd so libc-block-buffered
// children flush per-line. Exit code via `${PIPESTATUS[0]}` (bash builtin).
function buildWrapperCommand(state: TaskState, piFlags: string[]): string {
  const promptFile = `${statePath(state.name)}.prompt`;
  // We write the prompt file from inside the wrapper itself (single-quoted
  // base64 keeps it safe regardless of contents), then decode at runtime.
  const promptB64 = Buffer.from(state.prompt, "utf-8").toString("base64");
  // Build the pi argv as an array; we'll splat with "${PI_FLAGS[@]}" so
  // arguments containing spaces survive intact.
  // shellSingleQuote each flag in case any contains a metachar.
  const flagsArrayInit = piFlags.map((f) => shellSingleQuote(f)).join(" ");

  const env = {
    PI_BG_STATE: statePath(state.name),
    PI_BG_PROMPT_FILE: promptFile,
    PI_BG_PROMPT_B64: promptB64,
    PI_BG_CWD: state.cwd,
  };
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
    .join(" ");

  // Plain template literal (not String.raw) so we can escape \${ for bash
  // parameter expansion while letting JS substitute ${flagsArrayInit}.
  // The wrapper:
  //  1. base64-decodes the prompt to a file (binary-safe)
  //  2. reads the prompt as a single shell variable
  //  3. uses a bash array (PI_FLAGS) splatted with "$\{PI_FLAGS[@]\}" so
  //     each flag stays as a separate argv entry
  //  4. runs pi WITHOUT eval — prompt's special chars (backticks, $, etc.)
  //     pass through verbatim
  const body = `
    set -o pipefail
    cd "\$PI_BG_CWD" || exit 1
    PI_FLAGS=(${flagsArrayInit})
    # Decode the prompt to a file. base64 is binary-safe for any content.
    printf '%s' "\$PI_BG_PROMPT_B64" | base64 -d > "\$PI_BG_PROMPT_FILE"
    PROMPT="\$(cat "\$PI_BG_PROMPT_FILE")"
    # Persistent log file lives next to the state JSON — survives the 30s
    # tmux grace + gc() 24h window. Truncate any prior content in case of
    # a name collision (rare, but cheap to defend).
    OUT_FILE="\${PI_BG_STATE%.json}.log"
    : > "\$OUT_FILE"
    # Run pi WITHOUT eval. Array splat keeps flags as separate argv entries;
    # prompt is passed as a single quoted arg with all special chars intact.
    # Live-stream pi's output to the tmux pane via tee while also recording
    # to OUT_FILE for the byte count + state JSON. stdbuf -oL forces
    # line-buffered stdout/stderr (matters for libc-buffered children).
    if command -v stdbuf >/dev/null 2>&1; then
      stdbuf -oL -eL pi -p "\$PROMPT" "\${PI_FLAGS[@]}" 2>&1 | tee "\$OUT_FILE"
    else
      pi -p "\$PROMPT" "\${PI_FLAGS[@]}" 2>&1 | tee "\$OUT_FILE"
    fi
    RC=\${PIPESTATUS[0]}
    BYTES=\$(wc -c < "\$OUT_FILE")
    NOW=\$(date +%s%3N)
    if command -v jq >/dev/null; then
      tmp=\$(mktemp)
      jq --argjson rc "\$RC" --argjson b "\$BYTES" --argjson t "\$NOW" \\
         '.exit_code=\$rc | .output_bytes=\$b | .completed_at=\$t' \\
         "\$PI_BG_STATE" > "\$tmp" && mv "\$tmp" "\$PI_BG_STATE"
    else
      python3 -c "
import json,os
p=os.environ['PI_BG_STATE']
d=json.load(open(p))
d['exit_code']=\$RC
d['output_bytes']=\$BYTES
d['completed_at']=int(\$NOW)
json.dump(d, open(p,'w'), indent=2)
"
    fi
    # Keep \$OUT_FILE — it's the persistent log. Only wrapper-private
    # helpers (\$PI_BG_PROMPT_FILE) get cleaned.
    rm -f "\$PI_BG_PROMPT_FILE"
    # Keep the pane alive for ~30s so a fast bg_status call can still see the
    # final output via tmux capture-pane. After that tmux GCs the session.
    sleep 30
  `;
  return `${envPrefix} bash -c ${shellSingleQuote(body)}`;
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Wrapper for arbitrary bash commands (bg_bash). Same overall structure as
// buildWrapperCommand but the inner command is the user's bash literal
// instead of `pi -p <prompt>`. Command is passed via env var so it's never
// re-quoted.
function buildBashWrapper(state: TaskState): string {
  const cmdB64 = Buffer.from(state.command ?? "", "utf-8").toString("base64");
  const env = {
    PI_BG_STATE: statePath(state.name),
    PI_BG_CMD_B64: cmdB64,
    PI_BG_CWD: state.cwd,
  };
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
    .join(" ");
  const body = `
    set -o pipefail
    cd "\$PI_BG_CWD" || exit 1
    # Persistent log file (see pi wrapper for rationale). CMD_FILE stays as
    # mktemp — it's a transient base64-decoded staging file, not
    # user-visible output.
    OUT_FILE="\${PI_BG_STATE%.json}.log"
    : > "\$OUT_FILE"
    CMD_FILE=\$(mktemp)
    printf '%s' "\$PI_BG_CMD_B64" | base64 -d > "\$CMD_FILE"
    # Run the user's bash command as a fresh subshell sourcing the file.
    # No eval. The command's own quoting / substitutions are evaluated
    # by bash exactly as if you'd typed them yourself.
    # Live-stream the user's bash command to the tmux pane via tee while
    # also recording to OUT_FILE for the byte count + state JSON. stdbuf -oL
    # propagates via LD_PRELOAD to children, so a python or gh call inside
    # the user's script gets line-buffered stdout instead of the default
    # 4 KB block buffering when piped.
    if command -v stdbuf >/dev/null 2>&1; then
      stdbuf -oL -eL bash "\$CMD_FILE" 2>&1 | tee "\$OUT_FILE"
    else
      bash "\$CMD_FILE" 2>&1 | tee "\$OUT_FILE"
    fi
    RC=\${PIPESTATUS[0]}
    BYTES=\$(wc -c < "\$OUT_FILE")
    NOW=\$(date +%s%3N)
    if command -v jq >/dev/null; then
      tmp=\$(mktemp)
      jq --argjson rc "\$RC" --argjson b "\$BYTES" --argjson t "\$NOW" \\
         '.exit_code=\$rc | .output_bytes=\$b | .completed_at=\$t' \\
         "\$PI_BG_STATE" > "\$tmp" && mv "\$tmp" "\$PI_BG_STATE"
    else
      python3 -c "
import json,os
p=os.environ['PI_BG_STATE']
d=json.load(open(p))
d['exit_code']=\$RC
d['output_bytes']=\$BYTES
d['completed_at']=int(\$NOW)
json.dump(d, open(p,'w'), indent=2)
"
    fi
    rm -f "\$CMD_FILE"
    sleep 30
  `;
  return `${envPrefix} bash -c ${shellSingleQuote(body)}`;
}

// ── tool: bg_task ─────────────────────────────────────────────────────────

const bgTaskTool = defineTool({
  name: "bg_task",
  label: "Background Task",
  promptSnippet:
    "bg_task — spawn `pi -p` in a detached tmux session, returns immediately. Check progress via bg_list / bg_status.",
  promptGuidelines: [
    "Use when the task will take >5 minutes and you want to keep working in parallel.",
    "Use `minimal: true` for read-only exploration to skip the full extension load (same flags as task `explore`).",
    "Returns the session name — pass that to bg_status later.",
  ],
  description: [
    "Spawn a fresh `pi -p` instance in a detached tmux session and return the session handle.",
    "",
    "Parent pi does NOT block — bg_task returns within ~100ms with the handle. Use bg_list / bg_status to check progress later.",
    "",
    "The background pi inherits all your normal config (extensions, skills, AGENTS.md, default model) unless `minimal: true` is set.",
    "",
    "tmux session names look like `pi-bg-<slug>-<unix-ts>`. Attach manually with `tmux attach -t <name>` if you want a live view.",
  ].join("\n"),
  parameters: Type.Object({
    prompt: Type.String({
      description: "The prompt to send to the background pi. Be self-contained — the subagent starts fresh.",
    }),
    name: Type.Optional(
      Type.String({
        description: "Optional human-readable slug for the tmux session (auto-generated from prompt if omitted).",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the background pi (default: parent pi's cwd).",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description: "Pass `--model <m>` to background pi (default: inherit).",
      }),
    ),
    minimal: Type.Optional(
      Type.Boolean({
        description:
          "If true, background pi runs with --no-extensions --no-skills --no-prompt-templates. Cheap explore mode.",
      }),
    ),
    tools: Type.Optional(
      Type.String({
        description: "Comma-separated tool whitelist (passed as --tools).",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    // Probe tmux up front so we don't write state for a doomed run
    const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
    if (probe.status !== 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "tmux not on PATH. Install with `sudo pacman -S tmux`." }],
        details: { error: "tmux-missing" },
      };
    }

    gc(); // tidy stale state on every spawn — cheap

    const slug = makeSlug(params.name ?? params.prompt);
    const sessionName = makeSessionName(slug);
    const cwd = params.cwd ?? ctx.cwd;

    const piFlags: string[] = ["--no-session"]; // no persisted session for bg
    if (params.model) piFlags.push("--model", params.model);
    if (params.minimal) {
      piFlags.push("--no-extensions", "--no-skills", "--no-prompt-templates");
    }
    if (params.tools) piFlags.push("--tools", params.tools);

    const state: TaskState = {
      name: sessionName,
      slug,
      kind: "pi",
      prompt: params.prompt,
      cwd,
      model: params.model,
      minimal: params.minimal,
      started_at: Date.now(),
    };
    saveState(state);

    const wrapperCmd = buildWrapperCommand(state, piFlags);
    const r = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, wrapperCmd],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (r.status !== 0) {
      // Roll back state file on failure so list isn't polluted
      try {
        unlinkSync(statePath(sessionName));
      } catch {
        /* ignore */
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to spawn tmux session: ${r.stderr?.toString().trim() || "unknown error"}`,
          },
        ],
        details: { error: "tmux-spawn-failed" },
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Spawned bg task: ${sessionName}\n` +
            `  prompt: ${params.prompt.slice(0, 120)}${params.prompt.length > 120 ? "…" : ""}\n` +
            `  cwd:    ${cwd}\n` +
            `  attach: tmux attach -t ${sessionName}\n` +
            `  check:  bg_status name=${sessionName}`,
        },
      ],
      details: { name: sessionName, slug, cwd, started_at: state.started_at },
    };
  },
});

// ── tool: bg_bash ─────────────────────────────────────────────────────────

const bgBashTool = defineTool({
  name: "bg_bash",
  label: "Background Bash",
  promptSnippet:
    "bg_bash — run an arbitrary bash command in a detached tmux session. Use for polling loops, long builds, slow downloads, anything past pi's `bash` tool timeout.",
  promptGuidelines: [
    "Use when the command will take >30s and you don't want pi's bash to time out / block the agent.",
    "Use for polling loops (`for i in $(seq 1 N); do ... sleep ...; done`), long builds, slow downloads.",
    "Returns the session name immediately — check progress via bg_list / bg_status.",
  ],
  description: [
    "Spawn an arbitrary bash command in a detached tmux session and return the session handle.",
    "",
    "Same lifecycle as bg_task but runs your bash directly instead of `pi -p`. Use this when:",
    "- You're polling external state (e.g. waiting for a TLS cert to be issued)",
    "- You need to run a long build / migration / download in the background",
    "- The command would otherwise hit pi's `bash` tool timeout",
    "",
    "The command runs in a fresh `bash <tempfile>` subshell so all standard bash features work: pipes, redirects, loops, command substitution, $variables. The command receives no positional args.",
  ].join("\n"),
  parameters: Type.Object({
    command: Type.String({
      description:
        "The bash command to run. Can be multi-line (use \\n) or include loops, pipes, etc. No positional args supported.",
    }),
    name: Type.Optional(
      Type.String({
        description: "Optional human-readable slug (auto-generated from command if omitted).",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the command (default: parent pi's cwd).",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
    if (probe.status !== 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "tmux not on PATH. Install with `sudo pacman -S tmux`." }],
        details: { error: "tmux-missing" },
      };
    }
    gc();

    const slug = makeSlug(params.name ?? params.command);
    const sessionName = makeSessionName(slug);
    const cwd = params.cwd ?? ctx.cwd;

    const state: TaskState = {
      name: sessionName,
      slug,
      kind: "bash",
      command: params.command,
      cwd,
      started_at: Date.now(),
    };
    saveState(state);

    const wrapperCmd = buildBashWrapper(state);
    const r = spawnSync("tmux", ["new-session", "-d", "-s", sessionName, wrapperCmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      try {
        unlinkSync(statePath(sessionName));
      } catch {
        /* ignore */
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to spawn tmux session: ${r.stderr?.toString().trim() || "unknown error"}`,
          },
        ],
        details: { error: "tmux-spawn-failed" },
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Spawned bg bash task: ${sessionName}\n` +
            `  command: ${params.command.slice(0, 140).replace(/\n/g, " ↵ ")}${params.command.length > 140 ? "…" : ""}\n` +
            `  cwd:     ${cwd}\n` +
            `  attach:  tmux attach -t ${sessionName}\n` +
            `  check:   bg_status name=${sessionName}`,
        },
      ],
      details: { name: sessionName, slug, cwd, started_at: state.started_at, kind: "bash" },
    };
  },
});


// ── tool: bg_list ─────────────────────────────────────────────────────────

const bgListTool = defineTool({
  name: "bg_list",
  label: "Background Task List",
  promptSnippet: "bg_list — enumerate all bg tasks (running + recently completed).",
  promptGuidelines: [],
  description: [
    "List all known bg tasks (state files in ~/.pi/agent/bg-tasks/, plus live tmux session check).",
    "",
    "Returns one line per task: status (running/done/exit-N), elapsed, slug, prompt preview.",
    "Completed tasks are kept for 24h after exit, then garbage-collected.",
  ].join("\n"),
  parameters: Type.Object({
    only_running: Type.Optional(
      Type.Boolean({ description: "If true, hide completed tasks. Default false." }),
    ),
  }),
  async execute(_id, params) {
    gc();
    const states = listStates();
    const liveSessions = new Set(tmuxListSessions());

    if (states.length === 0) {
      return {
        content: [{ type: "text", text: "No background tasks (none running, none in last 24h)." }],
        details: { count: 0 },
      };
    }

    const now = Date.now();
    const rows = states
      .map((s) => {
        const isLive = liveSessions.has(s.name);
        const isDone = s.completed_at !== undefined;
        const status = computeStatusLabel(s, isLive);
        const elapsedMs = (s.completed_at ?? now) - s.started_at;
        const elapsed = fmtDuration(elapsedMs);
        const previewSrc = s.prompt ?? s.command ?? "";
        const preview = previewSrc.replace(/\s+/g, " ").slice(0, 80);
        const kind = s.kind ?? (s.prompt ? "pi" : s.command ? "bash" : "pi");
        return { status, elapsed, name: s.name, slug: s.slug, prompt: preview, isDone, isLive, kind, raw: s };
      })
      .filter((r) => (params.only_running ? !r.isDone && r.isLive : true));

    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "No bg tasks match the filter." }],
        details: { count: 0, filter: params },
      };
    }

    const lines = rows.map((r) => {
      const tag =
        r.status === "running"
          ? "▶ running"
          : r.status === "done"
            ? "✓ done   "
            : r.status === "killed"
              ? "☠ killed  "
              : r.status === "lost"
                ? "? lost   "
                : `✗ ${r.status}`;
      const kindGlyph = r.kind === "bash" ? "$" : "π"; // π for pi, $ for bash
      return `${tag} ${kindGlyph} ${r.elapsed.padEnd(7)}  ${r.name}\n             ${r.prompt}${r.prompt.length === 80 ? "…" : ""}`;
    });

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        count: rows.length,
        running: rows.filter((r) => r.status === "running").length,
        done: rows.filter((r) => r.status === "done").length,
        failed: rows.filter((r) => r.status.startsWith("exit-")).length,
        killed: rows.filter((r) => r.status === "killed").length,
        lost: rows.filter((r) => r.status === "lost").length,
        tasks: rows.map((r) => ({
          name: r.name,
          slug: r.slug,
          status: r.status,
          elapsedMs: (r.raw.completed_at ?? now) - r.raw.started_at,
          startedAt: r.raw.started_at,
        })),
      },
    };
  },
});

// ── tool: bg_status ───────────────────────────────────────────────────────

const bgStatusTool = defineTool({
  name: "bg_status",
  label: "Background Task Status",
  promptSnippet: "bg_status — drill into one bg task: full prompt, last output, exit code.",
  promptGuidelines: [],
  description: [
    "Get the full status of one bg task: state file contents + last N lines of tmux output.",
    "",
    "If the task is still running, output is captured live from tmux. If completed, the last tmux pane state is returned (kept ~30s after exit).",
  ].join("\n"),
  parameters: Type.Object({
    name: Type.String({
      description: "tmux session name returned by bg_task (e.g. pi-bg-foo-1748050000).",
    }),
    lines: Type.Optional(
      Type.Number({ description: "Max output lines to return from tmux pane. Default 60." }),
    ),
  }),
  async execute(_id, params) {
    const state = loadState(params.name);
    if (!state) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No state file for ${params.name}. Either the task never existed or it was GC'd (>24h ago).`,
          },
        ],
        details: { error: "no-state", name: params.name },
      };
    }
    const live = tmuxHasSession(params.name);
    const linesWanted = params.lines ?? MAX_OUTPUT_LINES_DEFAULT;
    // captureOrLog: tmux pane while alive, persistent .log file after exit.
    // Pre-2026-05-28 this was tmuxCapture-only and returned "" once the
    // wrapper's 30s grace period elapsed.
    const output = captureOrLog(params.name, linesWanted);

    const now = Date.now();
    const elapsedMs = (state.completed_at ?? now) - state.started_at;
    const status = computeStatusLabel(state, live);

    const kind = state.kind ?? (state.prompt ? "pi" : state.command ? "bash" : "pi");
    const body = state.prompt ?? state.command ?? "(missing)";
    const bodyLabel = kind === "bash" ? "command" : "prompt";
    const headerLines = [
      `name:    ${state.name}`,
      `kind:    ${kind}`,
      `status:  ${status}`,
      `elapsed: ${fmtDuration(elapsedMs)}${live && status === "running" ? " (still running)" : live ? " (pane held — wrapper grace period)" : ""}`,
      `cwd:     ${state.cwd}`,
      state.model ? `model:   ${state.model}` : null,
      state.minimal ? "minimal: true (no extensions/skills)" : null,
      "",
      `${bodyLabel}:`,
      `  ${body.replace(/\n/g, "\n  ").slice(0, 1000)}`,
    ].filter((x): x is string => x !== null);

    const outputBlock = output.trim() ? `\n\noutput (last ${linesWanted} lines):\n${output.trimEnd()}` : "";

    return {
      content: [{ type: "text", text: headerLines.join("\n") + outputBlock }],
      details: {
        name: state.name,
        status,
        live,
        elapsedMs,
        startedAt: state.started_at,
        completedAt: state.completed_at ?? null,
        exitCode: state.exit_code ?? null,
        outputBytes: state.output_bytes ?? null,
        cwd: state.cwd,
        model: state.model,
        minimal: state.minimal ?? false,
      },
    };
  },
});

// ── tool: bg_wait ────────────────────────────────────────────────────────
//
// Block inside ONE tool call until a condition fires on a bg task. Replaces
// the re-prompt loop pattern ("check the logs" → "now check again" → "and
// again") with a single in-tool wait. Conditions: regex match in tail output,
// task exit, or timeout. Any one of them wins.

/**
 * Pure decision helper — takes a snapshot and reports whether a wait should
 * resolve now. Extracted for unit tests; the execute() loop calls this on
 * every poll tick.
 */
export function decideWaitResult(args: {
  state: TaskState | null;
  output: string;
  live: boolean;
  pattern?: RegExp;
  untilExit: boolean;
}): { result: "matched" | "exited" | "pending"; matchLine?: string } {
  if (args.pattern) {
    const m = args.output.match(args.pattern);
    if (m) return { result: "matched", matchLine: m[0] };
  }
  // Treat completion as "exited" only when the caller asked for it OR when
  // they only supplied a pattern and the task ended without matching (caller
  // needs to know it can't match anymore). If neither condition was asked
  // for that's a config error caught upstream.
  if (!args.live || args.state?.completed_at !== undefined) {
    if (args.untilExit || args.pattern) return { result: "exited" };
  }
  return { result: "pending" };
}

const bgWaitTool = defineTool({
  name: "bg_wait",
  label: "Background Task Wait",
  promptSnippet:
    "bg_wait — block until a bg task matches a regex, exits, or times out. Avoids re-prompt loops.",
  promptGuidelines: [
    "Use when you spawned bg_bash/bg_task and need to wait for a specific event (a log line, task completion). Replaces a chain of bg_status polls + user re-prompts.",
    "Pass `pattern` to wait for a regex in the captured tail; `until_exit=true` to wait for the task to finish; pass both for match-OR-exit.",
    "Default timeout 300s, max 600s. The tool returns as soon as ANY condition fires. CI/build watch loops typically need the full 300+; quick log-line waits can pass smaller values.",
    "Regex is JS syntax with the `m` flag (multiline). Common: 'ERROR|FATAL', 'listening on \\d+', 'job complete'.",
  ],
  description: [
    "Block until a regex matches output, the task exits, or timeout elapses.",
    "",
    "Returns the final status snapshot plus `waitResult`: 'matched' | 'exited' | 'timeout'. Use this instead of bg_status-in-a-loop — the wait happens server-side, no re-prompts needed.",
  ].join("\n"),
  parameters: Type.Object({
    name: Type.String({
      description: "tmux session name returned by bg_task / bg_bash.",
    }),
    pattern: Type.Optional(
      Type.String({
        description:
          "Regex (JS syntax, multiline). Matched against the captured tail on each poll tick. First match resolves the wait.",
      }),
    ),
    until_exit: Type.Optional(
      Type.Boolean({
        description: "Resolve when the task exits (regardless of pattern). Default: false.",
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description:
          "Max seconds to wait. Default 300, min 1, max 600. Bump generously for long log tails / slow builds — the tool returns early as soon as the condition fires, so over-estimating is free. CI / build-watch loops typically need the full 300+; quick log-line waits can pass smaller values.",
      }),
    ),
    poll_interval: Type.Optional(
      Type.Number({
        description: "Seconds between polls. Default 2, min 0.5.",
      }),
    ),
    lines: Type.Optional(
      Type.Number({
        description: "Tail size scanned for the pattern. Default 200.",
      }),
    ),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    const state0 = loadState(params.name);
    if (!state0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No state file for ${params.name}. Either the task never existed or it was GC'd (>24h).`,
          },
        ],
        details: { error: "no-state", name: params.name },
      };
    }
    const untilExit = params.until_exit ?? false;
    if (!params.pattern && !untilExit) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Pass at least one of `pattern` or `until_exit=true` — otherwise this tool has no condition to wait on.",
          },
        ],
        details: { error: "no-condition" },
      };
    }
    let re: RegExp | undefined;
    if (params.pattern) {
      try {
        re = new RegExp(params.pattern, "m");
      } catch (e) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Invalid regex: ${(e as Error).message}` },
          ],
          details: { error: "bad-regex", pattern: params.pattern },
        };
      }
    }
    const timeoutMs = Math.min(Math.max(params.timeout ?? 300, 1), 600) * 1000;
    const intervalMs = Math.max((params.poll_interval ?? 2) * 1000, 500);
    const linesWanted = Math.min(Math.max(params.lines ?? 200, 1), 5000);
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();

    let waitResult: "matched" | "exited" | "timeout" = "timeout";
    let matchLine: string | undefined;
    let lastOutput = "";
    let pollCount = 0;
    const statusKey = `bg-wait-${params.name}`;

    // Poll loop. Sleep is broken by AbortSignal so user can cancel.
    while (true) {
      if (signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text", text: `Wait on ${params.name} cancelled.` }],
          details: { error: "aborted", name: params.name },
        };
      }
      const state = loadState(params.name);
      const live = tmuxHasSession(params.name);
      // captureOrLog: tmux while live, persistent .log when not. Without
      // the log fallback bg_wait would lose visibility of tasks that
      // finished during the wait (race between exit + grace expiry).
      const cap = captureOrLog(params.name, linesWanted);
      if (cap) lastOutput = cap;

      const verdict = decideWaitResult({
        state,
        output: lastOutput,
        live,
        pattern: re,
        untilExit,
      });
      pollCount++;
      if (verdict.result === "matched") {
        waitResult = "matched";
        matchLine = verdict.matchLine;
        break;
      }
      if (verdict.result === "exited") {
        waitResult = "exited";
        break;
      }

      // Stream progress so the user (and the agent inspecting tool state)
      // can see we're alive. Without this the TUI just shows "Working..."
      // for the full timeout, which feels broken.
      const elapsedS = Math.floor((Date.now() - startedAt) / 1000);
      const remainingS = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const tailLines = lastOutput
        .split("\n")
        .filter((l) => l.length > 0)
        .slice(-3);
      const conditionDesc = re
        ? `pattern /${re.source}/`
        : `task exit`;
      const progressText = [
        `waiting on ${params.name} — ${conditionDesc}`,
        `elapsed ${elapsedS}s, ${remainingS}s left, poll #${pollCount}`,
        tailLines.length > 0
          ? `last:\n${tailLines.map((l) => `  ${l}`).join("\n")}`
          : `(no output yet)`,
      ].join("\n");
      onUpdate?.({
        content: [{ type: "text", text: progressText }],
        details: { elapsedS, remainingS, pollCount, live },
      });
      ctx?.ui?.setStatus?.(
        statusKey,
        `bg_wait ${params.name}: ${elapsedS}s / ${elapsedS + remainingS}s`,
      );

      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // timeout
      const sleepFor = Math.min(intervalMs, remaining);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, sleepFor);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        // Note: we don't bother removing the listener — promise resolves once,
        // and the signal's lifetime is bounded by this tool call.
      });
    }

    // Clear the footer status line.
    ctx?.ui?.setStatus?.(statusKey, undefined);

    const finalState = loadState(params.name) ?? state0;
    const live = tmuxHasSession(params.name);
    const elapsedMs = (finalState.completed_at ?? Date.now()) - finalState.started_at;
    const exitCode = finalState.exit_code;
    const matchPreview = matchLine
      ? ` (matched: ${matchLine.replace(/\n/g, " ").slice(0, 100)})`
      : "";

    // On timeout with no match, surface a hint to drill into the persistent
    // log via bg_status — the agent's reflex was to give up; better path is
    // to extend timeout or tail the log.
    const timeoutHint = waitResult === "timeout"
      ? `\n\n[hint] timeout fired without ${re ? `matching /${re.source}/` : "task exit"}. ` +
        `Output above is the live tail. Full log persists at ~/.pi/agent/bg-tasks/${params.name}.log ` +
        `(also accessible via bg_status). Re-invoke bg_wait with a higher timeout if the task is still running.`
      : "";

    const text = [
      `name:        ${finalState.name}`,
      `waitResult:  ${waitResult}${matchPreview}`,
      `live:        ${live}`,
      `exitCode:    ${exitCode ?? "—"}`,
      `elapsed:     ${fmtDuration(elapsedMs)}`,
      "",
      `output (last ${linesWanted} lines):`,
      lastOutput.trimEnd() || "(empty)",
    ].join("\n") + timeoutHint;

    return {
      content: [{ type: "text", text }],
      details: {
        name: finalState.name,
        waitResult,
        matched: matchLine ?? null,
        live,
        exitCode: exitCode ?? null,
        elapsedMs,
        timedOut: waitResult === "timeout",
      },
    };
  },
});

// ── tool: bg_kill ─────────────────────────────────────────────────────────
//
// Forcibly stop a running bg task. Until 2026-05-28 the only way to terminate
// a runaway bg_bash polling loop or a background pi -p subprocess was to
// `tmux kill-session` manually from a host shell, which the agent can't do.
// The tool kills the tmux session AND patches the state JSON so subsequent
// bg_list / bg_status calls see exit_code=-1 + completed_at=now (otherwise
// the task would show as "lost" — tmux gone with no completion recorded).

function killAndMarkState(name: string): {
  killed: boolean;
  hadSession: boolean;
  hadState: boolean;
} {
  const hadState = loadState(name) !== null;
  const hadSession = tmuxHasSession(name);
  if (hadSession) tmuxKillSession(name);
  const s = loadState(name);
  if (s && s.completed_at === undefined) {
    s.completed_at = Date.now();
    s.exit_code = -1; // sentinel: killed
    saveState(s);
  }
  return { killed: hadSession, hadSession, hadState };
}

const bgKillTool = defineTool({
  name: "bg_kill",
  label: "Background Task Kill",
  promptSnippet:
    "bg_kill — terminate a running bg task. Sets exit_code=-1 in state so bg_list shows it as killed (not lost).",
  promptGuidelines: [
    "Use to stop runaway polling loops or background pi -p subprocesses you no longer need.",
    "Idempotent — calling on an already-finished task is a no-op (returns hadSession=false).",
    "Persistent .log file is preserved so you can still inspect output after the kill.",
  ],
  description: [
    "Kill a bg task: terminates the tmux session immediately and marks the state JSON with exit_code=-1 + completed_at=now.",
    "",
    "The persistent .log file is NOT deleted — drill into the final output via bg_status afterwards.",
    "Use when a polling loop is no longer needed or a bg_task has gone runaway.",
  ].join("\n"),
  parameters: Type.Object({
    name: Type.String({
      description: "tmux session name returned by bg_task / bg_bash (e.g. pi-bg-foo-1748050000).",
    }),
  }),
  async execute(_id, params) {
    const r = killAndMarkState(params.name);
    if (!r.hadState && !r.hadSession) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No state and no live session for ${params.name}. Either the task never existed or it was GC'd (>24h ago).`,
          },
        ],
        details: { error: "no-state-no-session", name: params.name },
      };
    }
    if (!r.hadSession) {
      return {
        content: [
          {
            type: "text",
            text:
              `${params.name} already finished — no live tmux session to kill. State preserved.`,
          },
        ],
        details: { name: params.name, killed: false, hadSession: false, hadState: r.hadState },
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Killed bg task: ${params.name}\n` +
            `  state marked: exit_code=-1, completed_at=now\n` +
            `  log preserved at: ~/.pi/agent/bg-tasks/${params.name}.log\n` +
            `  inspect via: bg_status name=${params.name}`,
        },
      ],
      details: { name: params.name, killed: true, hadSession: true, hadState: r.hadState },
    };
  },
});

// ── helpers (exported for tests) ────────────────────────────────────────────

export function fmtDuration(ms: number): string {
  if (ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, "0")}m`;
}

export { makeSlug, makeSessionName };

// ── extension entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool(bgTaskTool);
  pi.registerTool(bgBashTool);
  pi.registerTool(bgListTool);
  pi.registerTool(bgStatusTool);
  pi.registerTool(bgWaitTool);
  pi.registerTool(bgKillTool);

  // Convenience slash command: `/bg-list` for human use (same as the LLM tool)
  pi.registerCommand("bg-list", {
    description: "List background pi tasks",
    handler: async (_args, ctx) => {
      gc();
      const states = listStates();
      if (states.length === 0) {
        ctx.ui.notify("No background tasks", "info");
        return;
      }
      const liveSessions = new Set(tmuxListSessions());
      const now = Date.now();
      const lines = states.map((s) => {
        const live = liveSessions.has(s.name);
        const status = computeStatusLabel(s, live);
        const elapsed = fmtDuration((s.completed_at ?? now) - s.started_at);
        const kind = s.kind ?? (s.prompt ? "pi" : "bash");
        const kindGlyph = kind === "bash" ? "$" : "π";
        const preview = (s.prompt ?? s.command ?? "").slice(0, 60);
        return `${status.padEnd(10)} ${kindGlyph} ${elapsed.padEnd(7)} ${s.slug.padEnd(20)} ${preview}`;
      });
      ctx.ui.notify(`${states.length} bg task(s):\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("bg-kill", {
    description: "Kill a background pi task by name",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("usage: /bg-kill <session-name>", "warning");
        return;
      }
      if (!tmuxHasSession(name)) {
        ctx.ui.notify(`No live tmux session: ${name}`, "warning");
        return;
      }
      const ok = await ctx.ui.confirm(
        `Kill background task ${name}?`,
        "This terminates the pi -p subprocess immediately. Persistent .log is preserved.",
      );
      if (!ok) return;
      const r = killAndMarkState(name);
      ctx.ui.notify(
        r.killed ? `killed ${name} (state marked exit_code=-1)` : `${name} already finished`,
        "info",
      );
    },
  });
}
