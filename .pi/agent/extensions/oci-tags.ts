/**
 * oci-tags - query OCI container registries directly for image tags.
 *
 * Ports the opencode fork's built-in oci_tags tool (commit 8cf0f6b87) to a Pi
 * extension. Use this instead of web search when you need container image
 * versions - registry API is authoritative, no stale results, minimal tokens.
 *
 * Works with Docker Hub, ghcr.io, quay.io, and any OCI-compliant registry.
 *
 * The pure logic lives in ./lib/oci-tags-core.ts (shared with the Claude Code
 * MCP adapter); this file is the thin pi adapter. Re-exports the pure helpers
 * so existing imports (tests/extensions.test.ts) keep resolving here.
 *
 * Known limits (tag-scheme realities the registry tags/list API can't resolve
 * without per-manifest timestamps - documented so they aren't re-discovered):
 *
 *   1. Date-versioned images (e.g. thrnz/docker-wireguard-pia
 *      `20260622_master_835e5bc`) are dropped entirely by `semver:true` -
 *      they don't match `\d+\.\d+`. Query these WITHOUT `semver`.
 *   2. Commit-hash-suffixed tags (e.g. slskd `0.25.1.65534-fc722e4a`) share
 *      a version prefix and differ only by hash; the sort orders the hash
 *      lexically, so "latest" is meaningless. Ignore the ordering for these.
 *   3. Separator-less prereleases (`1.0.0rc1`) slip past the stable filter.
 *      Rare; tightening the boundary risks false-positives on legit tags, so
 *      left as-is.
 *   4. `0.x -> 0.x` minor bumps are grouped as "same-major" (compatible) even
 *      though semver treats 0.x minors as breaking. Matches operator intent
 *      (numeric-major grouping); not treated as a major jump.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryOciTags } from "./lib/oci-tags-core.ts";

// Re-export the pure helpers so existing importers (tests) resolve them here.
export { parseImage, PRERELEASE, isStableSemver, majorOf, versionCompare } from "./lib/oci-tags-core.ts";

// -- tool definition ---------------------------------------------------------

const ociTagsTool = defineTool({
  name: "oci_tags",
  promptSnippet: "oci_tags - OCI registry tag query. Use for container versions.",
  promptGuidelines: [
    "Pass semver:true for release tags only (excludes nightly/develop/rc/beta/preview/-version- dev tags).",
    "Pass current:<tag> to anchor on the running version - output splits into same-major updates vs different-major (breaking) jumps so a major bump is never silently recommended as routine.",
  ],
  label: "OCI Tags",
  description:
    "Query OCI registries (Docker Hub, ghcr.io, quay.io, any OCI) for image tags. Sorted by version (latest last).",

  parameters: Type.Object({
    image: Type.String({
      description: 'Container image reference (e.g. "vaultwarden/server", "ghcr.io/astral-sh/uv", "nginx")',
    }),
    semver: Type.Optional(
      Type.Boolean({
        description: "Filter to stable release tags only - excludes nightly/develop/rc/beta/preview/-version- dev tags (default: false)",
      }),
    ),
    current: Type.Optional(
      Type.String({
        description:
          "Currently-deployed tag (e.g. '4.0.17'). When set, output is partitioned into same-major updates vs different-major (breaking) jumps, so a major version change is never recommended as a routine bump.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max tags to return (default: 10, max: 100)",
      }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { text, details } = await queryOciTags(params.image, {
      semver: params.semver,
      current: params.current,
      limit: params.limit,
    });
    return { content: [{ type: "text", text }], details };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(ociTagsTool);
}
