import { expect, test } from "bun:test";
import { buildHint, isConnectionError, isLocalProvider } from "../extensions/lib/local-provider-hints-core.ts";

test("the observed error string is recognised", () => {
  expect(isConnectionError("Connection error.")).toBe(true);
  expect(isConnectionError("Retry failed after 3 attempts: Connection error.")).toBe(true);
  expect(isConnectionError("ECONNREFUSED 127.0.0.1:11434")).toBe(true);
});
test("API-level errors are NOT hijacked", () => {
  expect(isConnectionError("401 Unauthorized")).toBe(false);
  expect(isConnectionError("rate limited")).toBe(false);
});
test("loopback provider detected", () => {
  expect(isLocalProvider({ provider: "x", baseUrl: "http://localhost:11434/v1" })).toBe(true);
  expect(isLocalProvider({ provider: "llama-server" })).toBe(true);
});
test("remote provider is ignored", () => {
  expect(isLocalProvider({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
});
test("llm-compose hint names the stack and the recovery command", () => {
  const h = buildHint("Connection error.", { provider: "llama-server", baseUrl: "http://localhost:11434/v1" });
  expect(h).toContain("llm-compose");
  expect(h).toContain("make up");
  expect(h).toContain("retrying will not fix it");
});
test("remote failure produces NO hint (zero cost)", () => {
  expect(buildHint("Connection error.", { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).toBeNull();
});
test("local 401 produces NO hint (continue-after-error owns that)", () => {
  expect(buildHint("401 Unauthorized", { provider: "llama-server", baseUrl: "http://localhost:11434/v1" })).toBeNull();
});
