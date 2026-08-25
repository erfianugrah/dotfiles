/**
 * Unit tests for lib/secret-output-guard-core.ts.
 *
 * All secret fixtures are SYNTHETIC and built by concatenation/repeat so no
 * literal token-looking string sits in the repo for scanners to flag.
 *
 * Run: ./.pi/agent/tests/run.sh secret-output-guard
 */

import { describe, expect, test } from "bun:test";

import {
  collectSensitiveEnv,
  envDumpSegment,
  MIN_VALUE_LEN,
  redactSecrets,
} from "../extensions/lib/secret-output-guard-core.ts";

const KEY64 = "ck_" + "a1b2c3d4".repeat(8); // 67 chars, synthetic
const SHORT = "x".repeat(MIN_VALUE_LEN - 1);

describe("collectSensitiveEnv", () => {
  test("collects sensitive-named, long-valued vars", () => {
    const out = collectSensitiveEnv({
      COMPOSER_API_KEY: KEY64,
      GITHUB_TOKEN: "ghp_" + "Z".repeat(36),
      PATH: "/usr/bin:/bin",
      HOME: "/home/erfi",
      MONKEY: "not-a-secret-but-long-enough-value",
    });
    const names = out.map((s) => s.name);
    expect(names).toContain("COMPOSER_API_KEY");
    expect(names).toContain("GITHUB_TOKEN");
    expect(names).not.toContain("PATH");
    expect(names).not.toContain("HOME");
    expect(names).not.toContain("MONKEY"); // KEY must be a full _-segment
  });

  test("drops short values, path values, and allowlisted names", () => {
    const out = collectSensitiveEnv({
      MY_API_KEY: SHORT, // too short
      SSH_AUTH_SOCK: "/tmp/ssh-XXXXXX/agent.1234", // allowlisted + path
      CREDENTIALS: "~/secrets.json", // path-looking
    });
    expect(out).toEqual([]);
  });

  test("dedupes shared values and sorts longest first", () => {
    const long = "s".repeat(40);
    const short = "s".repeat(20);
    const out = collectSensitiveEnv({
      A_TOKEN: short,
      B_TOKEN: short, // same value -> dropped
      C_SECRET: long,
    });
    expect(out.map((s) => s.name)).toEqual(["C_SECRET", "A_TOKEN"]);
  });
});

describe("redactSecrets", () => {
  const secrets = [{ name: "COMPOSER_API_KEY", value: KEY64 }];

  test("masks env values with prefix + name + length, all occurrences", () => {
    const { text, redactions } = redactSecrets(
      `key is ${KEY64} and again ${KEY64}.`,
      secrets,
    );
    expect(redactions).toBe(2);
    expect(text).not.toContain(KEY64);
    expect(text).toContain("ck_a1b2c");
    expect(text).toContain("[redacted:COMPOSER_API_KEY");
  });

  test("leaves ordinary text untouched", () => {
    const input = "nothing sensitive here, just prose about keys and tokens.";
    const { text, redactions } = redactSecrets(input, secrets);
    expect(redactions).toBe(0);
    expect(text).toBe(input);
  });

  test("masks known token formats even with no env secrets", () => {
    const ghp = "ghp_" + "A".repeat(36);
    const akia = "AKIA" + "B".repeat(16);
    const jwt = "eyJ" + "h".repeat(12) + "." + "p".repeat(20) + "." + "s".repeat(20);
    const input = `${ghp} ${akia} ${jwt}`;
    const { text, redactions } = redactSecrets(input, []);
    expect(redactions).toBe(3);
    expect(text).not.toContain(ghp);
    expect(text).not.toContain(akia);
    expect(text).not.toContain(jwt);
    expect(text).toContain("github-token");
    expect(text).toContain("aws-access-key");
  });

  test("masks whole PEM private key blocks", () => {
    const pem =
      "-----BEGIN OPENSSH" + // split so scanner rules don't match the literal
      " PRIVATE KEY-----\n" +
      "b3BlbnNzaC1rZXktdjEAAAAA".repeat(3) +
      "\n-----END OPENSSH" +
      " PRIVATE KEY-----";
    const { text, redactions } = redactSecrets(`before\n${pem}\nafter`, []);
    expect(redactions).toBe(1);
    expect(text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  test("masks age secret keys (sops keys.txt incident)", () => {
    // Shape: AGE-SECRET-KEY-1 + exactly 58 chars from the bech32 alphabet.
    const ageKey = "AGE-SECRET-KEY-1" + "QWERTYUIOPASDFGHJKLZXCVBNM23456789QWERTYUIOPASDFGHJKLZXCVBN".slice(0, 58);
    const input = `# created: 2026-07-24T13:08:44+08:00\n# public key: age1yd6fn...\n${ageKey}\n`;
    const { text, redactions } = redactSecrets(input, []);
    expect(redactions).toBe(1);
    expect(text).not.toContain(ageKey);
    expect(text).toContain("age-secret-key");
    expect(text).toContain("# public key: age1yd6fn..."); // comment lines survive
  });

  test("is idempotent - masked output does not re-mask", () => {
    const once = redactSecrets(KEY64, secrets).text;
    const twice = redactSecrets(once, secrets);
    expect(twice.text).toBe(once);
  });
});

describe("envDumpSegment", () => {
  const BLOCKED = [
    "env",
    "env ",
    "env | grep -i composer",
    "env -0",
    "sudo env",
    "sudo env | head",
    "printenv",
    "printenv | grep KEY",
    "set",
    "set | grep TOKEN",
    "export",
    "export -p",
    "export -p | grep SECRET",
    "declare -x",
    "declare -x | head",
    "typeset -x",
  ];
  const ALLOWED = [
    "env FOO=1 make build",
    "env -i FOO=1 bash -c 'echo hi'",
    "envsubst < tmpl.yaml",
    "export FOO=bar",
    "export PATH=$PATH:/x",
    "set -euo pipefail",
    "printenv HOME",
    "printenv COMPOSER_API_KEY", // single-var read; redaction layer masks the value
    "grep KEY .env", // file read; redaction layer, not the dump block
  ];

  for (const cmd of BLOCKED) {
    test(`blocks: ${cmd}`, () => {
      expect(envDumpSegment([cmd])).not.toBeNull();
    });
  }
  for (const cmd of ALLOWED) {
    test(`allows: ${cmd}`, () => {
      expect(envDumpSegment([cmd])).toBeNull();
    });
  }

  test("catches the dump segment inside a compound command", () => {
    expect(envDumpSegment(["cd /tmp", "env "])).toBe("env");
  });
});
