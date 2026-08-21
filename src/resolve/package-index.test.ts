/**
 * Offline: extracts fixtures/packages/test.fhir.mini-1.0.0.tgz (three real
 * R4 StructureDefinitions, plus one synthetic resource + ValueSet/CodeSystem
 * pair added for issue #10's terminology-wiring end-to-end test, all in the
 * registry's `package/` tarball layout) into a temp dir. No network, no
 * package cache.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPackageIndex, readPackageManifest } from "./package-index.js";

const TARBALL = fileURLToPath(new URL("../../fixtures/packages/test.fhir.mini-1.0.0.tgz", import.meta.url));

let packageDir: string;
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "fhir-zod-index-test-"));
  execFileSync("tar", ["-xzf", TARBALL, "-C", scratch]);
  packageDir = join(scratch, "package");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("readPackageIndex", () => {
  it("reads every StructureDefinition entry out of .index.json", () => {
    const entries = readPackageIndex(packageDir);
    const sds = entries.filter((e) => e.resourceType === "StructureDefinition");
    expect(sds.map((e) => e.url).sort()).toEqual([
      "http://example.org/fhir/StructureDefinition/TestBindingResource",
      "http://hl7.org/fhir/StructureDefinition/Extension",
      "http://hl7.org/fhir/StructureDefinition/Period",
      "http://hl7.org/fhir/StructureDefinition/patient-birthTime",
    ]);
  });

  it("carries the routing fields a lookup needs without opening the file", () => {
    const period = readPackageIndex(packageDir).find((e) => e.id === "Period");
    expect(period).toEqual({
      filename: "StructureDefinition-Period.json",
      resourceType: "StructureDefinition",
      id: "Period",
      url: "http://hl7.org/fhir/StructureDefinition/Period",
      version: "4.0.1",
      kind: "complex-type",
      type: "Period",
    });
  });

  it("falls back to scanning the directory when a package ships no index", () => {
    const fromIndex = readPackageIndex(packageDir);
    unlinkSync(join(packageDir, ".index.json"));
    const fromScan = readPackageIndex(packageDir);

    const key = (e: { filename: string }) => e.filename;
    expect(fromScan.map(key).sort()).toEqual(fromIndex.map(key).sort());
    expect(fromScan.find((e) => e.id === "Period")).toEqual(fromIndex.find((e) => e.id === "Period"));

    // Restore for any later test in this file.
    execFileSync("tar", ["-xzf", TARBALL, "-C", scratch]);
  });
});

describe("readPackageManifest", () => {
  it("reads name, version and dependencies", () => {
    expect(readPackageManifest(packageDir)).toEqual({
      name: "test.fhir.mini",
      version: "1.0.0",
      dependencies: {},
    });
  });
});
