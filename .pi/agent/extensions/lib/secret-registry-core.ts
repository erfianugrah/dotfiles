/**
 * secret-registry-core - the KNOWN-VALUE layer of the secret guard, fed by
 * `secretctl digests --json`. Pure logic, no harness imports; the pi adapter
 * (../secret-output-guard.ts) owns spawning secretctl and caching.
 *
 * Why this layer exists (2026-09-04): the pi `grep` tool searched
 * MEMLEDGER_TOKEN under ~/.config/memledger and printed the full 48-hex token
 * into the transcript, in the same turn the user had said "don't print it".
 * The guard's two detectors could not fire: the var is not in pi's process
 * env, and a bare hex string has no format marker. gitleaks, trufflehog and
 * noseyparker all missed that line too when tested locally. Pattern matching
 * cannot tell a token from a commit hash.
 *
 * What IS knowable is where the stores are. secretctl keeps a registry of
 * them (~/.config/secretctl/sources) and `digests --json` emits, for every
 * value in every store, a keyed HMAC plus the session salt - never a value.
 * This module:
 *
 *   redactKnown(text, digests)    tokenises tool output, HMACs each candidate
 *                                 token, masks any whose digest is registered.
 *                                 The plaintext value never enters this process
 *                                 except as a substring of output it was already
 *                                 in.
 *   holdsKnown(content, digests)  the same test over a file about to be read,
 *                                 so the read can be BLOCKED before the value
 *                                 reaches the model. `secretctl classify` is the
 *                                 CLI twin (substring search, in-process).
 *   isRegisteredFile(path, digests)  the store itself is never readable.
 *
 * This is the GitHub Actions `::add-mask::` model with a hash in place of the
 * raw value: exact known-value matching, no format list, no keyword list.
 * Residuals (documented, accepted): a value containing whitespace cannot be a
 * single token and is not caught here (classify's substring search does catch
 * it in files); an encoded form (base64, URL-escaped) is not matched - see the
 * secretctl TODO for the encoded-variant follow-up.
 */

import { createHmac } from "node:crypto";

export interface DigestEntry {
  label: string;
  hex: string;
  len: number;
}

export interface RegistryDigests {
  saltHex: string;
  minLen: number;
  /** full-width hex digest -> entry */
  byHex: Map<string, DigestEntry>;
  /** absolute paths of registered stores */
  files: Set<string>;
  unresolved: string[];
  loadedAt: number;
}

/** Parse `secretctl digests --json`. Throws on a shape that cannot be a
 *  digests payload, so a wrong binary on PATH fails loud, not silent. */
export function parseDigests(json: string, now = Date.now()): RegistryDigests {
  const raw = JSON.parse(json) as {
    salt_hex?: string;
    min_len?: number;
    width?: number;
    files?: string[];
    entries?: DigestEntry[];
    unresolved?: { label: string; error: string }[];
  };
  if (typeof raw.salt_hex !== "string" || raw.salt_hex.length < 32 || !Array.isArray(raw.entries)) {
    throw new Error("not a secretctl digests payload (missing salt_hex / entries)");
  }
  if (raw.width !== 64) {
    throw new Error(`digests width ${raw.width}; the guard needs full-width (64) digests`);
  }
  const byHex = new Map<string, DigestEntry>();
  for (const e of raw.entries) {
    if (typeof e.hex === "string" && e.hex.length === 64) byHex.set(e.hex, e);
  }
  return {
    saltHex: raw.salt_hex,
    minLen: typeof raw.min_len === "number" ? raw.min_len : 8,
    byHex,
    files: new Set(raw.files ?? []),
    unresolved: (raw.unresolved ?? []).map((u) => u.label),
    loadedAt: now,
  };
}

/** secretctl's canonical rule: strip at most one trailing \n (and a preceding
 *  \r); bytes otherwise verbatim. Mirrors credential.Canonical. */
export function canonical(s: string): string {
  if (s.endsWith("\n")) {
    s = s.slice(0, -1);
    if (s.endsWith("\r")) s = s.slice(0, -1);
  }
  return s;
}

/** HMAC-SHA256 keyed on the salt's HEX STRING (not its decoded bytes) - the
 *  same convention secretctl and its remote `openssl dgst -hmac` use. */
