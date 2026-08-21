/**
 * Offline: same extracted fixture package as package-index.test.ts, driven
 * through the real SchemaSource the CLI uses. No network, no package cache.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPackageIndex } from "./package-index.js";
import { PackageSchemaSource, type LoadedPackage } from "./package-schema-source.js";

const TARBALL = fileURLToPath(new URL("../../fixtures/packages/test.fhir.mini-1.0.0.tgz", import.meta.url));

let scratch: string;
let pkg: LoadedPackage;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "fhir-zod-source-test-"));
  execFileSync("tar", ["-xzf", TARBALL, "-C", scratch]);
  const dir = join(scratch, "package");
  pkg = { name: "test.fhir.mini", version: "1.0.0", dir, entries: readPackageIndex(dir) };
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("PackageSchemaSource", () => {
  it("resolves a canonical url to a converted FHIR Schema document", () => {
    const source = new PackageSchemaSource([pkg]);
    const period = source.getByUrl("http://hl7.org/fhir/StructureDefinition/Period");

    expect(period?.name).toBe("Period");
    // Converted, not raw: a StructureDefinition has `snapshot`/`differential`,
    // a FHIR Schema document has `elements`.
    expect(Object.keys(period?.elements ?? {})).toEqual(["start", "end"]);
  });

  it("resolves a bare type name to the type's base definition", () => {
    const source = new PackageSchemaSource([pkg]);
    expect(source.getByType("Period")?.url).toBe("http://hl7.org/fhir/StructureDefinition/Period");
  });

  it("does not let a profile shadow the type it constrains", () => {
    // patient-birthTime is `type: "Extension"` — as are ~400 entries in real
    // R4 — but the Extension *type* must resolve to Extension itself.
    const source = new PackageSchemaSource([pkg]);
    const extension = source.getByType("Extension");

    expect(extension?.url).toBe("http://hl7.org/fhir/StructureDefinition/Extension");
    expect(extension?.derivation).toBe("specialization");
    // The profile is still reachable by its own url.
    expect(source.getByUrl("http://hl7.org/fhir/StructureDefinition/patient-birthTime")?.derivation).toBe(
      "constraint"
    );
  });

  it("ignores a version suffix on a canonical reference", () => {
    const source = new PackageSchemaSource([pkg]);
    expect(source.getByUrl("http://hl7.org/fhir/StructureDefinition/Period|4.0.1")?.name).toBe("Period");
  });

  it("returns undefined for a url or type the closure does not carry", () => {
    const source = new PackageSchemaSource([pkg]);
    expect(source.getByUrl("http://hl7.org/fhir/StructureDefinition/Patient")).toBeUndefined();
    expect(source.getByType("HumanName")).toBeUndefined();
  });

  it("lets the first package in the closure win a duplicated canonical", () => {
    const overlay: LoadedPackage = { ...pkg, name: "test.fhir.overlay" };
    const primaryFirst = new PackageSchemaSource([pkg, overlay]);
    expect(primaryFirst.getByUrl("http://hl7.org/fhir/StructureDefinition/Period")?.name).toBe("Period");
  });

  it("only reads the files a lookup actually asks for", () => {
    const source = new PackageSchemaSource([pkg]);
    // Corrupting a file the test never looks up must not matter — proof the
    // constructor indexed headers rather than converting all 3 documents.
    writeFileSync(join(pkg.dir, "StructureDefinition-Extension.json"), "not json", "utf-8");
    expect(source.getByType("Period")?.name).toBe("Period");

    // ... and when it *is* looked up, the failure is reported, not silent.
    const warnings: string[] = [];
    const noisy = new PackageSchemaSource([pkg], { onWarn: (m) => warnings.push(m) });
    expect(noisy.getByType("Extension")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("StructureDefinition-Extension.json");

    execFileSync("tar", ["-xzf", TARBALL, "-C", scratch]);
  });

  it("lists a package's documents filtered by kind", () => {
    const source = new PackageSchemaSource([pkg]);
    expect(source.documentsForPackage("test.fhir.mini").map((d) => d.name).sort()).toEqual([
      "Extension",
      "Period",
      "birthTime",
    ]);
    expect(source.documentsForPackage("test.fhir.mini", ["resource"])).toEqual([]);
    expect(source.documentsForPackage("test.fhir.mini", ["complex-type"])).toHaveLength(3);
    expect(() => source.documentsForPackage("hl7.fhir.r4.core")).toThrow(/was not loaded/);
  });
});
