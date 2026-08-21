/**
 * Covers the fan-out layer's two new responsibilities: using a SchemaSource
 * when one is supplied, and reporting — never swallowing — a document that
 * cannot be resolved. Offline: fixtures only.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePackage } from "./generate.js";
import { loadFixtureSchemaSource } from "./merge/fixture-schema-source.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

const profile = JSON.parse(
  readFileSync(join(FIXTURES, "uscore-patient.fhirschema.json"), "utf-8")
) as FhirSchemaDocument;

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "fhir-zod-generate-test-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("generatePackage", () => {
  it("resolves a profile against the supplied SchemaSource", async () => {
    const source = loadFixtureSchemaSource(FIXTURES);
    const { failures } = await generatePackage([profile], { outDir, source });

    expect(failures).toEqual([]);
    // Issue #6: complex-typed fields are cross-file references now, so the
    // profile's own file is joined on disk by every complex datatype it
    // references (HumanName, Identifier, ...), not just itself + the index.
    const written = readdirSync(outDir).sort();
    expect(written).toContain(`${profile.name}.ts`);
    expect(written).toContain("HumanName.ts");
    expect(written).toContain("index.ts");

    // Concrete types merged in from the base resource — the whole point of
    // passing a source. Without one, `name` has no type at all in the profile.
    const generatedProfile = readFileSync(join(outDir, `${profile.name}.ts`), "utf-8");
    expect(generatedProfile).toContain('"name": z.array(');
    expect(generatedProfile).toContain("HumanNameSchema");

    const generatedHumanName = readFileSync(join(outDir, "HumanName.ts"), "utf-8");
    expect(generatedHumanName).toContain('"family": z.string()');

    // The barrel index re-exports every emitted file exactly once.
    const index = readFileSync(join(outDir, "index.ts"), "utf-8");
    const indexLines = index.trim().split("\n");
    expect(new Set(indexLines).size).toBe(indexLines.length);
    expect(indexLines).toHaveLength(written.length - 1); // every written file except index.ts itself
  });

  it("reports a document it could not resolve instead of aborting or writing it", async () => {
    const emptySource = { getByUrl: () => undefined, getByType: () => undefined };
    const { filesWritten, failures } = await generatePackage([profile], { outDir, source: emptySource });

    expect(failures).toHaveLength(1);
    expect(failures[0].url).toBe(profile.url);
    expect(failures[0].message).toMatch(/base/i);
    // Only the barrel index — nothing half-generated was written.
    expect(readdirSync(outDir)).toEqual(["index.ts"]);
    expect(filesWritten).toHaveLength(1);
  });
});
