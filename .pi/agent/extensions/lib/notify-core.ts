/**
 * notify-core - pure desktop-notification protocol selection + byte building.
 * ZERO harness imports (node stdlib only; no child_process side effects here).
 *
 * Source of truth for both the pi adapter (../notify.ts, fires on `agent_end`)
 * and the Claude Code Stop hook (../../../.claude/hooks/notify.ts, fires on the
 * `Stop` event). One protocol table, two harnesses.
 *
 * The pure layer decides WHICH transport to use and produces the exact bytes /
 * argv to emit; the thin harness shells actually write to stdout or spawn the
 * PowerShell toast. That split keeps the tmux/OSC/Windows-toast logic testable
 * without a TTY or a subprocess.
 *
 * Protocol selection (mirrors the original pi extension):
 *   - WT_SESSION env       -> Windows toast (PowerShell)
 *   - non-TTY stdout       -> skip (writing OSC bytes corrupts a JSON event
 *                             stream: OSC 777 ends with BEL \x07, OSC 99 with
 *                             ST \x1b\\, neither is \n, so bytes land mid-line
 *                             and break JSON.parse upstream)
 *   - KITTY_WINDOW_ID env  -> OSC 99 (Kitty)
 *   - else                 -> OSC 777 (WezTerm, Ghostty, iTerm2, rxvt-unicode)
 *
 * Caveat (documented, not enforced here): under tmux (TERM_PROGRAM=tmux) the
 * OSC sequences need `set -g allow-passthrough on` in ~/.tmux.conf, or tmux
 * 3.3+ which permits OSC 777 through wrapped DCS.
 */

// -- transport kinds ---------------------------------------------------------

export type Transport = "windows-toast" | "osc99" | "osc777" | "skip";

export interface NotifyEnv {
  /** Windows Terminal session id; presence -> Windows toast path. */
  WT_SESSION?: string | undefined;
  /** Kitty window id; presence (on a TTY) -> OSC 99 path. */
  KITTY_WINDOW_ID?: string | undefined;
  /** Whether stdout is a real terminal. Non-TTY -> skip (protect JSON stream). */
  isTTY?: boolean | undefined;
}

/**
 * Decide which transport to use for a given environment. Pure: no I/O.
 *
 * Windows toast is selected first because it does NOT write to stdout, so it is
 * safe even in a non-TTY / piped context. Every stdout-writing transport is
 * gated behind isTTY to avoid corrupting a JSON event stream.
 */
export function selectTransport(env: NotifyEnv): Transport {
  if (env.WT_SESSION) return "windows-toast";
  if (!env.isTTY) return "skip";
  if (env.KITTY_WINDOW_ID) return "osc99";
  return "osc777";
}

// -- byte builders (pure) ----------------------------------------------------

/** OSC 777 desktop-notification sequence (WezTerm/Ghostty/iTerm2/urxvt). */
export function osc777Bytes(title: string, body: string): string {
  return `\x1b]777;notify;${title};${body}\x07`;
}

/** OSC 99 desktop-notification sequence (Kitty), title then body chunk. */
export function osc99Bytes(title: string, body: string): string {
  return `\x1b]99;i=1:d=0;${title}\x1b\\` + `\x1b]99;i=1:p=body;${body}\x1b\\`;
}

/**
 * The PowerShell one-liner that raises a Windows toast. Returned as data so the
 * harness can pass it to execFile("powershell.exe", ["-NoProfile","-Command", ...]).
 */
export function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
}

// -- orchestrator (pure plan; harness executes it) ---------------------------

export interface NotifyPlan {
  transport: Transport;
  /** Bytes to write to stdout for OSC transports; undefined otherwise. */
  stdout?: string;
  /** argv to spawn for the Windows toast path; undefined otherwise. */
  spawn?: { file: string; args: string[] };
}

/**
 * Harness-agnostic orchestrator: resolve the transport for `env` and produce a
 * fully-formed plan (bytes to write and/or process to spawn). The harness shell
 * only has to carry out the plan - no branching logic leaks into either adapter.
 */
export function planNotify(title: string, body: string, env: NotifyEnv): NotifyPlan {
  const transport = selectTransport(env);
  switch (transport) {
    case "osc777":
      return { transport, stdout: osc777Bytes(title, body) };
    case "osc99":
      return { transport, stdout: osc99Bytes(title, body) };
    case "windows-toast":
      return {
        transport,
        spawn: {
          file: "powershell.exe",
          args: ["-NoProfile", "-Command", windowsToastScript(title, body)],
        },
      };
    case "skip":
    default:
      return { transport: "skip" };
  }
}

/** Read the relevant env into a NotifyEnv (convenience for adapters). */
export function envFromProcess(proc: NodeJS.Process = process): NotifyEnv {
  return {
    WT_SESSION: proc.env.WT_SESSION,
    KITTY_WINDOW_ID: proc.env.KITTY_WINDOW_ID,
    isTTY: Boolean(proc.stdout?.isTTY),
  };
}
