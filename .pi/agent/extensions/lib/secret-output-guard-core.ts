/**
 * secret-output-guard-core - pure logic for keeping secrets out of tool
 * RESULTS. The pi adapter (../secret-output-guard.ts) wires this into
 * tool_call (block wholesale env dumps) and tool_result (redact any secret
 * value that still made it into output).
 *
 * Motivating incident (2026-08-13): the agent ran `env | grep -i composer`
 * to check auth and dumped the full 64-char COMPOSER_API_KEY into the
 * session transcript, the model context, and (via sync) the memledger
 * store. Prompt rules already said "check with sed 's/=.*$/=<set>/'" - the
 * model did it anyway. A runtime guard doesn't rely on the model
 * remembering.
 *
 * Operating principle (user-stated): the agent SHOULD use the env's
 * credentials - `curl -H "X-API-Key: $COMPOSER_API_KEY"` is the intended
 * pattern, the var NAME in the command is harmless - but it must never
 * SEE or PRINT the resolved value. So usage is never blocked; only
 * disclosure is.
 *
 * Two independent layers:
 *
 *   1. ENV-DUMP BLOCK (tool_call, bash only): wholesale environment dumps
 *      (`env`, `printenv`, bare `set`, `export -p`, `declare -x` - bare or
 *      piped/redirected) have no legitimate agent use and ALWAYS carry
 *      secrets. Blocked with a reason that teaches the masked-check idiom.
 *      Assignment forms (`env FOO=1 cmd`, `export FOO=bar`, `set -euo
 *      pipefail`) are fine and pass.
 *
 *   2. OUTPUT REDACTION (tool_result, every tool): the safety net for
 *      everything the block can't see - `echo $KEY`, `cat .env`,
 *      `read ~/.aws/credentials`, curl -v headers, a key sitting in a file
 *      the agent greps. Two detectors:
 *        a. exact-match on the VALUES of sensitive-named vars in the
 *           adapter's process env (name segment in SENSITIVE_SEGMENTS,
 *           value passes value filters);
 *        b. high-signal token-format regexes (ghp_, AKIA, sk-, JWT, PEM
 *           blocks, ...) for secrets that live in files, not the env.
 *      The mask keeps an 8-char prefix + the var/format name (the same
 *      trade secret_scan makes) so the agent can still tell WHICH secret
 *      was involved, without the usable value ever entering context.
 *
 * False-posture: over-redaction is cheap (a masked non-secret in output is
 * a cosmetic blip), under-redaction is a credential in a transcript that
 * syncs off-box. Filters exist only to stop redacting common strings:
 * values must be >= MIN_VALUE_LEN chars and not look like paths.
 */

// ── env-value collection ────────────────────────────────────────────────────

/** Name segments that mark a var as secret-bearing. Matched per `_`-separated
 *  segment so MONKEY/KEYBOARD don't trip KEY, but COMPOSER_API_KEY does. */
const SENSITIVE_SEGMENTS = new Set([
  "KEY",
  "APIKEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "BEARER",
  "PAT",
  "AUTH", // catches AUTH_TOKEN / OAUTH_*; SSH_AUTH_SOCK's value is a path -> filtered below
]);

/** Below this length a value is too likely to be a common string ("true",
 *  "changed", "us-east-1") to redact on sight. Real tokens are longer. */
export const MIN_VALUE_LEN = 12;

/** Vars whose sensitive-looking name is a false friend. Values that are
 *  filesystem paths are also dropped (see looksLikePath). */
const NAME_ALLOWLIST = new Set([
  "SSH_AUTH_SOCK", // socket path, not a credential
  "GPG_AGENT_INFO",
  "XDG_SESSION_COOKIE", // local session id, no off-box value
]);

export type EnvSecret = { name: string; value: string };

function looksLikePath(v: string): boolean {
  return v.startsWith("/") || v.startsWith("~") || v.startsWith("./");
}

/** Extract redact-worthy {name, value} pairs from an environment map.
 *  Longest-value-first so a secret that is a prefix of another is fully
 *  masked before the shorter one can partially replace it. */
