/**
 * secret-registry-core unit tests - pure, no secretctl binary needed. The
 * digests payload is synthesised with the same HMAC convention secretctl uses
 * (key = salt HEX STRING), so a passing suite here means the guard and
 * secretctl agree on identity for the same value.
 *
 *   bun test extensions/tests/secret-registry-core.test.ts
 *
 * Load-bearing case: the 2026-09-04 incident line, `./env:2:MEMLEDGER_TOKEN=
 * <48 hex>` as the pi grep tool prints it, must be masked with NO format rule
 * and NO env value involved.
 */

import { describe, expect, test } from "bun:test";
import { splitSegments } from "../lib/tool-guard-core.ts";
import {
  ASSEMBLED_MIN_WINDOWS,
  bashReadTargets,
  candidates,
  canonical,
  digestOf,
  findAssembled,
  findKnown,
  holdsKnown,
  inputHoldsKnown,
  isRegisteredFile,
  knownMask,
  parseDigests,
  redactContent,
  redactKnown,
  redactStrings,
  toolReadTargets,
  type RegistryDigests,
} from "../lib/secret-registry-core.ts";

// Synthetic fixtures - never real credentials.
const SALT = "f".repeat(32) + "0".repeat(32);
const HEX48 = "4a620d0f3abb0e0cd6bd6cc07cb5700007" + "6f03c6648cbe15"; // 48 hex chars, fake
const B64 = "Qm9uamF5b3Vyc2VjcmV0dmFsdWU9PQ=="; // has = padding
const PASS = "corr3ct-horse"; // 13 chars, above the floor

function windows(value: string, w = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + w <= value.length; i++) out.push(digestOf(value.slice(i, i + w), SALT));
  return out;
}

function encodings(value: string): string[] {
  const b = Buffer.from(value, "utf8");
  return [...new Set([b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(value)])]
    .filter((f) => f !== value)
    .map((f) => digestOf(f, SALT));
}

function payload(values: { label: string; value: string }[], files: string[] = [], fragments = true) {
  return JSON.stringify({
    variants: { encodings: ["base64", "base64-nopad", "base64url", "percent"], entries: values.map((v) => ({ label: v.label, hex: encodings(v.value) })) },
    ...(fragments
      ? { fragments: { window: 8, entries: values.filter((v) => v.value.length > 8).map((v) => ({ label: v.label, hex: windows(v.value) })) } }
      : {}),
    canonical: "strip at most one trailing \\n",
    algorithm: "hmac-sha256 keyed on the salt's hex string",
    salt_hex: SALT,
    salt_ephemeral: true,
    width: 64,
    min_len: 8,
    registry: "/tmp/sources",
    files,
    entries: values.map((v) => ({ label: v.label, hex: digestOf(v.value, SALT), len: v.value.length })),
    unresolved: [],
    skipped_short: 0,
  });
}

const D: RegistryDigests = parseDigests(
  payload(
    [
      { label: "dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN", value: HEX48 },
      { label: "sops:~/infra/x/.env#S3_SECRET", value: B64 },
      { label: "dotenv:~/infra/y/.env#DB_PASSWORD", value: PASS },
    ],
    ["/home/u/.config/memledger/env"],
  ),
);

describe("parseDigests", () => {
  test("accepts the secretctl shape and indexes by full-width hex", () => {
    expect(D.saltHex).toBe(SALT);
    expect([...D.byHex.values()].filter((e) => !e.encoded).length).toBe(3);
    expect([...D.byHex.values()].some((e) => e.encoded)).toBe(true); // encoded spellings join the set
    expect(D.minLen).toBe(8);
    expect(D.files.has("/home/u/.config/memledger/env")).toBe(true);
  });
  test("rejects a payload without the salt or with a truncated width", () => {
    expect(() => parseDigests(JSON.stringify({ entries: [] }))).toThrow();
    expect(() => parseDigests(JSON.stringify({ salt_hex: SALT, width: 12, entries: [] }))).toThrow(/width/);
  });
});

describe("digestOf", () => {
  test("keys on the salt hex STRING and applies the canonical rule", () => {
    // Known-answer: HMAC-SHA256(key="ab", msg="x"), computed independently
    // with `printf x | openssl dgst -sha256 -hmac ab -r` - the same command
    // secretctl's remote path runs, so this pins cross-implementation parity.
    expect(digestOf("x", "ab")).toBe("cfd873599cd98909c62b6511edae048414fdb85e4eb04f8fd82e69270f43e397");
    expect(digestOf("value\n", SALT)).toBe(digestOf("value", SALT));
    expect(digestOf("value\r\n", SALT)).toBe(digestOf("value", SALT));
    expect(digestOf("value\n\n", SALT)).not.toBe(digestOf("value", SALT));
    expect(canonical("a\r\n")).toBe("a");
  });
});