export function digestOf(candidate: string, saltHex: string): string {
  return createHmac("sha256", saltHex).update(canonical(candidate), "utf8").digest("hex");
}

/** Characters that end a token in the broad tokenisation. Quotes, brackets and
 *  list separators, but NOT `=`, `:` or `.` - a value may contain those
 *  (base64 padding, connection strings), so they are handled as prefixes
 *  instead (see candidates). */
const BROAD_DELIMS = /[\s"'`,;<>(){}\[\]|]+/;
/** Trailing sentence/list punctuation. `=` is deliberately NOT here: it is
 *  base64 padding as often as it is an assignment operator, and stripping it
 *  would turn a registered `...PQ==` into an unregistered `...PQ`. */
const TRAIL_PUNCT = /[.,;:?!]+$/;
const LEAD_PUNCT = /^[.:=]+/;

/** Candidate substrings of `text` that could be a whole credential value.
 *  Deliberately over-generates: every candidate costs one HMAC (microseconds)
 *  and a miss costs nothing, while a value that is never a candidate is a
 *  value that is never masked. */
export function candidates(text: string, minLen: number): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    if (s.length >= minLen) out.add(s);
  };
  for (const piece of text.split(BROAD_DELIMS)) {
    if (piece.length < minLen) continue;
    add(piece);
    const bare = piece.replace(LEAD_PUNCT, "").replace(TRAIL_PUNCT, "");
    add(bare);
    // KEY=value, key:value, --flag=value, ./env:2:KEY=value: the value is what
    // follows the FIRST `=` (and, for YAML/URL-ish shapes, the first `:`).
    // Both are tried because a value may itself contain either.
    for (const sep of ["=", ":"]) {
      const i = piece.indexOf(sep);
      if (i > 0 && i < piece.length - 1) {
        add(piece.slice(i + 1).replace(TRAIL_PUNCT, ""));
      }
    }
  }
  return out;
}

export type KnownHit = { value: string; entry: DigestEntry };

/** Every candidate in `text` whose digest is registered. */
export function findKnown(text: string, d: RegistryDigests): KnownHit[] {
  if (d.byHex.size === 0) return [];
  const hits: KnownHit[] = [];
  for (const c of candidates(text, d.minLen)) {
    const entry = d.byHex.get(digestOf(c, d.saltHex));
    if (entry) hits.push({ value: c, entry });
  }
  // Longest first so a value that is a prefix of another is masked whole.
  hits.sort((a, b) => b.value.length - a.value.length);
  return hits;
}

/** Mask keeps a short prefix so the agent can tell WHICH credential without
 *  a usable amount of it: a quarter of the value, at most 8 chars. (The env
 *  layer keeps a fixed 8; a 12-char password would lose 2/3 of itself to
 *  that, so the registry layer scales down.) */
export function knownMask(value: string, label: string): string {
  const keep = Math.min(8, Math.floor(value.length / 4));
  return `${value.slice(0, keep)}...[redacted:registry ${label} ${value.length} chars]`;
}

export type RedactKnownResult = { text: string; redactions: number; labels: string[] };

/** Replace every occurrence of every registered value found in `text`. */
export function redactKnown(text: string, d: RegistryDigests): RedactKnownResult {
  let out = text;
  let redactions = 0;
  const labels: string[] = [];
  for (const { value, entry } of findKnown(text, d)) {
    if (!out.includes(value)) continue; // already masked as part of a longer hit
    const parts = out.split(value);
    redactions += parts.length - 1;
    out = parts.join(knownMask(value, entry.label));
    labels.push(entry.label);
  }
  return { text: out, redactions, labels };
}

/** Is `path` (already absolute + symlink-resolved by the caller) a registered
 *  store? The store itself is never readable through a printing tool. */
export function isRegisteredFile(path: string, d: RegistryDigests): boolean {
  return d.files.has(path);
}

/** Does file `content` hold any registered value? Same tokenised-HMAC test
 *  as output redaction, so the two layers cannot disagree. */
export function holdsKnown(content: string, d: RegistryDigests): DigestEntry[] {
  return findKnown(content, d).map((h) => h.entry);
}

// ── the model's own output, and the arguments it passes to tools ─────────────