export function collectSensitiveEnv(
  env: Record<string, string | undefined>,
): EnvSecret[] {
  const out: EnvSecret[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_VALUE_LEN) continue;
    if (NAME_ALLOWLIST.has(name)) continue;
    if (looksLikePath(value)) continue;
    const segments = name.toUpperCase().split(/[^A-Z0-9]+/);
    if (!segments.some((s) => SENSITIVE_SEGMENTS.has(s))) continue;
    if (seen.has(value)) continue; // many vars alias the same value
    seen.add(value);
    out.push({ name, value });
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

// ── token-format detectors (secrets that live in FILES, not the env) ────────

export type FormatRule = {
  id: string;
  pattern: RegExp; // must be /g
  prefixLen: number; // chars of the match kept visible
};

/** High-signal, low-false-positive token shapes. Each keeps a short prefix
 *  visible (format marker + a few chars) - enough to identify the credential
 *  type, never enough to use it. */
export const FORMAT_RULES: FormatRule[] = [
  // PEM / OpenSSH private key BLOCKS (whole block masked, header line kept).
  {
    id: "private-key-block",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    prefixLen: 40,
  },
  { id: "composer-api-key", pattern: /\bck_[a-f0-9]{32,}\b/g, prefixLen: 8 },
  { id: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, prefixLen: 14 },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, prefixLen: 7 },
  { id: "gitlab-pat", pattern: /\bglpat-[A-Za-z0-9_-]{15,}\b/g, prefixLen: 9 },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, prefixLen: 8 },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, prefixLen: 8 },
  // sk- / sk-ant- (OpenAI / Anthropic style). 16+ body chars keeps prose safe.
  { id: "sk-token", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, prefixLen: 8 },
  // Supabase PATs.
  { id: "supabase-key", pattern: /\bsbp_[a-f0-9]{32,}\b/g, prefixLen: 8 },
  // JWTs (header.payload.signature, each segment 10+ chars).
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    prefixLen: 12,
  },
];

// ── redaction ───────────────────────────────────────────────────────────────

export type RedactResult = { text: string; redactions: number };

function mask(prefix: string, label: string, totalLen: number): string {
  return `${prefix}...[redacted:${label} ${totalLen} chars]`;
}

/** Replace every occurrence of each secret value / token format in `text`.
 *  Literal split/join for env values (values may contain regex chars);
 *  regex replace for format rules. Idempotent - an already-masked value no
 *  longer matches its own full form. */
export function redactSecrets(text: string, secrets: EnvSecret[]): RedactResult {
  let out = text;
  let redactions = 0;

  for (const { name, value } of secrets) {
    if (!out.includes(value)) continue;
    const masked = mask(value.slice(0, 8), name, value.length);
    const parts = out.split(value);
    redactions += parts.length - 1;
    out = parts.join(masked);
  }

  for (const rule of FORMAT_RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (m) => {
      redactions += 1;
      return mask(m.slice(0, rule.prefixLen), rule.id, m.length);
    });
  }

  return { text: out, redactions };
}

// ── env-dump command detection (bash tool_call block) ───────────────────────

/**
 * Wholesale environment dumps. Matched per command SEGMENT (the adapter
 * splits on pipes/`&&`/`;` first) so `env | grep x` is caught at its `env`
 * segment. Assignment/flag forms pass:
 *   env FOO=1 cmd     - runs cmd with an override, prints cmd's output only
 *   export FOO=bar    - sets, prints nothing
 *   set -euo pipefail - flags, prints nothing
 *   printenv HOME     - single var; redaction layer handles the value
 */
const ENV_DUMP_PATTERNS: RegExp[] = [
  /^(?:sudo\s+)?env(?:\s+-\S+)*\s*(\||>|$)/, // bare env / env -0, or env piped/redirected
  /^(?:sudo\s+)?printenv\s*(\||>|$)/, // printenv with no var -> dumps all
  /^set\s*(\||>|$)/, // bare `set` dumps vars + functions
  /^(?:builtin\s+)?export(?:\s+-p)?\s*(\||>|$)/, // export / export -p
  /^declare\s+-[a-zA-Z]*x[a-zA-Z]*\s*(\||>|$)/, // declare -x
  /^typeset\s+-x\s*(\||>|$)/, // typeset -x (ksh/zsh)
];

/** Returns the matched dump form, or null. `segments` are pre-split command
 *  segments (splitSegments from tool-guard-core) - pass [command] if unsplit. */
export function envDumpSegment(segments: string[]): string | null {
  for (const seg of segments) {
    const s = seg.trim();
    for (const p of ENV_DUMP_PATTERNS) {
      if (p.test(s)) return s;
    }
  }
  return null;
}

export const ENV_DUMP_REASON =
  "wholesale environment dump (`env`/`printenv`/bare `set`/`export -p`) prints EVERY secret in the " +
  "process env (API keys, tokens) into the session transcript, model context, and synced session store. " +
  "There is no legitimate agent use for a full env dump. To check one variable: " +
  "`env | grep ^NAME | sed 's/=.*/=<set>/'`. The tool_result redactor masks known secret values, " +
  "but it only knows secrets in ITS env - don't rely on it for values from files. " +
  "Kill switch: PI_SECRET_GUARD_OFF=1.";