describe("candidates", () => {
  test("yields the value from every assignment shape it appears in", () => {
    const text = [
      `./env:2:MEMLEDGER_TOKEN=${HEX48}`, // grep tool output (the incident)
      `export S3_SECRET="${B64}"`, // quoted dotenv
      `"password": "${PASS}",`, // JSON
      `  DB_PASSWORD: ${PASS}`, // YAML
      `--token=${HEX48}`, // argv
      `Authorization: Bearer ${HEX48}`, // header
      `MEMLEDGER_TOKEN=${HEX48};`, // trailing punctuation
    ].join("\n");
    const c = candidates(text, 8);
    expect(c.has(HEX48)).toBe(true);
    expect(c.has(B64)).toBe(true);
    expect(c.has(PASS)).toBe(true);
  });
  test("drops pieces below the floor", () => {
    expect([...candidates("a=b c d short", 8)]).toEqual([]);
  });
});

describe("redactKnown", () => {
  test("masks the incident line with no format rule and no env value", () => {
    const line = `./env:2:MEMLEDGER_TOKEN=${HEX48}\n./Caddyfile:859:      not header Authorization "Bearer {$MEMLEDGER_TOKEN}"`;
    const r = redactKnown(line, D);
    expect(r.redactions).toBe(1);
    expect(r.text).not.toContain(HEX48);
    expect(r.text).toContain("[redacted:registry dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN 48 chars]");
    // The var reference in the Caddyfile is harmless and untouched.
    expect(r.text).toContain("{$MEMLEDGER_TOKEN}");
    expect(r.labels).toEqual(["dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN"]);
  });
  test("masks a base64 value with '=' padding intact", () => {
    const r = redactKnown(`S3_SECRET=${B64}\nx`, D);
    expect(r.redactions).toBe(1);
    expect(r.text).not.toContain(B64);
  });
  test("masks every occurrence and is idempotent", () => {
    const once = redactKnown(`${PASS} and again ${PASS}`, D);
    expect(once.redactions).toBe(2);
    expect(once.text).not.toContain(PASS);
    const twice = redactKnown(once.text, D);
    expect(twice.redactions).toBe(0);
    expect(twice.text).toBe(once.text);
  });
  test("prefix scales with length and never exceeds 8", () => {
    expect(knownMask(HEX48, "l")).toStartWith(HEX48.slice(0, 8) + "...");
    expect(knownMask(PASS, "l")).toStartWith(PASS.slice(0, 3) + "...");
  });
  test("leaves unrelated high-entropy strings alone (a commit hash is not a secret)", () => {
    const sha = "3f2a9c1e7b4d8a6f5e0c2b1d9a8e7f6c5d4b3a29";
    const r = redactKnown(`commit ${sha}\nAPI_KEY=not-registered-value-here`, D);
    expect(r.redactions).toBe(0);
    expect(r.text).toContain(sha);
  });
  test("an empty registry is a no-op", () => {
    const empty = parseDigests(payload([]));
    expect(findKnown(`MEMLEDGER_TOKEN=${HEX48}`, empty)).toEqual([]);
  });
});

describe("file checks", () => {
  test("a registered store path is recognised", () => {
    expect(isRegisteredFile("/home/u/.config/memledger/env", D)).toBe(true);
    expect(isRegisteredFile("/home/u/.config/memledger/env.bak", D)).toBe(false);
  });
  test("a copy of a registered value in an unregistered file is detected", () => {
    const compose = `services:\n  app:\n    environment:\n      - MEMLEDGER_TOKEN=${HEX48}\n`;
    expect(holdsKnown(compose, D).map((e) => e.label)).toEqual(["dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN"]);
    expect(holdsKnown("services:\n  app:\n    environment:\n      - MEMLEDGER_TOKEN=${MEMLEDGER_TOKEN}\n", D)).toEqual([]);
  });
});

