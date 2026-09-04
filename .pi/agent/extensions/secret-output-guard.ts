/**
 * secret-output-guard - keep secret VALUES out of tool results, without
 * getting in the way of USING them.
 *
 * Motivating incident (2026-08-13): `env | grep -i composer` put the full
 * COMPOSER_API_KEY into the transcript. The user-facing principle: the
 * agent runs commands WITH the creds ($VAR references, files it never
 * prints), but must never SEE the value. So:
 *
 *   tool_call  (bash only): block wholesale env dumps (env / printenv /
 *              bare set / export -p / declare -x). Nothing else is blocked
 *              - `curl -H "X-API-Key: $KEY" ...` is the intended pattern.
 *   tool_result (ALL tools): redact occurrences of (a) values of
 *              sensitive-named vars in pi's own process env, (b) known
 *              token formats (ghp_, AKIA, sk-, JWT, PEM blocks, ...) that
 *              may be read from files. Detection logic lives in
 *              ./lib/secret-output-guard-core.ts.
 *
 * The redaction runs on every tool result (bash, read, grep, webfetch,
 * extension tools - all of them); a secret read from a file via `read` is
 * exactly as leaked as one printed by bash. Masked form keeps an 8-char
 * prefix + the var/format name so the agent can still tell WHICH secret
 * was involved ("which key did curl send?") without the usable value
 * entering context, the session .jsonl, or the synced memledger store.
 *
 * The env snapshot is taken lazily on first result and refreshed when the
 * process env changes size (cheap re-collect; covers a mid-session
 * `bw unlock` exporting new vars into a restarted pi, not a running one -
 * pi's env is fixed at launch).
 *
 * Third layer (2026-09-04) - KNOWN VALUES via secretctl's registry. Incident:
 * the `grep` tool printed `MEMLEDGER_TOKEN=<48 hex>` from ~/.config/memledger/
 * env; the var is not in pi's env and bare hex has no format, so neither
 * detector above could fire, and gitleaks / trufflehog / noseyparker missed
 * the line too. Patterns cannot tell a token from a commit hash; the registry
 * (~/.config/secretctl/sources) says where the stores ARE, and
 * `secretctl digests --json` hands this process a keyed HMAC per value plus
 * the session salt - never a value. Then:
 *
 *   tool_call  (read / grep / bash cat|head|grep ...): the target file is a
 *              registered store -> block; else its content holds a registered
 *              value (tokenised HMAC match) -> block. Nothing reaches the model.
 *   tool_result (ALL tools): tokenise, HMAC, mask any registered value that
 *              still made it into output (a grep over a directory, curl -v,
 *              docker inspect). Logic: ./lib/secret-registry-core.ts.
 *   tool_call  (ANY tool): a registered value typed INTO an argument -> block.
 *   message_end (assistant + user): mask registered values in the finalized
 *              message before it is persisted / synced / replayed as context.
 *
 * The digest set is loaded lazily on first use, refreshed every
 * REGISTRY_TTL_MS and after any bash command mentioning `secretctl set` (a
 * rotation changes the values). If secretctl or the registry is missing the
 * layer is off and says so once; the two older layers keep running.
 *
 * Kill switch: PI_SECRET_GUARD_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { splitSegments } from "./lib/tool-guard-core.ts";
import {
  collectSensitiveEnv,
  ENV_DUMP_REASON,
  envDumpSegment,
  PLAINTEXT_PIPELINE_REASON,
  plaintextPipelineSegment,
  redactSecrets,
  type EnvSecret,
} from "./lib/secret-output-guard-core.ts";
import {
  holdsKnown,
  holdsKnownReason,
  inputHoldsKnown,
  inputHoldsKnownReason,
  isRegisteredFile,
  parseDigests,
  redactContent,
  redactKnown,
  registeredFileReason,
  toolReadTargets,
  type ContentBlock,
  type RegistryDigests,
} from "./lib/secret-registry-core.ts";

// Re-exports for the unit suite.
export {
  collectSensitiveEnv,
  envDumpSegment,
  plaintextPipelineSegment,
  redactSecrets,
};

interface ToolResultContent {
  type: string;
  text?: string;
}

let cachedSecrets: EnvSecret[] | null = null;
let cachedEnvSize = -1;

function secrets(): EnvSecret[] {
  const size = Object.keys(process.env).length;
  if (!cachedSecrets || size !== cachedEnvSize) {
    cachedSecrets = collectSensitiveEnv(
      process.env as Record<string, string | undefined>,
    );
    cachedEnvSize = size;
  }
  return cachedSecrets;
}

// ── registry (known-value) layer ────────────────────────────────────────────

const REGISTRY_TTL_MS = 10 * 60 * 1000;
/** Files above this are not content-checked (the read tool would truncate
 *  them anyway); registered-path blocking still applies. */
const MAX_PEEK_BYTES = 16 * 1024 * 1024;

