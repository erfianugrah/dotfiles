/**
 * notify — desktop ping when the agent finishes a turn.
 *
 * Sends a native terminal notification on `agent_end` so you can context-switch
 * during long runs and get pulled back when input is needed.
 *
 * Protocol selection:
 *   - WT_SESSION env       → Windows toast (PowerShell)
 *   - KITTY_WINDOW_ID env  → OSC 99 (Kitty)
 *   - else                 → OSC 777 (WezTerm, Ghostty, iTerm2, rxvt-unicode)
 *
 * Caveat: this user runs inside tmux (TERM_PROGRAM=tmux). Tmux strips
 * unknown OSC sequences by default. If notifications don't appear, enable
 * passthrough in ~/.tmux.conf:
 *
 *   set -g allow-passthrough on
 *
 * or upgrade to tmux 3.3+ which permits OSC 777 through wrapped DCS.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── transport ─────────────────────────────────────────────────────────────

function windowsToastScript(title: string, body: string): string {
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

function osc777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function osc99(title: string, body: string): void {
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function windowsToast(title: string, body: string): void {
  const { execFile } = require("node:child_process");
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
  // Non-TTY stdout means we're inside `pi -p --mode json` (e.g. spawned by the
  // task tool). Writing OSC sequences there corrupts the JSON event stream
  // — OSC 777 ends with BEL (\x07) and OSC 99 with ST (\x1b\\), neither of
  // which is \n, so the bytes land mid-line and break JSON.parse upstream.
  // Skip the notification rather than pollute the stream.
  // Windows toast doesn't write to stdout so it's safe regardless.
  if (process.env.WT_SESSION) {
    windowsToast(title, body);
    return;
  }
  if (!process.stdout.isTTY) return;
  if (process.env.KITTY_WINDOW_ID) osc99(title, body);
  else osc777(title, body);
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    notify("pi", "ready for input");
  });
}
