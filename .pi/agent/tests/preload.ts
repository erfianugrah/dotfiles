/**
 * Test preload — stubs the @earendil-works/pi-* packages so unit tests can
 * import extension files without the pi binary's bundled runtime.
 *
 * Pi ships the SDK packages baked into its single-file binary; they're not
 * separately resolvable from `bun install`. For pure-helper unit tests
 * we only need the API surface to exist (so module top-level imports
 * succeed) — none of the mocked functions are actually called by the
 * helpers under test.
 *
 * Run with:
 *   bun test --preload ./.pi/agent/tests/preload.ts ./.pi/agent/tests/
 */

import { mock } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
  defineTool: (x: unknown) => x,
  getAgentDir: () => "/tmp/pi-test-agent-dir",
}));

mock.module("@earendil-works/pi-ai", () => {
  const identity = (x: unknown) => x;
  return {
    Type: {
      Object: identity,
      String: identity,
      Number: identity,
      Boolean: identity,
      Array: identity,
      Optional: identity,
      Union: identity,
      Literal: identity,
    },
    complete: async () => ({ content: [] }),
    getModel: () => undefined,
  };
});

mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));