describe("read targets", () => {
  const split = splitSegments;
  test("read and grep tools expose input.path", () => {
    expect(toolReadTargets("read", { path: "~/.config/memledger/env" }, split)).toEqual(["~/.config/memledger/env"]);
    expect(toolReadTargets("grep", { pattern: "TOKEN", path: "~/.config/memledger" }, split)).toEqual(["~/.config/memledger"]);
    expect(toolReadTargets("write", { path: "x" }, split)).toEqual([]);
  });
  test("bash plain readers and greps yield their file args", () => {
    expect(bashReadTargets(split("cat ~/.config/memledger/env"))).toEqual(["~/.config/memledger/env"]);
    expect(bashReadTargets(split("head -n 5 .env"))).toEqual([".env"]);
    expect(bashReadTargets(split("grep TOKEN ~/.config/memledger/env"))).toEqual(["~/.config/memledger/env"]);
    expect(bashReadTargets(split("rg -n -e TOKEN a.env b.env"))).toEqual(["a.env", "b.env"]);
    expect(bashReadTargets(split("sudo cat /etc/x && grep -c pass f"))).toEqual(["/etc/x", "f"]);
  });
  test("the masking idiom and secretctl are never targets", () => {
    expect(bashReadTargets(split("cat .env | sed 's/=.*$/=<set>/'"))).toEqual([]);
    expect(bashReadTargets(split("sed 's/=.*$/=<set>/' .env"))).toEqual([]);
    expect(bashReadTargets(split("secretctl fp dotenv:.env#K"))).toEqual([]);
    expect(bashReadTargets(split("ls -la ~/.config/memledger"))).toEqual([]);
  });
});

describe("assistant / user message content (message_end)", () => {
  test("masks the model retyping a value in its own prose - the 2026-09-04 shape", () => {
    const r = redactContent(
      [{ type: "text", text: `Which key do the plugs hold - ${PASS}? The GL one is ${HEX48}.` }],
      D,
    );
    expect(r.redactions).toBe(2);
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(HEX48);
    expect(text).toContain("[redacted:registry");
    expect(r.labels.sort()).toEqual([
      "dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN",
      "dotenv:~/infra/y/.env#DB_PASSWORD",
    ]);
  });
  test("masks thinking text and drops the now-invalid signature", () => {
    const r = redactContent([{ type: "thinking", thinking: `token is ${HEX48}`, thinkingSignature: "sig" }], D);
    const b = r.content[0] as { thinking: string; thinkingSignature?: string };
    expect(b.thinking).not.toContain(HEX48);
    expect(b.thinkingSignature).toBeUndefined();
  });
  test("leaves untouched blocks byte-identical (signatures preserved)", () => {
    const block = { type: "thinking", thinking: "nothing secret here", thinkingSignature: "sig" };
    const r = redactContent([block, { type: "text", text: "plain" }], D);
    expect(r.redactions).toBe(0);
    expect(r.content[0]).toBe(block);
  });
  test("masks values inside persisted toolCall arguments", () => {
    const r = redactContent(
      [{ type: "toolCall", id: "1", name: "bash", arguments: { command: `curl -H "Authorization: Bearer ${HEX48}" x` } }],
      D,
    );
    const args = (r.content[0] as { arguments: { command: string } }).arguments;
    expect(args.command).not.toContain(HEX48);
    expect(r.redactions).toBe(1);
  });
  test("redactStrings walks nested JSON", () => {
    const r = redactStrings({ a: [PASS, { b: `x=${B64}` }], n: 1 }, D);
    expect(JSON.stringify(r.value)).not.toContain(PASS);
    expect(JSON.stringify(r.value)).not.toContain(B64);
    expect(r.redactions).toBe(2);
  });
});

describe("tool arguments (tool_call block)", () => {
  test("a registered value typed into a command is detected", () => {
    const hits = inputHoldsKnown({ command: `echo ${HEX48} > /tmp/x` }, D);
    expect(hits.map((h) => h.label)).toEqual(["dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN"]);
  });
  test("a value written into a file body is detected (write tool)", () => {
    const hits = inputHoldsKnown({ path: "/x/.env", content: `S3_SECRET=${B64}\n` }, D);
    expect(hits.length).toBe(1);
  });
  test("var references and secretctl forms are not hits", () => {
    expect(inputHoldsKnown({ command: 'curl -H "Authorization: Bearer $MEMLEDGER_TOKEN" x' }, D)).toEqual([]);
    expect(inputHoldsKnown({ command: "secretctl exec 'dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN' --as T -- curl x" }, D)).toEqual([]);
  });
});

