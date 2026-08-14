/**
 * powershell - run a PowerShell script via pwsh, locally or on a remote host
 * over SSH, and return trimmed output.
 *
 * Raw `bash pwsh -Command '...'` forces the agent to fight two layers of
 * shell quoting (bash -> pwsh) and dumps full object formatting into context.
 * This wrapper feeds the script to pwsh on stdin (`-Command -`) so NO quoting
 * happens, caps each stream with head+tail elision, and surfaces exit code /
 * stderr as compact signals.
 *
 * Remote mode (`host`) wraps the same stdin pipe in `ssh -- <host> pwsh ...`,
 * which is how commands run on the Windows laptop (LAPTOP-I002E42Q) once its
 * OpenSSH Server is up - see the powershell skill for the setup.
 *
 * Requires the `pwsh` binary locally (paru -S powershell-bin) and, for remote,
 * pwsh on the remote user's PATH.
 *
 * Pure logic lives in ./lib/pwsh-core.ts; this file is the thin pi adapter.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPwshTool } from "./lib/pwsh-core.ts";

export { buildArgs, buildCommand, capStream, renderPwshResult } from "./lib/pwsh-core.ts";

const powershellTool = defineTool({
  name: "powershell",
  label: "PowerShell",
  promptSnippet: "powershell - run a pwsh script locally or on a remote host over SSH, trimmed output. Use instead of bash pwsh.",
  promptGuidelines: [
    "Pass the script as `script`; it is fed to pwsh on stdin, so never wrap it in quotes and never invoke pwsh yourself via bash.",
    "Pass `host` (an ssh alias) to run on a remote machine, e.g. the Windows laptop. The remote needs pwsh on PATH.",
    "PowerShell emits objects: end pipelines with `| ConvertTo-Json -Compress` or `| Format-Table -AutoSize | Out-String` for compact, parseable output.",
    "Non-zero exit OR any stderr marks the result as an error; PowerShell non-terminating errors go to stderr without failing the exit code.",
  ],
  description: [
    "Run a PowerShell (pwsh) script and return capped stdout/stderr + exit code.",
    "",
    "Local by default. Pass `host` to execute on a remote machine over SSH",
    "(`ssh -- <host> pwsh -Command -`; the script travels on stdin, so no",
    "quoting issues). Use for Windows administration, .ps1 scripts, and",
    "PowerShell-specific cmdlets (Get-WinEvent, Get-CimInstance, etc.).",
  ].join("\n"),
  parameters: Type.Object({
    script: Type.String({
      description: "PowerShell script to execute. Fed to pwsh on stdin - do not add surrounding quotes.",
    }),
    host: Type.Optional(
      Type.String({
        description: "SSH host alias to run the script on remotely (e.g. a Windows machine with OpenSSH Server + pwsh). Omit for local.",
      }),
    ),
    timeoutSec: Type.Optional(
      Type.Number({ description: "Timeout in seconds (default 120, max 600)." }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const { text, details, isError } = await runPwshTool({
      script: params.script,
      host: params.host,
      timeoutSec: params.timeoutSec,
    });
    return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(powershellTool);
}
