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

// GC: remove state files older than RECENT_WINDOW_MS for tasks that have
// completed. Keeps the dir tidy without losing running tasks.
function gc() {
  ensureStateDir();
  const now = Date.now();
  for (const f of readdirSync(STATE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const s = loadState(f.replace(/\.json$/, ""));
    if (!s) continue;
    if (s.completed_at && now - s.completed_at > RECENT_WINDOW_MS) {
      try {
        unlinkSync(statePath(s.name));
      } catch {
        /* ignore */
      }
    }
  }
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
    OUT_FILE=\$(mktemp)
    # Run pi WITHOUT eval. Array splat keeps flags as separate argv entries;
    # prompt is passed as a single quoted arg with all special chars intact.
    pi -p "\$PROMPT" "\${PI_FLAGS[@]}" > "\$OUT_FILE" 2>&1
    RC=\$?
    cat "\$OUT_FILE"
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
    rm -f "\$OUT_FILE" "\$PI_BG_PROMPT_FILE"
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
    OUT_FILE=\$(mktemp)
    CMD_FILE=\$(mktemp)
    printf '%s' "\$PI_BG_CMD_B64" | base64 -d > "\$CMD_FILE"
    # Run the user's bash command as a fresh subshell sourcing the file.
    # No eval. The command's own quoting / substitutions are evaluated
    # by bash exactly as if you'd typed them yourself.
    bash "\$CMD_FILE" > "\$OUT_FILE" 2>&1
    RC=\$?
    cat "\$OUT_FILE"
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
    rm -f "\$OUT_FILE" "\$CMD_FILE"
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
        let status: string;
        if (isLive && !isDone) status = "running";
        else if (isDone && s.exit_code === 0) status = "done";
        else if (isDone) status = `exit-${s.exit_code}`;
        else status = "lost"; // tmux session gone but no completion recorded — crashed or killed
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
    const output = live ? tmuxCapture(params.name, linesWanted) : "";

    const now = Date.now();
    const elapsedMs = (state.completed_at ?? now) - state.started_at;
    let status: string;
    if (live && state.completed_at === undefined) status = "running";
    else if (state.exit_code === 0) status = "done";
    else if (state.exit_code !== undefined) status = `exit-${state.exit_code}`;
    else status = "lost";

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

// ── helpers (exported for tests) ──────────────────────────────────────────

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
        const done = s.completed_at !== undefined;
        const status = live && !done ? "running" : done && s.exit_code === 0 ? "done" : done ? `exit-${s.exit_code}` : "lost";
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
      const ok = await ctx.ui.confirm(`Kill background task ${name}?`, "This terminates the pi -p subprocess immediately.");
      if (!ok) return;
      tmuxKillSession(name);
      ctx.ui.notify(`killed ${name}`, "info");
    },
  });
}