describe("assembled pieces (fragment digests)", () => {
  const chunks = HEX48.match(/.{8}/g)!; // six 8-char pieces
  test("the printf-of-chunks workaround is caught in a tool argument", () => {
    const cmd = `X=$(printf '%s' ${chunks.join(" ")}) && echo "$X" > /dev/null`;
    const hits = inputHoldsKnown({ command: cmd }, D);
    expect(hits.map((h) => h.label)).toEqual(["dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN"]);
    expect(hits[0].assembled).toBe(true);
  });
  test("two pieces anywhere in a text are enough; one alone is not", () => {
    expect(findAssembled(`first ${chunks[0]} then later ${chunks[3]}`, D).length).toBeGreaterThan(0);
    expect(findAssembled(`just one piece ${chunks[2]} here`, D)).toEqual([]);
    expect(ASSEMBLED_MIN_WINDOWS).toBe(2);
  });
  test("a single longer piece (several windows) trips it on its own", () => {
    const piece = HEX48.slice(10, 26); // 16 chars = 9 windows
    const r = redactKnown(`the middle is ${piece}.`, D);
    expect(r.redactions).toBe(1);
    expect(r.text).toContain("[redacted:registry-piece");
    expect(r.text).not.toContain(piece);
  });
  test("pieces are masked in prose and in persisted tool-call arguments", () => {
    const r = redactContent(
      [{ type: "toolCall", id: "1", name: "bash", arguments: { command: `printf '%s' ${chunks.slice(0, 3).join(" ")}` } }],
      D,
    );
    const args = (r.content[0] as { arguments: { command: string } }).arguments;
    for (const c of chunks.slice(0, 3)) expect(args.command).not.toContain(c);
    expect(r.redactions).toBe(3);
  });
  test("ordinary words that happen to be windows of a list-shaped value are not pieces", () => {
    // If fragments ever exist for a list-like value, its windows are words.
    // The matcher must reject word-shaped pieces regardless of what was
    // emitted - the 2026-09-04 false positive, second half.
    const list = "owner/alpha-tool,owner/beta-conf";
    const withList = parseDigests(payload([{ label: "sops:~/x/.env#REPOS", value: list }]));
    expect(withList.fragByHex.size).toBeGreaterThan(0); // the test payload emits them anyway
    expect(findAssembled("cd ~/beta-conf && make alpha-tool lint", withList)).toEqual([]);
    expect(inputHoldsKnown({ command: "cd ~/beta-conf && make alpha-tool lint" }, withList)).toEqual([]);
  });
  test("a chunk sharing only SOME windows with a value is not a piece", () => {
    const partial = HEX48.slice(0, 8) + "zz" + HEX48.slice(10, 18); // mixed coverage
    expect(findAssembled(`x ${partial} y ${HEX48.slice(20, 28)}`, D)).toEqual([]);
  });
  test("unrelated hex and a payload without fragments are inert", () => {
    expect(findAssembled("3f2a9c1e 7b4d8a6f 5e0c2b1d 9a8e7f6c", D)).toEqual([]);
    const noFrag = parseDigests(payload([{ label: "l", value: HEX48 }], [], false));
    expect(noFrag.fragWindow).toBe(0);
    expect(findAssembled(chunks.join(" "), noFrag)).toEqual([]);
  });
  test("the whole value is still reported as a whole value, not as pieces", () => {
    const hits = inputHoldsKnown({ command: `echo ${HEX48}` }, D);
    expect(hits.length).toBe(1);
    expect(hits[0].assembled).toBeFalsy();
  });
});

describe("encoded variants", () => {
  test("a base64-encoded value in output is masked with the same label", () => {
    const b64 = Buffer.from(HEX48, "utf8").toString("base64");
    const r = redactKnown(`Authorization: Basic ${b64}\nnext line`, D);
    expect(r.redactions).toBe(1);
    expect(r.text).not.toContain(b64);
    expect(r.text).toContain("[redacted:registry-encoded dotenv:~/.config/memledger/env#MEMLEDGER_TOKEN");
  });
  test("a value typed base64-encoded into a command is refused", () => {
    const b64 = Buffer.from(PASS, "utf8").toString("base64");
    const hits = inputHoldsKnown({ command: `echo ${b64} | base64 -d | psql` }, D);
    expect(hits.map((h) => h.label)).toEqual(["dotenv:~/infra/y/.env#DB_PASSWORD"]);
  });
  test("a percent-encoded value is caught too", () => {
    // B64 contains '+' and '=' so its percent-encoding differs from itself
    const pct = encodeURIComponent(B64);
    expect(pct).not.toBe(B64);
    expect(findKnown(`GET /cb?token=${pct}`, D).map((h) => h.entry.label)).toEqual(["sops:~/infra/x/.env#S3_SECRET"]);
  });
  test("a payload without variants still works", () => {
    const d = parseDigests(JSON.stringify({ salt_hex: SALT, width: 64, entries: [{ label: "l", hex: digestOf(HEX48, SALT), len: 48 }] }));
    expect(findKnown(HEX48, d).length).toBe(1);
    expect(findKnown(Buffer.from(HEX48).toString("base64"), d)).toEqual([]);
  });
});
