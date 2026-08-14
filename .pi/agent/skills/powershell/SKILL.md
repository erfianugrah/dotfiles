---
name: powershell
description: Use when running or writing PowerShell (pwsh) scripts from pi, checking Windows machines (the LAPTOP-I002E42Q debugging work - bugcheck/Kernel-Power 41/RTD3), administering Windows over SSH/PSRemoting, or answering PowerShell syntax questions. Fires on 'pwsh', 'powershell', '.ps1', 'Get-WinEvent', 'Get-CimInstance', 'PSRemoting', 'run this on the Windows laptop'. NOT for bash scripting or Windows-app GUI troubleshooting with no shell component.
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
powershell({ script: "...", host: "laplaptop" })      # remote over SSH
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

## Remote: the Windows laptop (LAPTOP-I002E42Q)

ASUS ROG 2022 (Ryzen 6000), Windows 11 Home 25H2. Recurring debugging target
(Kernel-Power 41 crashes, AX210 wifi, RTD3/NHI 9003). Today commands get
**pasted into an interactive session by the user** - there is no SSH route.
To set one up (all on the laptop, elevated pwsh):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic; Start-Service sshd
# default shell -> pwsh (optional, nice for interactive ssh):
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Program Files\PowerShell\7\pwsh.exe" -PropertyType String -Force
```

Then add an ssh alias locally (`Host laplaptop` -> its IP, user) and
`powershell({ script, host: "laplaptop" })` works - the tool runs
`ssh -- laplaptop pwsh -NoProfile -NonInteractive -Command -`.

Notes:
- **WinRM-based PSRemoting is not available on Windows Home** - SSH is the
  only remoting path. (`Enter-PSSession -HostName` works too once the
  `powershell` subsystem is in sshd_config; see
  /docs/powershell/docs-conceptual/security/remoting/SSH-Remoting-in-PowerShell.md)
- Windows 11 Home ships OpenSSH Server as an optional capability (above);
  pwsh 7 itself must be installed separately (winget install Microsoft.PowerShell).

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

## Windows debug recipes (proven on the laptop)

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
