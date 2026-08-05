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
  // Stub: apply-patch.ts imports this at module load. Tests that exercise diff
  // rendering inject their own diffFn into renderApplyDiffs, so this is never
  // actually called — it only needs to exist so the import resolves.
  generateDiffString: (_old: string, _new: string) => "",
}));

const piAiStub = () => {
  const identity = (x: unknown) => x;
  // Proxy rather than a hand-listed set of helpers. The old stub enumerated 8
  // (Object/String/Number/Boolean/Array/Optional/Union/Literal), so the first
  // extension to reach for a 9th took down the ENTIRE unit suite: a schema is
  // built at module scope, so `Type.X is not a function` is a module-load
  // error, not a test failure. `Type.Record` in osint.ts did exactly that -
  // 0 pass / 1 fail / 1 error, and the real package exports Record just fine,
  // so the extension worked at runtime while CI stayed red. A proxy makes the
  // stub total: no future Type helper can break the suite this way.
  const Type = new Proxy(
    {},
    { get: () => identity, has: () => true },
  ) as Record<string, unknown>;
  return {
    Type,
    complete: async () => ({ content: [] }),
    getModel: () => undefined,
  };
};
mock.module("@earendil-works/pi-ai", piAiStub);
// 0.80.0 moved the old global API (complete/getModel/...) to the /compat
// subpath. Some extensions import from there now; Bun can't resolve the real
// bundled module, so mirror the stub onto the subpath specifier.
mock.module("@earendil-works/pi-ai/compat", piAiStub);

mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));
