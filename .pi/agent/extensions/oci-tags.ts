/**
 * oci-tags — query OCI container registries directly for image tags.
 *
 * Ports the opencode fork's built-in oci_tags tool (commit 8cf0f6b87) to a Pi
 * extension. Use this instead of web search when you need container image
 * versions — registry API is authoritative, no stale results, minimal tokens.
 *
 * Works with Docker Hub, ghcr.io, quay.io, and any OCI-compliant registry.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── registry parse ────────────────────────────────────────────────────────

// Exported for unit tests.
export function parseImage(image: string): { registry: string; repo: string } {
  // Strip @digest and :tag suffixes
  const clean = image.replace(/@.*$/, "").replace(/:([^/]*)$/, "");
  const first = clean.split("/")[0];
  // No slash → Docker Hub library/ namespace
  if (!clean.includes("/")) return { registry: "registry-1.docker.io", repo: `library/${clean}` };
  // First segment looks like a hostname (has dot/colon) → use as registry
  if (first.includes(".") || first.includes(":")) {
    return { registry: first, repo: clean.slice(first.length + 1) };
  }
  // Otherwise treat first segment as Docker Hub org/user
  return { registry: "registry-1.docker.io", repo: clean };
}

// ── bearer token via www-authenticate challenge ───────────────────────────

async function token(registry: string, repo: string): Promise<string | undefined> {
  const url = `https://${registry}/v2/${repo}/tags/list`;
  const probe = await fetch(url, { method: "GET", redirect: "follow" }).catch(() => null);
  if (!probe || probe.ok) return undefined;

  const challenge = probe.headers.get("www-authenticate") ?? "";
  const realm = challenge.match(/realm="([^"]+)"/)?.[1];
  const service = challenge.match(/service="([^"]+)"/)?.[1];
  if (!realm) return undefined;

  const resp = await fetch(`${realm}?service=${service ?? ""}&scope=repository:${repo}:pull`).catch(() => null);
  if (!resp?.ok) return undefined;
  const json = (await resp.json()) as { token?: string; access_token?: string };
  return json.token ?? json.access_token;
}

// ── paginated tag fetch ───────────────────────────────────────────────────

async function tags(registry: string, repo: string, auth: string | undefined): Promise<string[]> {
  const headers: Record<string, string> = auth ? { Authorization: `Bearer ${auth}` } : {};
  const result: string[] = [];
  let url: string | null = `https://${registry}/v2/${repo}/tags/list`;

  while (url) {
    const resp: Response = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${registry}`);
    const json = (await resp.json()) as { tags?: string[] };
    if (json.tags) result.push(...json.tags);

    const link: string | null = resp.headers.get("link");
    const next: string | undefined = link?.match(/<([^>]+)>/)?.[1];
    if (next) {
      url = next.startsWith("http") ? next : `https://${registry}${next}`;
    } else {
      url = null;
    }
  }

  return result;
}

// ── version-aware sort ────────────────────────────────────────────────────

// Exported for unit tests.
export function versionCompare(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.\-]/);
  const pb = b.replace(/^v/, "").split(/[.\-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] ?? "0", 10);
    const nb = parseInt(pb[i] ?? "0", 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    const cmp = (pa[i] ?? "").localeCompare(pb[i] ?? "");
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// ── tool definition ───────────────────────────────────────────────────────

const ociTagsTool = defineTool({
  name: "oci_tags",
  promptSnippet: "oci_tags — OCI registry tag query. Use for container versions.",
  promptGuidelines: [
    "Pass semver:true for release tags only.",
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
        description: "Filter to semver-like tags only (default: false)",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max tags to return (default: 10, max: 100)",
      }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { registry, repo } = parseImage(params.image);
    const normalized = registry === "docker.io" ? "registry-1.docker.io" : registry;
    const auth = await token(normalized, repo);
    const all = await tags(normalized, repo, auth);

    let filtered = all;
    if (params.semver) filtered = filtered.filter((t) => /^v?\d+\.\d+/.test(t));
    filtered.sort(versionCompare);

    const limit = Math.min(params.limit ?? 10, 100);
    const result = filtered.slice(-limit);

    if (result.length === 0) {
      return {
        content: [{ type: "text", text: `No tags found for ${params.image}` }],
        details: { count: 0, registry: normalized, image: params.image },
      };
    }

    return {
      content: [{ type: "text", text: result.join("\n") }],
      details: { count: result.length, registry: normalized, image: params.image },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(ociTagsTool);
}