/**
 * Both 2026-09-04 leaks ended the same way: the model RETYPED a value it had
 * seen into its own message ("which key do the plugs hold - <value>?"). The
 * tool_result layer never sees assistant text, so a value that reached the
 * model once could be re-emitted freely. pi's `message_end` event lets a
 * handler replace the finalized message, so the same tokenise-and-HMAC pass
 * runs over the model's text before it is persisted to the session file,
 * synced to memledger, or fed back as context. (The streamed text has already
 * been displayed by then; the durable copies are what this cleans.)
 *
 * Thinking blocks carry a provider signature that covers their text; masking
 * the text would invalidate it, so a masked thinking block also drops its
 * signature. That loses multi-turn continuity for that one block, which is
 * the right trade for a credential.
 */

export interface TextBlock { type: "text"; text: string; textSignature?: string }
export interface ThinkingBlock { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string; [k: string]: unknown };

export type RedactContentResult = { content: ContentBlock[]; redactions: number; labels: string[] };

/** Mask registered values in every text / thinking / toolCall-argument block. */
export function redactContent(content: ContentBlock[], d: RegistryDigests): RedactContentResult {
  let redactions = 0;
  const labels: string[] = [];
  const out = content.map((block) => {
    if (block.type === "text" && typeof (block as TextBlock).text === "string") {
      const r = redactKnown((block as TextBlock).text, d);
      if (r.redactions === 0) return block;
      redactions += r.redactions;
      labels.push(...r.labels);
      return { ...block, text: r.text };
    }
    if (block.type === "thinking" && typeof (block as ThinkingBlock).thinking === "string") {
      const r = redactKnown((block as ThinkingBlock).thinking, d);
      if (r.redactions === 0) return block;
      redactions += r.redactions;
      labels.push(...r.labels);
      const { thinkingSignature: _sig, ...rest } = block as ThinkingBlock;
      return { ...rest, thinking: r.text };
    }
    if (block.type === "toolCall" && (block as ToolCallBlock).arguments) {
      const r = redactStrings((block as ToolCallBlock).arguments, d);
      if (r.redactions === 0) return block;
      redactions += r.redactions;
      labels.push(...r.labels);
      return { ...block, arguments: r.value as Record<string, unknown> };
    }
    return block;
  });
  return { content: out, redactions, labels };
}

/** Mask registered values inside every string of an arbitrary JSON-ish value. */
export function redactStrings(value: unknown, d: RegistryDigests): { value: unknown; redactions: number; labels: string[] } {
  let redactions = 0;
  const labels: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactKnown(v, d);
      redactions += r.redactions;
      labels.push(...r.labels);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return { value: walk(value), redactions, labels };
}

/** Registered values present in a tool call's arguments - the model pasting a
 *  credential into a command line, a file body, or a URL. Blocked rather than
 *  masked: a masked command would run wrong, and the right form is `$VAR` or
 *  `secretctl exec`. */
export function inputHoldsKnown(input: unknown, d: RegistryDigests): DigestEntry[] {
  const seen = new Map<string, DigestEntry>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const h of findKnown(v, d)) seen.set(h.entry.label, h.entry);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(input);
  return [...seen.values()];
}

export function inputHoldsKnownReason(toolName: string, entries: DigestEntry[]): string {
  const labels = entries.slice(0, 5).map((e) => e.label).join(", ") + (entries.length > 5 ? ", ..." : "");
  return (
    `tool-guard[secret_in_args]: blocked - the ${toolName} call's arguments contain the plaintext value of ${labels}. ` +
    "A credential in a tool argument lands in the transcript, the synced session store and (for bash) the process " +
    "table. Never type the value: reference it as $NAME, run the command under `secretctl exec 'SRC' --as NAME -- <cmd>`, " +
    "or write it with `secretctl set 'DST' --from 'SRC'`. Do NOT work around this by assembling the value at runtime " +
    "from pieces (printf/echo of chunks, base64, variables built in the shell) - that defeats the guard on purpose and " +
    "is a policy violation, not a clever fix. If you saw this value in earlier output, that output should have been " +
    "masked - say so. Kill switch: PI_SECRET_GUARD_OFF=1."
  );
}

// ── which files would a tool call print? ────────────────────────────────────

/** Commands whose only job is to print a file's contents. */
const PLAIN_READERS = /^(?:sudo\s+)?(?:cat|tac|head|tail|less|more|bat|batcat|nl|strings)\b/;
/** Search commands: the first non-flag token is the pattern, the rest files. */
const GREP_READERS = /^(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ag|ack)\b/;
/** Flags that consume the next token. Misparses are harmless: the adapter only
 *  acts on tokens that resolve to an existing regular file. */
