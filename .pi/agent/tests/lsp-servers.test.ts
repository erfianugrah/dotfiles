/**
 * lsp server table consistency. Every server must be reachable from at least
 * one file extension, ids must be unique, and every entry must say how to get
 * its binary. Pure - no spawning.
 *
 *   bun test tests/lsp-servers.test.ts
 */

import { describe, expect, test } from "bun:test";
import { LANGUAGE_EXTENSIONS, languageIdFor } from "../extensions/lsp/language.ts";
import { SERVERS, candidatesFor } from "../extensions/lsp/servers.ts";

describe("lsp SERVERS table", () => {
  const mapped = new Set(Object.values(LANGUAGE_EXTENSIONS));

  test("every server languageId is produced by some file extension", () => {
    for (const s of SERVERS) {
      for (const lang of s.languageIds) {
        expect(mapped.has(lang)).toBe(true);
      }
    }
  });

  test("server ids are unique", () => {
    const ids = SERVERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every server carries an install spec and at least one root marker", () => {
    for (const s of SERVERS) {
      expect(s.install).toBeDefined();
      expect(s.rootMarkers.length).toBeGreaterThan(0);
    }
  });

  test("the languages this machine works in all resolve to a server", () => {
    for (const f of [
      "a.ts", "a.tsx", "a.js", "a.py", "a.go", "a.rs", "a.sh", "a.yaml", "a.json", "a.toml",
      "a.tf", "a.tfvars", "a.lua", "a.astro", "a.md", "a.sql", "a.graphql", "a.c", "a.css", "a.html",
      "/x/Dockerfile",
    ]) {
      const lang = languageIdFor(f);
      expect(lang).toBeDefined();
      expect(candidatesFor(lang!).length).toBeGreaterThan(0);
    }
  });
});
