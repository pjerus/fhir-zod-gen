/**
 * Offline: registry-metadata-only closure walking, driven against
 * hand-built package directories in the standard `<cache>/<id>#<version>/package/`
 * layout so `FhirPackageInstaller` reads them as if they were already
 * installed. `registryUrl: "n/a"` forbids all network access — see
 * install.test.ts's module comment for why that keeps this hermetic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FhirPackageInstaller } from "fhir-package-installer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKnownTerminologyPackage, walkDependencyClosure } from "./closure.js";

let cacheDir: string;

function writeFixturePackage(id: string, version: string, dependencies: Record<string, string> = {}): void {
  const dir = join(cacheDir, `${id}#${version}`, "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version, dependencies }), "utf-8");
  writeFileSync(join(dir, ".index.json"), JSON.stringify({ "index-version": 1, files: [] }), "utf-8");
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-closure-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("isKnownTerminologyPackage", () => {
  it("recognizes the packages the issue #9 measurement was against", () => {
    expect(isKnownTerminologyPackage("us.nlm.vsac")).toBe(true);
    expect(isKnownTerminologyPackage("us.cdc.phinvads")).toBe(true);
  });

  it("recognizes hl7.terminology at any fhirVersion suffix", () => {
    expect(isKnownTerminologyPackage("hl7.terminology.r4")).toBe(true);
    expect(isKnownTerminologyPackage("hl7.terminology.r5")).toBe(true);
    expect(isKnownTerminologyPackage("hl7.terminology")).toBe(true);
  });

  it("does not flag ordinary IG/core packages", () => {
    expect(isKnownTerminologyPackage("hl7.fhir.us.core")).toBe(false);
    expect(isKnownTerminologyPackage("hl7.fhir.r4.core")).toBe(false);
    expect(isKnownTerminologyPackage("hl7.fhir.uv.extensions.r4")).toBe(false);
  });
});

describe("walkDependencyClosure", () => {
  it("walks the whole closure from local package.json files, no exclusion", async () => {
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0", "us.nlm.vsac": "0.1.0" });
    writeFixturePackage("test.dep-a", "1.0.0");
    // us.nlm.vsac is deliberately never written to disk — with the registry
    // disabled, an unreachable node just resolves to "no further deps",
    // not an error, which is what proves it's still discoverable as a node.

    const installer = new FhirPackageInstaller({ cachePath: cacheDir, registryUrl: "n/a", skipExamples: true });
    const nodes = await walkDependencyClosure(installer, { id: "test.root", version: "1.0.0" });

    expect(nodes.map((n) => `${n.id}#${n.version}`).sort()).toEqual([
      "test.dep-a#1.0.0",
      "test.root#1.0.0",
      "us.nlm.vsac#0.1.0",
    ]);
  });

  it("prunes an excluded dependency out of the walk entirely", async () => {
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0", "us.nlm.vsac": "0.1.0" });
    writeFixturePackage("test.dep-a", "1.0.0");

    const installer = new FhirPackageInstaller({ cachePath: cacheDir, registryUrl: "n/a", skipExamples: true });
    const nodes = await walkDependencyClosure(
      installer,
      { id: "test.root", version: "1.0.0" },
      { excludeDependency: isKnownTerminologyPackage }
    );

    expect(nodes.map((n) => `${n.id}#${n.version}`).sort()).toEqual(["test.dep-a#1.0.0", "test.root#1.0.0"]);
  });

  it("never excludes the primary itself, even if its id matches the predicate", async () => {
    writeFixturePackage("us.nlm.vsac", "0.1.0", {});

    const installer = new FhirPackageInstaller({ cachePath: cacheDir, registryUrl: "n/a", skipExamples: true });
    const nodes = await walkDependencyClosure(
      installer,
      { id: "us.nlm.vsac", version: "0.1.0" },
      { excludeDependency: isKnownTerminologyPackage }
    );

    expect(nodes).toEqual([{ id: "us.nlm.vsac", version: "0.1.0" }]);
  });
});