/** Message roles whose finalized content is masked in message_end. User
 *  messages are included so a value pasted into a prompt does not land in the
 *  session file or the synced store either; the model then sees the masked
 *  form, which is the intended pressure toward `secretctl set --from prompt:`. */
const MASKED_ROLES = new Set<string>(["assistant", "user"]);

/** Tool calls whose arguments message_end had to mask. message_end runs
 *  BEFORE the tool executes and pi mutates the in-memory message, so a masked
 *  argument would otherwise be what actually runs - a silently different
 *  command. Remembering the id lets tool_call refuse it with the real reason. */
const taintedCalls = new Map<string, string[]>();

let registry: RegistryDigests | null = null;
let registryDisabled = false;
let registryNotice: string | null = null;

/** With remote stores registered a full `digests` pass takes several seconds
 *  (two ssh round trips on this box), so it must not run synchronously inside
 *  a tool call every TTL. The first load is kicked off at session_start and
 *  refreshes run in the background; only a tool call that arrives before the
 *  very first load has finished pays for a synchronous one. */
const DIGESTS_TIMEOUT_MS = 90_000;
const DIGESTS_ARGS = ["digests", "--json"];
const DIGESTS_OPTS = { encoding: "utf8" as const, maxBuffer: 16 * 1024 * 1024, timeout: DIGESTS_TIMEOUT_MS };
let refreshing = false;

/** Exit 2 means some store was unresolved; the JSON is still valid and is
 *  partial coverage, which beats none. */
function acceptPartial(err: { status?: number; code?: number | string; stdout?: string } | null, stdout: string): string {
  if (!err) return stdout;
  const status = typeof err.code === "number" ? err.code : err.status;
  if (status === 2 && stdout.trim().startsWith("{")) return stdout;
  throw err;
}

function disable(err: unknown): null {
  registryDisabled = true;
  registry = null;
  const e = err as { code?: string; stderr?: string; message?: string };
  const why = e.code === "ENOENT"
    ? "secretctl not on PATH"
    : (e.stderr?.toString().trim().split("\n").pop() || e.message || String(err));
  registryNotice = `secret-output-guard: known-value layer OFF (${why}). ` +
    "Env-value + token-format layers still active. Fix: ~/infra/secretctl `make install`, " +
    "registry at ~/.config/secretctl/sources; kill switch PI_SECRET_GUARD_OFF=1.";
  return null;
}

/** Synchronous load: only for a tool call that arrives before the first
 *  background load completed. */
