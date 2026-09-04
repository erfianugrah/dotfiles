#!/usr/bin/env bun
/**
 * secret-output-guard - Claude Code hook. Keeps secret VALUES out of tool
 * results while leaving credential USE untouched (`curl -H "X-API-Key: $KEY"`
 * is the intended pattern; the var NAME in a command is harmless).
 *
 * Mirrors the pi extension (.pi/agent/extensions/secret-output-guard.ts) and
 * shares lib/secret-output-guard-core.ts + lib/secret-registry-core.ts with
 * it - one detection table, two harnesses. The cores are zero-dependency, so
 * this runs identically from the repo checkout or the stowed ~/.claude/hooks/
 * symlink (no node_modules needed).
 *
 * Halves (registered under both events; branches on hook_event_name):
 *
 *   PreToolUse (Bash|Read|Grep|Write|Edit|MultiEdit):
 *     1. DENY wholesale env dumps (`env`, `printenv`, bare `set`, `export -p`,
 *        `declare -x`), Bash only. Same detection as pi's tool_call block.
 *     2. KNOWN-VALUE layer (2026-09-04), fed by `secretctl digests --json`:
 *        - a registered value typed INTO any tool argument (command line,
 *          file body, edit text, URL) -> deny `secret_in_args`;
 *        - Read / Grep / bash cat|head|grep aimed at a registered STORE ->
 *          deny `secret_store_read`; aimed at a file whose content holds a
 *          registered value -> deny `secret_copy_read`.
 *        Nothing reaches the model. Pattern rules cannot tell a bare hex
 *        token from a commit hash; the registry (~/.config/secretctl/sources)
 *        says where the stores are, local and remote, and the digests are
 *        keyed HMACs - never a value.
 *
 *   PostToolUse (Bash|Read|Grep|WebFetch): CC hooks CANNOT mutate tool
 *     results (PostToolUse only appends additionalContext), so pi's redaction
 *     layer has no CC equivalent. Best available: DETECT a live secret value
 *     in the finished tool_response (env values, token formats, and now any
 *     registered value by digest) and raise a rotate-it alarm that names the
 *     var/format/label but never echoes the value or its prefix.
 *
 * Digest cache: a hook is a fresh process per tool call and a full digests
 * pass costs seconds (two ssh round trips on this box), so the JSON is kept
 * at $XDG_RUNTIME_DIR/secret-guard/digests.json (0700 dir, 0600 file, tmpfs)
 * for DIGEST_TTL_MS and refreshed by a detached background secretctl. The
 * file holds salt + digests, no values: the same material pi holds in
 * process memory, in a private RAM-backed file instead. Values shorter than
 * secretctl's --min-len are never in it.
 *
 * Kill switch: SECRET_GUARD_OFF=1 or PI_SECRET_GUARD_OFF=1 (both honored -
 * the pi-side reason advertises the PI_ name, so it must work here).
 * Cache dir override (tests): SECRET_GUARD_CACHE_DIR.
 */

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import {
  collectSensitiveEnv,
  envDumpSegment,
  FORMAT_RULES,
} from "../../.pi/agent/extensions/lib/secret-output-guard-core.ts";
import {
  findKnown,
  holdsKnown,
  holdsKnownReason,
  inputHoldsKnown,
  inputHoldsKnownReason,
  isRegisteredFile,
  parseDigests,
  registeredFileReason,
  toolReadTargets,
  type RegistryDigests,
} from "../../.pi/agent/extensions/lib/secret-registry-core.ts";
import { splitSegments } from "../../.pi/agent/extensions/lib/tool-guard-core.ts";

function deny(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function alarm(context: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    }),
  );
  process.exit(0);
}

const DENY_REASON =
  "wholesale environment dump (`env`/`printenv`/bare `set`/`export -p`) prints EVERY secret in the " +
  "process env into the session transcript. Use credentials by var reference ($NAME) without printing " +
  "them. To check one variable is set: `[ -n \"${NAME+x}\" ] && echo set || echo unset`. " +
  "Kill switch: PI_SECRET_GUARD_OFF=1.";

// ── registry digest cache ───────────────────────────────────────────────────

const DIGEST_TTL_MS = 10 * 60 * 1000;
const MAX_PEEK_BYTES = 16 * 1024 * 1024;

function cacheDir(): string {
  const base = process.env.SECRET_GUARD_CACHE_DIR
    ?? (process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : "/dev/shm");
  return join(base, "secret-guard");
}

