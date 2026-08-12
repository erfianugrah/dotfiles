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
      expect(names).toContain("secret_scan");
      expect(names).toContain("hurl_test");
      expect(names).toContain("go_test");
      expect(names).toContain("bench");
      expect(names).toContain("pg_analyser");
      expect(names).toContain("search_messages");
      expect(names).toContain("semantic_search");
      expect(names).toContain("search_ledger");
      expect(names).toContain("search_memories");
      expect(names).toContain("list_sessions");
      expect(names).toContain("docs");
      expect(names).toContain("web_search");
      expect(names).toContain("code_search");
      expect(names).toContain("osint");
      expect(names).toContain("render_diagram");
      expect(names).toContain("pdf");
      expect(names).toContain("context7_resolve_library_id");
      expect(names).toContain("context7_query_docs");
      expect(names).toContain("build_favicon_set");
      expect(names).toContain("video_review");

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
