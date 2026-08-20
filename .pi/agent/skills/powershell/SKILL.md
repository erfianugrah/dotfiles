---
name: powershell
description: Use when running or writing PowerShell (pwsh) scripts from pi, touching the Windows host of this WSL2 dev box (ERFI1, the 5090 desktop - filesystem via /mnt/c, binaries via WSL interop), hardware/event-log checks on Windows (Get-CimInstance/Get-WinEvent), or answering PowerShell syntax questions. Fires on 'pwsh', 'powershell', '.ps1', 'Get-WinEvent', 'Get-CimInstance', 'PSRemoting', 'check the Windows side'. NOT for bash scripting or Windows-app GUI troubleshooting with no shell component.
---

# PowerShell

## Overview

pi has a `powershell` tool that runs a script through pwsh and returns capped,
ANSI-stripped output. The script travels to pwsh **on stdin** (`-Command -`),
so there is never a quoting layer to fight - paste the script as-is.

Local pwsh: 7.6.4 at `~/.local/bin/pwsh` (tarball install in
`~/.local/share/pwsh`, no sudo; re-run the tarball steps to upgrade).
Full docs source: `/docs/powershell/` (1110 files) - route syntax/cmdlet
questions there with `docs_search`/`docs_grep`, source `powershell`.

## The tool

```
powershell({ script: "Get-Process | Select -First 5 Name,Id | ConvertTo-Json -Compress" })
powershell({ script: "...", host: "somehost" })      # remote over SSH (alias in ~/.ssh/config)
powershell({ script: "...", timeoutSec: 300 })        # default 120, max 600
```

- stderr OR non-zero exit marks the result an error. PowerShell
  **non-terminating errors go to stderr without failing the exit code** -
  a green exit does not mean clean.
- Output is objects, not text. End pipelines with
  `| ConvertTo-Json -Compress` (machine-readable, preferred) or
  `| Format-Table -AutoSize | Out-String` (human table). A bare cmdlet dumps
  a multi-line property list per object - context poison.
- Never `bash pwsh -Command '...'` - that reintroduces the bash->pwsh quoting
  problem the tool exists to avoid.

## The Windows host: ERFI1 (this WSL2 instance lives on it)

pi runs in WSL2 (`*-microsoft-standard-WSL2` kernel) on the user's 5090 dev
desktop - hostname **ERFI1**, Windows 10 Pro (build 19045), AMD Ryzen 7
7800X3D, 64 GB RAM, RTX 5090, ASUS custom build (this is the llm-compose
box). **You are already ON it** - no SSH, no remoting:

- Windows filesystem: `/mnt/c/Users/Erfi Anugrah/...` (Downloads, Desktop,
  etc. are directly readable/writable with normal bash tools).
- Windows-side PowerShell via WSL interop: `powershell.exe` (5.1) is on PATH.
  `pwsh.exe` is NOT on the interop path - invoke by full path
  (`"/mnt/c/Program Files/PowerShell/7/pwsh.exe"` if installed). The
  `powershell` TOOL always runs Linux pwsh - for Windows-side execution use
  `bash` with the .exe, e.g. hardware/event checks:
  `powershell.exe -NoProfile -Command "Get-CimInstance Win32_VideoController | Select Name,DriverVersion"`
- Interop output is UTF-16-ish/CRLF; pipe through `tr -d '\r'` when parsing.
- Any Windows binary on the interop path can be launched the same way
  (both directions work). For hardware/system inventory prefer
  `Get-CimInstance` over asking the user to run dxdiag.

If SSH access FROM another machine into ERFI1's Windows side is ever needed:
OpenSSH Server is an optional capability (elevated pwsh on Windows:
`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`,
`Set-Service sshd -StartupType Automatic; Start-Service sshd`). Windows 10
Pro also has full WinRM/PSRemoting, unlike Home. But for anything reachable
from WSL2, interop + /mnt/c is simpler.

## Bash-native gotchas (quick reference)

| Bash instinct | PowerShell |
|---|---|
| `a = b`, `==` | `-eq`, `-ne`, `-gt`, `-like`, `-match` (case-insensitive by default) |
| `$?` exit code | `$?` is a **boolean**; native exit code is `$LASTEXITCODE` |
| `export X=1` / `$X` | `$env:X = '1'` / `$env:X` |
| pipe text, `grep`/`awk` | pipe **objects**: `... \| Where-Object {$_.Id -eq 4} \| Select-Object Name` |
| `$_` unused | `$_` = current pipeline object |
| `&&` / `||` | work in pwsh 7+ (7.0 added them) |
| `\` line continuation | backtick `` ` `` (or just break after `\|`) |
| `ls`, `cat`, `ps` | on Windows these are aliases to Get-ChildItem/Get-Content/Get-Process; **on Linux pwsh they call the native binaries** - behavior differs per OS |
| single vs double quotes | single = literal, double = expands `$var`; escape char is backtick |

Scripts: save as `.ps1`, run with `powershell({ script: ". ./foo.ps1" })` or
paste the body directly. PSScriptAnalyzer (`Install-Module PSScriptAnalyzer`)
is the linter; Pester is the test framework.

## Windows debug recipes (run via `powershell.exe` interop from WSL2)

```powershell
# Bugcheck reports (WER 1001) - what stop code crashed it
Get-WinEvent -FilterHashtable @{LogName='System'; ID=1001} -MaxEvents 5 |
  Where-Object {$_.ProviderName -eq 'Microsoft-Windows-WER-SystemErrorReporting'} |
  Format-List TimeCreated, Message

# Kernel-Power 41 = hard power-off/reboot without clean shutdown
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; ID=41} -MaxEvents 10 |
  Select-Object TimeCreated, Message | Format-List

# NHI 9003 = RTD3 flap canary (any in last 24h of idle = regression)
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; ID=9003} -MaxEvents 20 |
  Select-Object TimeCreated, Message | Format-List

# Everything from the last 30 min, sorted
$cut = (Get-Date).AddMinutes(-30)
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$cut} |
  Sort-Object TimeCreated | Format-Table TimeCreated, Id, ProviderName, Message -AutoSize | Out-String
```

`Get-WinEvent -FilterHashtable` is the fast path - filtering happens in the
event service, not in the pipeline. Filtering with `Where-Object` after a
bare `Get-WinEvent` reads the whole log.
