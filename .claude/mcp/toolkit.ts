#!/usr/bin/env bun
/**
 * erfi-toolkit - Claude Code MCP server (stdio) over the shared pi extension
 * cores. Each tool is a thin wrapper around a dependency-free
 * .pi/agent/extensions/lib/<name>-core.ts module, so pi and Claude Code run
 * identical logic. See .pi/agent/docs/pi-to-claude-code-port.md.
 *
 * Run from the REPO checkout (not the stow symlink) so both the SDK
 * (node_modules here) and the ../../.pi/agent cores resolve:
 *   claude mcp add --scope user erfi-toolkit -- bun $HOME/dotfiles/.claude/mcp/toolkit.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryOciTags } from "../../.pi/agent/extensions/lib/oci-tags-core.ts";

export const server = new McpServer({ name: "erfi-toolkit", version: "0.1.0" });

// -- oci_tags ----------------------------------------------------------------
server.registerTool(
  "oci_tags",
  {
    title: "OCI Tags",
    description:
      "Query OCI registries (Docker Hub, ghcr.io, quay.io, any OCI) for image tags. " +
      "Sorted by version (latest last). Use for container versions instead of web search. " +
      "semver:true returns stable releases only; current:<tag> partitions output into " +
      "same-major updates vs different-major (breaking) jumps.",
    inputSchema: {
      image: z.string().describe('Container image reference (e.g. "vaultwarden/server", "ghcr.io/astral-sh/uv", "nginx")'),
      semver: z.boolean().optional().describe("Filter to stable release tags only (excludes nightly/develop/rc/beta/preview). Default false."),
      current: z.string().optional().describe("Currently-deployed tag; partitions output into same-major vs different-major jumps."),
      limit: z.number().optional().describe("Max tags to return (default 10, max 100)."),
    },
  },
  async ({ image, semver, current, limit }) => {
    const { text } = await queryOciTags(image, { semver, current, limit });
    return { content: [{ type: "text", text }] };
  },
);

// Only start the stdio transport when run as the entrypoint, so tests can
// import { server } without spawning a transport.
if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
