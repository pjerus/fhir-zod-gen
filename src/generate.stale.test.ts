/**
 * Issue #50: a second run into the same output directory used to leave the
 * first run's files on disk while overwriting index.ts, so the barrel
 * exported none of them — silently, with no error at generation or compile.
 *
 * These run generatePackage against a temp directory with the fixture-backed
 * SchemaSource, so they exercise the real write path rather than asserting on
 * emitted strings.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePackage } from "./generate.js";
import { loadFixtureSchemaSource } from "./merge/fixture-schema-source.js";
import { GENERATED_FILE_MARKER } from "./emit/index.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const source = loadFixtureSchemaSource(FIXTURES_DIR);

function fixture(name: string): FhirSchemaDocument {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as FhirSchemaDocument;
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "fhir-zod-stale-test-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("generatePackage and stale generated files (issue #50)", () => {
  it("refuses a second batch that would orphan the first batch's files", async () => {
    await generatePackage([fixture("uscore-patient.fhirschema.json")], { outDir, source });
    const first = readdirSync(outDir);
    expect(first).toContain("index.ts");

    await expect(
      generatePackage([fixture("r4-bodyweight.fhirschema.json")], { outDir, source })
    ).rejects.toThrow(/would not rewrite/);

    // And it refused before touching anything: the first batch is intact.
    expect(readdirSync(outDir).sort()).toEqual(first.sort());
    expect(readFileSync(join(outDir, "index.ts"), "utf-8")).toMatch(/USCorePatientProfile/);
  });

  it("names the orphans and points at the one-run alternative", async () => {
    await generatePackage([fixture("uscore-patient.fhirschema.json")], { outDir, source });
    await expect(
      generatePackage([fixture("r4-bodyweight.fhirschema.json")], { outDir, source })
    ).rejects.toThrow(/USCorePatientProfile\.ts|HumanName\.ts/);
  });

  it("--force writes anyway, which is what used to happen unasked", async () => {
    await generatePackage([fixture("uscore-patient.fhirschema.json")], { outDir, source });
    await expect(
      generatePackage([fixture("r4-bodyweight.fhirschema.json")], { outDir, force: true, source })
    ).resolves.toBeDefined();
  });

  it("re-running the same batch is not stale — that's ordinary iteration", async () => {
    const docs = [fixture("uscore-patient.fhirschema.json")];
    await generatePackage(docs, { outDir, source });
    await expect(generatePackage(docs, { outDir, source })).resolves.toBeDefined();
  });

  it("both inputs in one run emit one barrel covering both", async () => {
    // The actual fix: what two runs couldn't do, one run does.
    const { filesWritten } = await generatePackage(
      [fixture("uscore-patient.fhirschema.json"), fixture("r4-bodyweight.fhirschema.json")],
      { outDir, source }
    );
    expect(filesWritten.length).toBeGreaterThan(0);
    const barrel = readFileSync(join(outDir, "index.ts"), "utf-8");
    expect(barrel).toMatch(/USCorePatientProfile/);
    expect(barrel).toMatch(/ObservationBodyweight/);
    // One shared datatype file, not one per contributing document.
    expect(readdirSync(outDir).filter((f) => f === "HumanName.ts")).toHaveLength(1);
  });

  it("ignores a hand-written .ts sharing the directory", async () => {
    writeFileSync(join(outDir, "my-helpers.ts"), "export const mine = 1;\n", "utf-8");
    await expect(
      generatePackage([fixture("uscore-patient.fhirschema.json")], { outDir, source })
    ).resolves.toBeDefined();
    // Untouched.
    expect(readFileSync(join(outDir, "my-helpers.ts"), "utf-8")).toBe("export const mine = 1;\n");
  });

  it("only treats a file as ours when it carries the generated marker", async () => {
    // A .ts file whose name looks generated but whose content isn't ours.
    writeFileSync(join(outDir, "Coding.ts"), "// hand written, honest\n", "utf-8");
    await expect(
      generatePackage([fixture("r4-bodyweight.fhirschema.json")], { outDir, source })
    ).resolves.toBeDefined();
    // It was in this batch's own output, so it is legitimately overwritten.
    expect(readFileSync(join(outDir, "Coding.ts"), "utf-8").startsWith(GENERATED_FILE_MARKER)).toBe(true);
  });
});