function loadRegistrySync(): RegistryDigests | null {
  try {
    let stdout: string;
    try {
      stdout = execFileSync("secretctl", DIGESTS_ARGS, { ...DIGESTS_OPTS, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      stdout = acceptPartial(e, e.stdout ?? "");
    }
    registry = parseDigests(stdout);
    registryDisabled = false;
    return registry;
  } catch (err) {
    return disable(err);
  }
}

/** Background load / refresh. The current digest set stays in use until the
 *  new one has parsed, so a slow ssh never leaves the guard empty-handed. */
function refreshRegistryAsync(): void {
  if (refreshing || registryDisabled) return;
  refreshing = true;
  execFile("secretctl", DIGESTS_ARGS, DIGESTS_OPTS, (err, stdout) => {
    refreshing = false;
    try {
      const json = acceptPartial(err as { code?: number | string; status?: number } | null, String(stdout ?? ""));
      registry = parseDigests(json);
      registryDisabled = false;
    } catch (e) {
      // A failed REFRESH keeps the previous set; only a failed FIRST load
      // disables the layer (there is nothing older to fall back to).
      if (!registry) disable(e);
    }
  });
}

function digests(): RegistryDigests | null {
  if (registryDisabled) return null;
  if (registry) {
    if (Date.now() - registry.loadedAt >= REGISTRY_TTL_MS) refreshRegistryAsync();
    return registry;
  }
  return loadRegistrySync();
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** Absolute, symlink-resolved path of a regular file, or null. */
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

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SECRET_GUARD_OFF === "1") return;

  // Preload so the first tool call does not pay for the ssh round trips.
  pi.on("session_start", async () => {
    refreshRegistryAsync();
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;

    // Layer 3a: the model typed a registered value INTO a tool argument (a
    // command line, a file body, a URL). Any tool. Blocked, not masked - the
    // masked command would run wrong, and the correct form is $VAR / secretctl.
    {
      const id = (event as { toolCallId?: string }).toolCallId;
      const tainted = id ? taintedCalls.get(id) : undefined;
      if (tainted) {
        taintedCalls.delete(id!);
        return {
          block: true,
          reason: inputHoldsKnownReason(event.toolName, tainted.map((label) => ({ label, hex: "", len: 0 }))),
        };
      }
      const d = digests();
      if (d) {
        const hits = inputHoldsKnown(input, d);
        if (hits.length > 0) {
          return { block: true, reason: inputHoldsKnownReason(event.toolName, hits, hits.every((h) => h.assembled)) };
        }
      }
    }

    // Layer 3b: a printing tool aimed at a registered store, or at a file that
    // holds a registered value. Checked for read / grep / bash alike.
    const targets = toolReadTargets(event.toolName, input, splitSegments);
    if (targets.length > 0) {
      const d = digests();
      if (!d && registryNotice) {
        const msg = registryNotice;
        registryNotice = null; // say it once
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      }
      if (d) {
        const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
        for (const t of targets) {
          const f = regularFile(t, cwd);
          if (!f) continue;
          if (isRegisteredFile(f.path, d)) {
            const label = [...d.byHex.values()].find((e) => e.label.includes(f.path.replace(homedir(), "~")))?.label
              ?? "registered store";
            return { block: true, reason: registeredFileReason(t, label.replace(/#.*$/, "")) };
          }
          if (f.size <= MAX_PEEK_BYTES) {
            let content: string;
            try {
              content = readFileSync(f.path, "utf8");
            } catch {
              continue;
            }
            const hits = holdsKnown(content, d);
            if (hits.length > 0) return { block: true, reason: holdsKnownReason(t, hits) };
          }
        }
      }
    }

    if (event.toolName !== "bash") return undefined;
    const command = (event.input as { command?: string }).command;
    if (typeof command !== "string") return undefined;
    // A rotation changes the values the registry layer knows about: refresh in
    // the background, keeping the current set until the new one is parsed.
    if (/\bsecretctl\s+set\b/.test(command)) refreshRegistryAsync();
    const segments = splitSegments(command);

    const dump = envDumpSegment(segments);
    if (dump) {
      return {
        block: true,
        reason: `tool-guard[secret_env_dump]: blocked \`${dump}\` - ${ENV_DUMP_REASON}`,
      };
    }

    // Checked after the env-dump patterns: a bare `env` is the more specific
    // diagnosis, so it should win the error message when a command trips both.
    const pipeline = plaintextPipelineSegment(segments);
    if (pipeline) {
      return {
        block: true,
        reason: `tool-guard[secret_plaintext_pipeline]: blocked \`${pipeline}\` - ${PLAINTEXT_PIPELINE_REASON}`,
      };
    }

    return undefined;
  });

  // Layer 3c: the model's OWN text (and the user's). Both 2026-09-04 leaks
  // ended with the model retyping a value into its message; tool_result never
  // sees that. message_end lets us replace the finalized message before it is
  // persisted / synced / replayed as context. The streamed text was already
  // displayed - this cleans the durable copies.
  pi.on("message_end", async (event, ctx) => {
    const msg = (event as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || !MASKED_ROLES.has(msg.role ?? "")) return undefined;
    const d = digests();
    if (!d) return undefined;
    let content: ContentBlock[];
    if (typeof msg.content === "string") content = [{ type: "text", text: msg.content }];
    else if (Array.isArray(msg.content)) content = msg.content as ContentBlock[];
    else return undefined;
    const r = redactContent(content, d);
    if (r.redactions === 0) return undefined;
    // Any toolCall whose arguments changed must not execute as masked text.
    content.forEach((orig, i) => {
      const masked = r.content[i] as { type?: string; id?: string; arguments?: unknown };
      if (orig.type === "toolCall" && masked !== orig && typeof masked.id === "string") {
        taintedCalls.set(masked.id, [...new Set(r.labels)]);
      }
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `secret-output-guard: masked ${r.redactions} registered value(s) in a ${msg.role} message before it was saved ` +
          `(${[...new Set(r.labels)].join(", ")}). It was already shown on screen - treat it as exposed if this terminal is shared.`,
        "warning",
      );
    }
    const replacement = typeof msg.content === "string"
      ? { ...msg, content: (r.content[0] as { text: string }).text }
      : { ...msg, content: r.content };
    return { message: replacement };
  });

  pi.on("tool_result", async (event) => {
    if (!Array.isArray(event.content)) return undefined;
    const content = event.content as ToolResultContent[];
    const d = digests();
    let changed = false;
    let total = 0;
    const knownLabels: string[] = [];
    const next = content.map((item) => {
      if (item.type !== "text" || typeof item.text !== "string") return item;
      let { text, redactions } = redactSecrets(item.text, secrets());
      if (d) {
        const k = redactKnown(text, d);
        text = k.text;
        redactions += k.redactions;
        knownLabels.push(...k.labels);
      }
      if (redactions === 0) return item;
      changed = true;
      total += redactions;
      return { ...item, text };
    });
    if (!changed) return undefined;
    const known = knownLabels.length > 0
      ? ` Registered credential(s) involved: ${[...new Set(knownLabels)].join(", ")}.`
      : "";
    next.push({
      type: "text",
      text:
        `\n[tool-guard[secret_redact]: masked ${total} secret value(s) in this output ` +
        `(prefix kept so you can tell which credential; full value never enters context).${known} ` +
        `Use the credential by var reference ($NAME) or file path - do not try to print it again.]`,
    });
    return { content: next };
  });
}
