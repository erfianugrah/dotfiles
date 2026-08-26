/**
 * local-provider-hints-core - turn an opaque provider connection failure
 * into an actionable diagnosis.
 *
 * Problem (observed 2026-08-26): pi renders a refused/failed provider
 * connection as the bare string "Connection error.", retries it 3x, then
 * "Retry failed after 3 attempts: Connection error." Nothing in that output
 * names the provider, the URL, or the fact that a LOCAL service is simply
 * not running. The llm-compose proxy had been dead for ~12h (container init
 * failure, exit 127) and the only signal the user got was that string.
 *
 * Mechanism note: a refused TCP connection produces NO HTTP response, so
 * `after_provider_response` never fires (verified 2026-08-26 with a probe
 * extension: on connection-refused only `message_end` /
 * `agent_end` / `agent_settled` fire; on success `after_provider_response`
 * fires with status=200). That is why continue-after-error.ts - which hooks
 * after_provider_response for 401/402/429 - cannot see this class at all.
 * The observable is `message_end` with `stopReason === "error"` and an
 * error string on the message.
 *
 * Scope: deliberately narrow. Only fires for LOCAL providers (loopback
 * baseUrl), because that is the case where the user can actually do
 * something (`make up`), and where a bare "Connection error" is most
 * misleading - a remote gateway failing is usually transient, a local
 * container being down is not self-correcting.
 */

/** Matches pi's rendering of a transport-level failure. */
const CONNECTION_ERROR_RE = /connection error|econnrefused|connection refused|fetch failed|socket hang up|econnreset/i;

/** Loopback hosts - a provider on one of these is a local service. */
const LOCAL_HOST_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

export const HINT_MARKER = "[local-provider-hints]";

export interface ProviderInfo {
  /** Provider id as configured in pi (e.g. "llama-server"). */
  provider: string;
  /** Provider baseUrl, when pi exposes it. */
  baseUrl?: string;
}

/** True when the error text looks like a transport failure, not an API error. */
export function isConnectionError(text: string): boolean {
  return CONNECTION_ERROR_RE.test(text);
}

/** True when the provider points at a loopback address. */
export function isLocalProvider(info: ProviderInfo): boolean {
  if (info.baseUrl && LOCAL_HOST_RE.test(info.baseUrl)) return true;
  // Fall back to the provider id when baseUrl isn't exposed by the harness.
  return /^llama-server$|^local|llm-compose/i.test(info.provider);
}

/**
 * Known local stacks, keyed by a matcher on provider id / baseUrl, with the
 * exact recovery commands. Keep the command list SHORT - this is read in a
 * terminal mid-failure.
 */
interface LocalStack {
  match: (info: ProviderInfo) => boolean;
  name: string;
  commands: string[];
}

const STACKS: LocalStack[] = [
  {
    match: (i) => /llama-server|llm-compose/i.test(i.provider) || /:11434/.test(i.baseUrl ?? ""),
    name: "llm-compose (model_proxy_go on :11434)",
    commands: [
      "cd ~/infra/ai/llm-compose && make up   # verifies + self-heals a dead proxy",
      "make logs-proxy-go                     # why it died",
      "llmc volumes refresh                   # stale Docker Desktop bind-mount fix",
    ],
  },
];

/**
 * Build the hint for a failed local-provider request. Returns null when this
 * isn't a local-provider connection failure (the common case - zero cost).
 */
export function buildHint(errorText: string, info: ProviderInfo): string | null {
  if (!errorText || !isConnectionError(errorText)) return null;
  if (!isLocalProvider(info)) return null;

  const stack = STACKS.find((s) => s.match(info));
  const target = info.baseUrl ? ` at ${info.baseUrl}` : "";
  const label = stack ? stack.name : `local provider "${info.provider}"`;

  const lines = [
    `${HINT_MARKER} ${label} did not accept the connection${target}.`,
    "A refused connection means the service is DOWN, not slow - retrying will not fix it.",
  ];
  if (stack) {
    lines.push("Recover with:");
    for (const c of stack.commands) lines.push(`  ${c}`);
  } else {
    lines.push(`Check that the service behind "${info.provider}" is running.`);
  }
  return lines.join("\n");
}