const ARG_FLAGS = new Set(["-n", "-e", "--regexp", "-f", "--file", "-g", "--glob", "-t", "--type", "-m", "-A", "-B", "-C"]);
/** `| sed 's/=.*$/=<set>/'` - the approved key-listing idiom keeps no value. */
const MASKING_FILTER = /\|\s*sed\s+(?:-\S+\s+)*['"]?s\/=\.\*/;

function tokens(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** File-path candidates a bash command would print wholesale (or search with
 *  a value-rendering grep). [] when the command masks values itself or goes
 *  through secretctl. `segments` = splitSegments(command). */
export function bashReadTargets(segments: string[]): string[] {
  const joined = segments.map((s) => s.trim()).join(" | ");
  if (MASKING_FILTER.test(joined) || /\bsecretctl\b/.test(joined)) return [];
  const out: string[] = [];
  for (const seg of segments) {
    const s = seg.trim();
    const isPlain = PLAIN_READERS.test(s);
    const isGrep = !isPlain && GREP_READERS.test(s);
    if (!isPlain && !isGrep) continue;
    const toks = tokens(s);
    let i = toks[0] === "sudo" ? 2 : 1;
    let skipPattern = isGrep;
    let explicitPattern = false;
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t === "--") continue;
      if (t.startsWith("-") && t.length > 1) {
        if (ARG_FLAGS.has(t)) {
          if (t === "-e" || t === "--regexp") explicitPattern = true;
          i++;
        }
        continue;
      }
      if (skipPattern && !explicitPattern) {
        skipPattern = false;
        continue;
      }
      out.push(t);
    }
  }
  return out;
}

/** Paths a tool call would print, by tool. `read` and `grep` are pi built-ins
 *  (input.path); bash goes through bashReadTargets. */
export function toolReadTargets(
  toolName: string,
  input: Record<string, unknown>,
  splitSegments: (cmd: string) => string[],
): string[] {
  switch (toolName) {
    case "read": {
      const p = input.path ?? input.file_path;
      return typeof p === "string" ? [p] : [];
    }
    case "grep": {
      const p = input.path;
      return typeof p === "string" ? [p] : [];
    }
    case "bash": {
      const c = input.command;
      return typeof c === "string" ? bashReadTargets(splitSegments(c)) : [];
    }
  }
  return [];
}

export function registeredFileReason(path: string, label: string): string {
  return (
    `tool-guard[secret_store_read]: blocked - \`${path}\` is a registered credential store (${label}). ` +
    "Reading it puts every value in it into the transcript, the model context and the synced session store. " +
    "Answer the question without the values:\n" +
    `  which keys are set:   sed -E 's/^([[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_.-]*[[:space:]]*=).*/\\1<set>/' '${path}'\n` +
    "  compare/fingerprint:  secretctl fp 'dotenv:PATH#KEY'   (sops:/keyfile: as fits)\n" +
    "  use it in a command:  secretctl exec 'dotenv:PATH#KEY' --as NAME -- <cmd>\n" +
    "  change a value:       secretctl set 'dotenv:PATH#KEY' --from <src>\n" +
    "Registry: ~/.config/secretctl/sources (`secretctl sources` lists it). " +
    "See ~/.pi/agent/skills/secret-handling/SKILL.md. Kill switch: PI_SECRET_GUARD_OFF=1."
  );
}

export function holdsKnownReason(path: string, entries: DigestEntry[]): string {
  const labels = entries.slice(0, 5).map((e) => e.label).join(", ") + (entries.length > 5 ? ", ..." : "");
  return (
    `tool-guard[secret_copy_read]: blocked - \`${path}\` contains the value(s) of ${labels}. ` +
    "It is not itself a registered store, so this is a COPY of a credential (a compose file with a pasted " +
    "value, a dump, a log). Reading it prints the credential. If the question is whether the file holds a " +
    `secret, that is now answered; \`secretctl classify '${path}'\` gives the same verdict from the shell. ` +
    "If the copy should not exist, delete or re-encrypt it rather than reading it. " +
    "Kill switch: PI_SECRET_GUARD_OFF=1."
  );
}
