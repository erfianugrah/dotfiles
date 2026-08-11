/**
 * Headless smoke test for the erfi-toolkit MCP server. Spawns the server as a
 * real stdio subprocess and drives it with the official MCP client, so it
 * exercises the actual JSON-RPC handshake + tools/list without needing the
 * `claude` binary. A live tools/call is deliberately NOT asserted here (it
 * hits real registries - network-flaky); verify that in a live CC session.
 *
 *   bun test .claude/mcp/toolkit.smoke.test.ts
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";

const serverPath = path.join(import.meta.dir, "toolkit.ts");

describe("erfi-toolkit MCP server", () => {
  test("handshake + tools/list exposes oci_tags with a valid schema", async () => {
    // process.execPath is the bun binary running this test - robust vs PATH.
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("oci_tags");
      expect(names).toContain("osv_scan");

      const osv = tools.find((t) => t.name === "osv_scan");
      expect(osv).toBeDefined();
      const osvSchema = osv!.inputSchema as { properties?: Record<string, unknown> };
      expect(osvSchema.properties?.path).toBeDefined();
      expect(osvSchema.properties?.lockfile_only).toBeDefined();

      const oci = tools.find((t) => t.name === "oci_tags");
      expect(oci).toBeDefined();
      const schema = oci!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(schema.properties?.image).toBeDefined();
      expect(schema.properties?.semver).toBeDefined();
      expect(schema.properties?.current).toBeDefined();
      expect(schema.properties?.limit).toBeDefined();
      expect(schema.required).toContain("image");
    } finally {
      await client.close();
    }
  }, 30000);
});