/** Run secretctl synchronously and return its JSON (exit 2 = partial, kept). */
function fetchDigests(): string | null {
  try {
    return execFileSync("secretctl", ["digests", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 2 && typeof e.stdout === "string" && e.stdout.trim().startsWith("{")) return e.stdout;
    return null; // secretctl missing, registry missing, or all stores failed
  }
}

/** Detached refresh: writes a temp file then renames, so a reader never sees
 *  a partial JSON. The hook process exits without waiting. */
function refreshInBackground(dir: string): void {
  const target = join(dir, "digests.json");
  const tmp = `${target}.${process.pid}.tmp`;
  const script = `umask 077; if secretctl digests --json > "$1" 2>/dev/null || [ -s "$1" ]; then mv -f "$1" "$2"; else rm -f "$1"; fi`;
  try {
    const child = spawn("sh", ["-c", script, "sh", tmp, target], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // no sh: skip the refresh; the stale cache keeps serving
  }
}

/** The current digest set, or null when the layer is unavailable. */
function digests(): RegistryDigests | null {
  const dir = cacheDir();
  const file = join(dir, "digests.json");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    return null;
  }
  let text: string | null = null;
  let stale = true;
  try {
    const st = statSync(file);
    stale = Date.now() - st.mtimeMs > DIGEST_TTL_MS;
    text = readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  if (text === null) {
    // First use: pay once, synchronously - a tool call must not proceed on
    // an empty registry when one exists.
    text = fetchDigests();
    if (text === null) return null;
    try {
      writeFileSync(file, text, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      // unwritable cache dir: still use this run's digests
    }
  } else if (stale) {
    refreshInBackground(dir);
  }
  try {
    return parseDigests(text);
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function regularFile(p: string, cwd: string): { path: string; size: number } | null {
  try {
    const abs = isAbsolute(p) ? p : pathResolve(cwd, expandHome(p));
    const real = realpathSync(expandHome(abs));
    const st = statSync(real);
    return st.isFile() ? { path: real, size: st.size } : null;
  } catch {
    return null;
  }
}

/** Map Claude Code tool names / inputs onto the shared pi-shaped resolver. */
function ccReadTargets(toolName: string, input: Record<string, unknown>): string[] {
  switch (toolName) {
    case "Read":
      return toolReadTargets("read", { path: input.file_path ?? input.path }, splitSegments);
    case "Grep":
      return toolReadTargets("grep", { path: input.path }, splitSegments);
    case "Bash":
      return toolReadTargets("bash", { command: input.command }, splitSegments);
  }
  return [];
}

async function main() {
  if (process.env.SECRET_GUARD_OFF === "1" || process.env.PI_SECRET_GUARD_OFF === "1") {
    process.exit(0);
  }

  const raw = await Bun.stdin.text();
  let payload: {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    tool_result?: unknown;
    cwd?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable payload - not our concern; let the call proceed
  }

  const isPost =
    payload.hook_event_name === "PostToolUse" ||
    (payload.hook_event_name === undefined && payload.tool_response !== undefined);
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd ?? process.cwd();

  if (!isPost) {
    // ── PreToolUse 1: deny wholesale env dumps (Bash only) ──
    if (tool === "Bash") {
      const command = String(input.command ?? "");
      const hit = command ? envDumpSegment(splitSegments(command)) : null;
      if (hit) deny(`secret-output-guard: blocked \`${hit}\` - ${DENY_REASON}`);
    }

    // ── PreToolUse 2: known-value layer ──
    const d = digests();
    if (!d) process.exit(0);

    const typed = inputHoldsKnown(input, d);
    if (typed.length > 0) deny(inputHoldsKnownReason(tool, typed, typed.every((h) => h.assembled)));

    for (const t of ccReadTargets(tool, input)) {
      const f = regularFile(t, cwd);
      if (!f) continue;
      if (isRegisteredFile(f.path, d)) {
        const label = [...d.byHex.values()].find((e) => e.label.includes(f.path.replace(homedir(), "~")))?.label
          ?? "registered store";
        deny(registeredFileReason(t, label.replace(/#.*$/, "")));
      }
      if (f.size <= MAX_PEEK_BYTES) {
        let content: string;
        try {
          content = readFileSync(f.path, "utf8");
        } catch {
          continue;
        }
        const hits = holdsKnown(content, d);
        if (hits.length > 0) deny(holdsKnownReason(t, hits));
      }
    }
    process.exit(0);
  }

  // ── PostToolUse: leak alarm (detection only - CC cannot redact) ──
  const resp = payload.tool_response ?? payload.tool_result;
  if (resp === undefined || resp === null) process.exit(0);
  const text = typeof resp === "string" ? resp : JSON.stringify(resp);
  if (!text) process.exit(0);

  const labels: string[] = [];
  for (const { name, value } of collectSensitiveEnv(
    process.env as Record<string, string | undefined>,
  )) {
    if (text.includes(value)) labels.push(`env:${name}`);
  }
  for (const rule of FORMAT_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) labels.push(`format:${rule.id}`);
  }
  const d = digests();
  if (d) {
    for (const hit of findKnown(text, d)) labels.push(`registry:${hit.entry.label}`);
  }
  if (labels.length === 0) process.exit(0);

  alarm(
    `secret-output-guard ALARM: this tool result contained live secret value(s): ${[...new Set(labels)].join(", ")}. ` +
      `Claude Code hooks cannot redact tool output - the value IS now in the session transcript. ` +
      `Treat the credential as compromised: tell the user it should be rotated, and do not print it again ` +
      `(reference it by env-var name or file path only).`,
  );
}

main();
