/**
 * secret-scan-core unit tests - pure parsers + rendering. No gitleaks/
 * noseyparker binary needed (live runs are [blocked: needs binary]).
 * The load-bearing assertion: a full secret NEVER survives parsing.
 *
 *   bun test extensions/tests/secret-scan-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { parseGitleaksJson, parseNoseyparkerJsonl, renderSecrets } from "../lib/secret-scan-core.ts";

const SECRET = "AKIAIOSFODNN7EXAMPLE"; // 20 chars; first 12 = "AKIAIOSFODNN"

const GITLEAKS = JSON.stringify([
  {
    RuleID: "aws-access-key",
    File: "config.js",
    StartLine: 42,
    EndLine: 42,
    Secret: SECRET,
    Commit: "abc123def4567890",
    Description: "AWS Access Key",
  },
]);

const NOSEYPARKER =
  JSON.stringify({
    rule_name: "AWS API Key",
    matches: [
      {
        provenance: [{ path: "src/x.js", commit_metadata: { commit_id: "deadbeefcafe" } }],
        location: { source_span: { start: { line: 10 } } },
        snippet: { matching: SECRET },
      },
    ],
  }) + "\n";

describe("secret-scan-core.parseGitleaksJson", () => {
  const findings = parseGitleaksJson(GITLEAKS);
  test("flattens fields", () => {
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("aws-access-key");
    expect(findings[0].file).toBe("config.js");
    expect(findings[0].line).toBe(42);
    expect(findings[0].commit).toBe("abc123def4567890");
  });
  test("SECURITY: truncates secret to 12 chars + length, never the full value", () => {
    expect(findings[0].secretPrefix).toBe("AKIAIOSFODNN... (20 chars)");
    expect(findings[0].secretPrefix).not.toContain(SECRET);
    expect(findings[0].secretPrefix).not.toContain("EXAMPLE");
  });
  test("malformed / non-array -> []", () => {
    expect(parseGitleaksJson("nope")).toEqual([]);
    expect(parseGitleaksJson("{}")).toEqual([]);
  });
});

describe("secret-scan-core.parseNoseyparkerJsonl", () => {
  const findings = parseNoseyparkerJsonl(NOSEYPARKER);
  test("flattens matches + truncates secret", () => {
    expect(findings.length).toBe(1);
    expect(findings[0].rule).toBe("AWS API Key");
    expect(findings[0].file).toBe("src/x.js");
    expect(findings[0].line).toBe(10);
    expect(findings[0].commit).toBe("deadbeefcafe");
    expect(findings[0].secretPrefix).toBe("AKIAIOSFODNN... (20 chars)");
    expect(findings[0].secretPrefix).not.toContain("EXAMPLE");
  });
  test("skips malformed lines, tolerates blank lines", () => {
    expect(parseNoseyparkerJsonl("not json\n\n")).toEqual([]);
  });
});

describe("secret-scan-core.renderSecrets", () => {
  test("header + rule + file:line@commit, no raw secret", () => {
    const text = renderSecrets(parseGitleaksJson(GITLEAKS), "gitleaks", "/repo");
    expect(text).toContain("1 finding (gitleaks, /repo)");
    expect(text).toContain("[aws-access-key] config.js:42@abc123de");
    expect(text).toContain("AKIAIOSFODNN... (20 chars)");
    expect(text).not.toContain(SECRET);
  });
});
