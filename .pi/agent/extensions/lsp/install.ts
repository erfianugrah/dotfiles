/**
 * Auto-install LSP servers on first use.
 *
 * Mirrors opencode's `Npm.which` + per-server install logic but Pi-flavored:
 * we shell out to the user's existing package managers (bun, go, cargo,
 * rustup, paru) rather than embedding `@npmcli/arborist`. Trade-off: opencode
 * gets isolated per-package node_modules cache; we get a 60-line install
 * helper that "just works" with binaries the user can also use outside Pi.
 *
 * Install destinations (all should already be on PATH for typical Arch setup):
 *   - bun-global  → ~/.bun/install/global/node_modules/.bin/   (PATH: ~/.bun/bin)
 *   - go-install  → $GOPATH/bin or ~/go/bin                    (PATH: ~/go/bin)
 *   - cargo       → ~/.cargo/bin                               (PATH: ~/.cargo/bin)
 *   - rustup      → ~/.rustup/.../bin                          (PATH: ~/.cargo/bin via shim)
 *   - manual      → tell the model to install via `paru -S` or similar
 *
 * Concurrency: a single LspClient construction is synchronous (in the sense
 * that ensureInstalled completes before the spawn). If two parallel tool calls
 * land on the same uninstalled server, we serialize via an in-memory promise
 * cache so we don't run two `bun add` invocations in parallel.
 */

import { spawn } from "child_process";
import { existsSync, statSync } from "fs";

export type InstallSpec =
  | { type: "bun-global"; pkg: string }
  | { type: "go-install"; module: string }
  | { type: "cargo-install"; crate: string; features?: string[] }
  | { type: "rustup-component"; component: string }
  | { type: "manual"; hint: string };

/** In-flight install promises, keyed by binary name. */
const installLocks = new Map<string, Promise<string | null>>();

export function isExecutableOnPath(name: string): boolean {
  // Bun.which is the cheapest path on Bun
  const bunWhich = (globalThis as { Bun?: { which: (n: string) => string | null } }).Bun?.which;
  if (bunWhich) return bunWhich(name) !== null;

  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const full = `${dir}/${name}`;
    try {
      if (existsSync(full) && statSync(full).isFile()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Resolve a binary path: check PATH first, return immediately if installed.
 * Otherwise run the install spec and re-check. Returns the binary name (which
 * the spawn() call will then resolve via PATH again) or null + a reason.
 */
export async function ensureInstalled(
  binaryName: string,
  spec?: InstallSpec,
): Promise<{ ok: true; bin: string } | { ok: false; reason: string }> {
  if (isExecutableOnPath(binaryName)) {
    return { ok: true, bin: binaryName };
  }

  if (!spec) {
    return { ok: false, reason: `${binaryName} not on PATH and no install spec configured` };
  }

  // Serialize parallel installs of the same binary
  if (!installLocks.has(binaryName)) {
    installLocks.set(binaryName, runInstall(binaryName, spec));
  }
  const path = await installLocks.get(binaryName)!;
  installLocks.delete(binaryName);

  if (!path) {
    return { ok: false, reason: `install failed for ${binaryName} (see Pi log for details)` };
  }
  if (!isExecutableOnPath(binaryName)) {
    return {
      ok: false,
      reason: `${binaryName} installed but not on PATH — check that ~/.bun/bin, ~/go/bin, ~/.cargo/bin are exported`,
    };
  }
  return { ok: true, bin: binaryName };
}

async function runInstall(binaryName: string, spec: InstallSpec): Promise<string | null> {
  let cmd: string;
  let args: string[];

  switch (spec.type) {
    case "bun-global":
      cmd = "bun";
      args = ["add", "-g", spec.pkg];
      break;
    case "go-install":
      cmd = "go";
      args = ["install", spec.module];
      break;
    case "cargo-install":
      cmd = "cargo";
      args = ["install", spec.crate];
      if (spec.features?.length) {
        args.push("--features", spec.features.join(","));
      }
      break;
    case "rustup-component":
      cmd = "rustup";
      args = ["component", "add", spec.component];
      break;
    case "manual":
      process.stderr.write(`[lsp] ${binaryName} not installed. ${spec.hint}\n`);
      return null;
  }

  if (!isExecutableOnPath(cmd)) {
    process.stderr.write(`[lsp] cannot auto-install ${binaryName}: ${cmd} not on PATH\n`);
    return null;
  }

  process.stderr.write(`[lsp] installing ${binaryName} via ${cmd} ${args.join(" ")} ...\n`);
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => stderr.push(d));
    proc.stdout.on("data", () => {
      // discard stdout; npm progress is noisy
    });
    proc.on("close", (code) => {
      if (code === 0) {
        process.stderr.write(`[lsp] installed ${binaryName}\n`);
        resolve(binaryName);
      } else {
        process.stderr.write(
          `[lsp] install failed for ${binaryName} (exit ${code}):\n${Buffer.concat(stderr).toString("utf-8").slice(0, 500)}\n`,
        );
        resolve(null);
      }
    });
    proc.on("error", (err) => {
      process.stderr.write(`[lsp] install spawn error for ${binaryName}: ${err.message}\n`);
      resolve(null);
    });
  });
}
