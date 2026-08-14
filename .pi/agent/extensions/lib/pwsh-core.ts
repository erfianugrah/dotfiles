/**
 * pwsh-core - run a PowerShell script locally or on a remote host over SSH,
 * return a compact result. Shared core for the pi `powershell` tool adapter
 * (../powershell.ts); pure helpers are unit-tested, spawn path is not.
 *
 * Transport: the script is ALWAYS fed to pwsh on stdin via `-Command -`, so
 * no shell quoting ever happens - locally (`pwsh ... -Command -`) or remotely
 * (`ssh <host> pwsh ... -Command -`, ssh passes stdin through). This is what
 * makes remote execution safe against the script containing quotes, $vars,
 * backticks, etc.
 *
 * Remote requires the target to have pwsh on PATH for the SSH user (on
 * Windows: install PowerShell 7 + OpenSSH Server; see the powershell skill).
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on EACH of stdout/stderr before render; middle is elided. */
const MAX_STREAM_CHARS = 40_000;

export interface PwshRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  binaryMissing: boolean;
  timedOut: boolean;
}

/** argv after the program name. `-Command -` = read the script from stdin. */
export function buildArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", "-"];
}

/** Program + argv for a local run, or wrapped in ssh for a remote host. */
export function buildCommand(host?: string): { program: string; args: string[] } {
  const pwshArgs = buildArgs();
  if (host) {
    // -- ends ssh option parsing so a host alias starting with '-' can't be
    // read as a flag; pwsh must be on the remote user's PATH.
    return { program: "ssh", args: ["--", host, "pwsh", ...pwshArgs] };
  }
  return { program: "pwsh", args: pwshArgs };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|\(.)/g;

/** pwsh emits ANSI (colors, DEC private modes) even when piped; strip it. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Cap a stream to maxChars, keeping head + tail and eliding the middle.
 * Agents need the start (headers/context) and the end (errors/result rows);
 * the middle of a huge dump is the least useful part. ANSI is stripped first.
 */
export function capStream(text: string, maxChars: number = MAX_STREAM_CHARS): string {
  text = stripAnsi(text);
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n... [elided ${elided} chars] ...\n${text.slice(text.length - tail)}`;
}

export interface PwshResult {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
}

/** Render a finished run into the tool's text payload. */
export function renderPwshResult(run: PwshRun, host?: string): PwshResult {
  const where = host ? ` on ${host}` : "";
  if (run.timedOut) {
    return {
      isError: true,
      text: `pwsh${where} timed out; process killed. Partial output:\n${capStream(run.stdout)}\n${capStream(run.stderr)}`.trim(),
      details: { error: "timeout", host, code: run.code },
    };
  }
  const stdout = capStream(run.stdout).trimEnd();
  const stderr = capStream(run.stderr).trim();
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (run.code !== 0) parts.push(`[exit ${run.code}]`);
  if (parts.length === 0) parts.push("(no output)");
  return {
    // pwsh writes non-terminating errors to stderr without failing the exit
    // code, so surface isError on either signal.
    ...(run.code !== 0 || stderr ? { isError: true } : {}),
    text: parts.join("\n\n"),
    details: { host, code: run.code, stdoutChars: run.stdout.length, stderrChars: run.stderr.length },
  };
}

export async function runPwsh(opts: {
  script: string;
  host?: string;
  timeoutMs?: number;
}): Promise<PwshRun> {
  const { program, args } = buildCommand(opts.host);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const proc = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb", POWERSHELL_TELEMETRY_OPTOUT: "1" },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    proc.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      const what = opts.host ? `ssh (or it could not reach ${opts.host})` : "pwsh";
      resolve({ ok: false, stdout: "", stderr: `${what} not on PATH`, code: 127, binaryMissing: true, timedOut: false });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code: timedOut ? -1 : (code ?? 1),
        binaryMissing: false,
        timedOut,
      });
    });
    proc.stdin.on("error", () => {
      /* EPIPE if pwsh dies before reading stdin; close handler reports it */
    });
    proc.stdin.write(opts.script);
    proc.stdin.end();
  });
}

export async function runPwshTool(opts: {
  script: string;
  host?: string;
  timeoutSec?: number;
}): Promise<PwshResult> {
  if (!opts.script.trim()) {
    return { isError: true, text: "Empty script.", details: { error: "empty-script" } };
  }
  const timeoutMs = opts.timeoutSec == null ? DEFAULT_TIMEOUT_MS : Math.min(Math.max(opts.timeoutSec, 1), 600) * 1000;
  const run = await runPwsh({ script: opts.script, host: opts.host, timeoutMs });
  if (run.binaryMissing) {
    const text = opts.host
      ? `ssh not on PATH locally, or the host could not be spawned. Check \`ssh ${opts.host} echo ok\`.`
      : "pwsh not on PATH. Install: `paru -S powershell-bin` (Arch) or see https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux";
    return { isError: true, text, details: { error: "binary-missing", host: opts.host } };
  }
  return renderPwshResult(run, opts.host);
}
