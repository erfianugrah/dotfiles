/**
 * oci-tags-core unit tests - pure helpers, no network, no SDK.
 *
 * Runs standalone: `bun test extensions/tests/oci-tags-core.test.ts`.
 * Mirrors the assertions in ../../tests/extensions.test.ts (the pi suite) so
 * the shared core is covered from the harness-agnostic side too.
 */

import { describe, expect, test } from "bun:test";
import { isStableSemver, majorOf, parseImage, versionCompare } from "../lib/oci-tags-core.ts";

describe("oci-tags-core.parseImage", () => {
  test("bare name -> docker hub library namespace", () => {
    expect(parseImage("nginx")).toEqual({ registry: "registry-1.docker.io", repo: "library/nginx" });
  });
  test("org/name -> docker hub org namespace", () => {
    expect(parseImage("vaultwarden/server")).toEqual({ registry: "registry-1.docker.io", repo: "vaultwarden/server" });
  });
  test("explicit registry host is honored", () => {
    expect(parseImage("ghcr.io/astral-sh/uv")).toEqual({ registry: "ghcr.io", repo: "astral-sh/uv" });
  });
  test("strips :tag and @digest suffixes", () => {
    expect(parseImage("nginx:1.27")).toEqual({ registry: "registry-1.docker.io", repo: "library/nginx" });
    expect(parseImage("nginx@sha256:abc")).toEqual({ registry: "registry-1.docker.io", repo: "library/nginx" });
  });
});

describe("oci-tags-core.versionCompare", () => {
  test("orders numerically, not lexically (ls9 before ls10)", () => {
    const tags = ["1.0.0-ls10", "1.0.0-ls9", "1.0.0-ls100"];
    tags.sort(versionCompare);
    expect(tags).toEqual(["1.0.0-ls9", "1.0.0-ls10", "1.0.0-ls100"]);
  });
  test("shorter prefix sorts before its build-suffixed sibling", () => {
    expect(versionCompare("6.2.1", "6.2.1.10461-ls305")).toBeLessThan(0);
  });
  test("leading v is ignored", () => {
    expect(versionCompare("v1.2.0", "1.2.0")).toBe(0);
  });
});

describe("oci-tags-core.isStableSemver", () => {
  test("accepts plain semver", () => {
    expect(isStableSemver("1.2.3")).toBe(true);
    expect(isStableSemver("v4.0.17")).toBe(true);
  });
  test("rejects prerelease markers", () => {
    for (const t of ["1.2.3-rc1", "1.0.0-beta", "2.0-nightly", "1.0.0-develop"]) {
      expect(isStableSemver(t)).toBe(false);
    }
  });
  test("rejects non-version tags", () => {
    expect(isStableSemver("latest")).toBe(false);
    expect(isStableSemver("stable")).toBe(false);
  });
  test("keeps legit linuxserver build suffix", () => {
    expect(isStableSemver("1.2.3-ls307")).toBe(true);
  });
});

describe("oci-tags-core.majorOf", () => {
  test("extracts first numeric component", () => {
    expect(majorOf("4.0.17")).toBe(4);
    expect(majorOf("v12.3")).toBe(12);
  });
  test("NaN when no leading number", () => {
    expect(Number.isNaN(majorOf("latest"))).toBe(true);
  });
});
