#!/usr/bin/env bun
/**
 * memledger-seed - Claude Code Stop hook. Fires after each assistant turn and
 * pushes the live session jsonl into memledger via the CLI's single-file fast
 * path (`memledger sync --file <transcript> --file-source claude`), so the
 * session is searchable within seconds - no systemd timer in the loop.
 *
 * Mirrors the pi memledger-seed extension's turn_end fast path
 * (.pi/agent/extensions/memledger-seed.ts). The CC Stop hook payload is
 * {session_id, transcript_path, stop_hook_active, ...}; we read transcript_path
 * and fire-and-forget the sync. A Stop hook produces no hookSpecificOutput -
 * a clean exit 0 is the contract (same as notify.ts).
 *
 * Rate-limit: hooks are stateless processes, so a state file in tmpdir keyed
 * by session_id records the last-fire timestamp; at most one sync per
 * MEMLEDGER_SEED_MIN_MS (default 10s), mirroring pi's SeedThrottle. Offset
 * checkpointing makes skipped turns harmless - the next fire catches up, and
 * the 5-min systemd timer remains the belt-and-braces backstop.
 *
 * Kill switch: MEMLEDGER_SEED_OFF=1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const MIN_INTERVAL_MS =
  Number(process.env.MEMLEDGER_SEED_MIN_MS) || 10_000;

function memledgerBin(): string {
  const home = process.env.HOME || "";
  const local = home ? join(home, "bin", "memledger") : "";
  return local && existsSync(local) ? local : "memledger"; // PATH fallback
}

function stateFile(sessionId: string): string {
  const dir = join(tmpdir(), "cc-memledger-seed");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha1").update(sessionId).digest("hex").slice(0, 16);
  return join(dir, `${key}.json`);
}

function throttleAllows(file: string): boolean {
  const now = Date.now();
  let last = Number.NEGATIVE_INFINITY;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { last?: number };
    last = Number(parsed?.last);
  } catch {
    // no state file yet: first fire
  }
  if (Number.isFinite(last) && now - last < MIN_INTERVAL_MS) {
    return false;
  }
  try {
    writeFileSync(file, JSON.stringify({ last: now }));
  } catch {
    // best-effort: throttle state is advisory
  }
  return true;
}

async function main() {
  if (process.env.MEMLEDGER_SEED_OFF === "1") process.exit(0);

  const raw = await Bun.stdin.text();
  let payload: { transcript_path?: string; session_id?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // not a payload we understand
  }

  const path = payload.transcript_path;
  if (!path || !path.endsWith(".jsonl")) process.exit(0);

  const id = payload.session_id || path;
  if (!throttleAllows(stateFile(id))) process.exit(0);

  // Fire-and-forget: detached + unref so the child outlives the hook and never
  // blocks CC's UI. The CLI auto-loads ~/.config/memledger/env itself.
  const child = spawn(
    memledgerBin(),
    ["sync", "--file", path, "--file-source", "claude"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  process.exit(0);
}

await main();
