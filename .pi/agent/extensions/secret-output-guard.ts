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
 * Kill switch: PI_SECRET_GUARD_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SECRET_GUARD_OFF === "1") return;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as { command?: string }).command;
    if (typeof command !== "string") return undefined;
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

  pi.on("tool_result", async (event) => {
    if (!Array.isArray(event.content)) return undefined;
    const content = event.content as ToolResultContent[];
    let changed = false;
    let total = 0;
    const next = content.map((item) => {
      if (item.type !== "text" || typeof item.text !== "string") return item;
      const { text, redactions } = redactSecrets(item.text, secrets());
      if (redactions === 0) return item;
      changed = true;
      total += redactions;
      return { ...item, text };
    });
    if (!changed) return undefined;
    next.push({
      type: "text",
      text:
        `\n[tool-guard[secret_redact]: masked ${total} secret value(s) in this output ` +
        `(prefix kept so you can tell which credential; full value never enters context). ` +
        `Use the credential by var reference ($NAME) or file path - do not try to print it again.]`,
    });
    return { content: next };
  });
}
