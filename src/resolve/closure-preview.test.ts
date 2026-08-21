/**
 * Offline: previewPackageClosure driven against hand-built package
 * directories, same layout/rationale as closure.test.ts. registryUrl "n/a"
 * forbids network access.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewPackageClosure } from "./closure-preview.js";

let cacheDir: string;

function writeFixturePackage(id: string, version: string, dependencies: Record<string, string> = {}): void {
  const dir = join(cacheDir, `${id}#${version}`, "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version, dependencies }), "utf-8");
  writeFileSync(join(dir, ".index.json"), JSON.stringify({ "index-version": 1, files: [] }), "utf-8");
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-closure-preview-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("previewPackageClosure", () => {
  it("reports cached status and a real on-disk size for a cached package, and no size for an uncached one", async () => {
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0", "test.dep-b": "1.0.0" });
    writeFixturePackage("test.dep-a", "1.0.0");
    // test.dep-b is declared but never written to disk — it's discoverable
    // as a closure member (the registry-metadata-only walk doesn't need it
    // to exist) but reports as not cached, with no guessed size.

    const preview = await previewPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a" }
    );

    expect(preview.primary).toEqual({
      id: "test.root",
      version: "1.0.0",
      cached: true,
      approxSizeBytes: expect.any(Number),
      terminologyOnly: false,
    });
    expect(preview.primary.approxSizeBytes).toBeGreaterThan(0);

    const depA = preview.packages.find((p) => p.id === "test.dep-a");
    expect(depA?.cached).toBe(true);
    expect(depA?.approxSizeBytes).toBeGreaterThan(0);

    const depB = preview.packages.find((p) => p.id === "test.dep-b");
    expect(depB?.cached).toBe(false);
    expect(depB?.approxSizeBytes).toBeUndefined();

    expect(preview.packages).toHaveLength(3);
  });

  it("flags a known terminology package without needing it on disk", async () => {
    writeFixturePackage("test.root", "1.0.0", { "us.nlm.vsac": "0.1.0" });

    const preview = await previewPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a" }
    );

    const vsac = preview.packages.find((p) => p.id === "us.nlm.vsac");
    expect(vsac).toEqual({ id: "us.nlm.vsac", version: "0.1.0", cached: false, terminologyOnly: true });
  });
});
