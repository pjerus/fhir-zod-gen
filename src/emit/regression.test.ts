/**
 * Regression gates against real fixtures (design doc section 5):
 *   - compile gate: generated output for the fixtures must compile under
 *     `tsc --noEmit`. A schema that doesn't compile is a failed test, not a
 *     warning.
 *   - semantic gate: generated USCorePatientProfile must reject a Patient
 *     missing `name`, and accept the conformant example from the package's
 *     own example/ directory. This is the test that would have caught every
 *     defect in the design doc's section 1 — the unit tests in emit.test.ts
 *     check individual mapping rules, but only running the real generated
 *     schema against real data proves the whole pipeline holds together.
 *
 * Scope note: all three committed profile fixtures are exercised here.
 * uscore-blood-pressure was previously excluded because its base
 * (http://hl7.org/fhir/us/core/StructureDefinition/us-core-vital-signs) is
 * itself a profile and merge/resolveDocument threw on multi-level chains;
 * issue #5 fixed that, so it is now in the gate. Slicing (what that fixture
 * primarily exists to exercise) is still unimplemented — the gate proves the
 * chain resolves and compiles, not that slices are honoured.
 *
 * Issue #6 update: complex-typed fields are cross-file references now (see
 * emit.ts's module comment — strategy B), so a document's own .ts file no
 * longer compiles in isolation; it needs every complex datatype it
 * references (Identifier, HumanName, Reference, ...) alongside it on disk.
 * The whole batch is generated with emitPackage (not per-fixture
 * emitDocument calls) and compiled together in one tsc invocation, and the
 * semantic gate's dynamic import relies on those sibling files already
 * being on disk from the same generation pass.
 *
 * Both gates shell out / dynamically import generated files from a
 * gitignored scratch directory rather than asserting on source strings —
 * that's the only way to prove the *emitted* TypeScript actually compiles
 * and actually validates, as opposed to merely looking right.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDocument } from "../merge/resolve.js";
import { loadFixtureSchemaSource } from "../merge/fixture-schema-source.js";
import { emitPackage } from "./emit.js";
import { loadFixtureTerminologySource } from "../terminology/index.js";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import type { EmitResult } from "./emit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
const FIXTURES_DIR = join(PROJECT_ROOT, "fixtures");
const TMP_DIR = join(PROJECT_ROOT, ".tmp-emit-regression-test");
const TSC_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tsc");

const schemaSource = loadFixtureSchemaSource(FIXTURES_DIR);
// Wired in so the compile/semantic gates below exercise the real z.enum(...)
// path (defect 2) end-to-end, not just the plain-z.string() fallback.
const terminology = loadFixtureTerminologySource(FIXTURES_DIR);

function loadFixture(name: string): FhirSchemaDocument {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as FhirSchemaDocument;
}

function expectCompiles(paths: string[]): void {
  execFileSync(
    TSC_BIN,
    ["--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", ...paths],
    { cwd: PROJECT_ROOT, stdio: "pipe" }
  );
}

let emitted: EmitResult[];
let filePaths: string[];

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });

  const r4Patient = resolveDocument(loadFixture("r4-patient.fhirschema.json"), schemaSource);
  const usCorePatient = resolveDocument(loadFixture("uscore-patient.fhirschema.json"), schemaSource);
  const usCoreBloodPressure = resolveDocument(loadFixture("uscore-blood-pressure.fhirschema.json"), schemaSource);
  // Regression: a FHIR Schema `name` is not always a valid TS identifier.
  // Base R4 ships `observation-bodyheight`, `CQF-Questionnaire`,
  // `DiagnosticReport-Genetics` — 15 such documents in r4.core alone. Those
  // emitted `export const observation-bodyheightSchema = ...`, which does
  // not parse. It went unnoticed because every fixture above happens to
  // have an identifier-safe name, so the compile gate never saw one.
  const hyphenated = resolveDocument({ ...loadFixture("r4-patient.fhirschema.json"), name: "observation-bodyheight" }, schemaSource);

  emitted = emitPackage([r4Patient, usCorePatient, usCoreBloodPressure, hyphenated], { terminology });

  filePaths = emitted.map(({ fileName, source }) => {
    const path = join(TMP_DIR, fileName);
    writeFileSync(path, source, "utf-8");
    return path;
  });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("compile gate: generated output (documents + shared datatypes) must compile under tsc --noEmit", () => {
  it("emits the resource/profile documents plus every complex datatype they reference, deduplicated", () => {
    const fileNames = emitted.map((r) => r.fileName);
    expect(fileNames).toContain("Patient.ts");
    expect(fileNames).toContain("USCorePatientProfile.ts");
    expect(fileNames).toContain("USCoreBloodPressureProfile.ts");
    expect(fileNames).toContain("observation-bodyheight.ts");
    // Shared complex datatypes — emitted once each, even though multiple
    // documents above reference them.
    for (const datatype of ["Identifier", "HumanName", "Address", "ContactPoint", "Reference", "CodeableConcept", "Period"]) {
      expect(fileNames).toContain(`${datatype}.ts`);
    }
    expect(fileNames.filter((n) => n === "Identifier.ts")).toHaveLength(1);
  });

  it("all emitted files compile together under tsc --noEmit", () => {
    expect(() => expectCompiles(filePaths)).not.toThrow();
  });

  it("a document whose name is not a valid TS identifier still compiles, and its file name keeps the original", () => {
    const hyphenated = emitted.find((r) => r.fileName === "observation-bodyheight.ts")!;
    expect(hyphenated.source).toContain("export const ObservationBodyheightSchema");
    expect(hyphenated.source).not.toContain("observation-bodyheightSchema");
  });

  it("the genuine Identifier <-> Reference cycle is emitted as z.lazy() on both sides, not z.unknown()", () => {
    const identifier = emitted.find((r) => r.fileName === "Identifier.ts")!;
    const reference = emitted.find((r) => r.fileName === "Reference.ts")!;
    expect(identifier.source).toContain("z.lazy(");
    expect(reference.source).toContain("z.lazy(");
    expect(identifier.source).not.toContain("z.unknown()");
    expect(reference.source).not.toContain("z.unknown()");
  });

  it("a non-cyclic complex-typed field (e.g. Patient.name -> HumanName) is a plain reference, not z.lazy()", () => {
    const patient = emitted.find((r) => r.fileName === "Patient.ts")!;
    expect(patient.source).toContain('import { HumanNameSchema } from "./HumanName.js";');
    expect(patient.source).toMatch(/"name":\s*z\.array\(HumanNameSchema\)/);
    expect(patient.source).not.toContain("z.lazy(");
  });
});

describe("semantic gate: generated USCorePatientProfile validates real data", () => {
  const example = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "examples", "uscore-patient-example.json"), "utf-8")
  ) as Record<string, unknown>;

  async function loadPatientSchema(): Promise<{ safeParse: (data: unknown) => { success: boolean } }> {
    const path = join(TMP_DIR, "USCorePatientProfile.ts");
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    return mod.USCorePatientProfileSchema as { safeParse: (data: unknown) => { success: boolean } };
  }

  it("accepts the conformant US Core Patient example from the package's own example/ directory", async () => {
    const schema = await loadPatientSchema();
    const result = schema.safeParse(example);
    expect(result.success).toBe(true);
  });

  it("rejects a Patient missing `name` (US Core requires at least one)", async () => {
    const schema = await loadPatientSchema();
    const withoutName = { ...example };
    delete withoutName.name;
    const result = schema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  it("rejects a Patient missing `gender` (US Core requires it)", async () => {
    const schema = await loadPatientSchema();
    const withoutGender = { ...example };
    delete withoutGender.gender;
    const result = schema.safeParse(withoutGender);
    expect(result.success).toBe(false);
  });

  it("rejects a Patient with a `gender` value outside the expanded administrative-gender enum (defect 2)", async () => {
    const schema = await loadPatientSchema();
    const badGender = { ...example, gender: "not-a-real-code" };
    const result = schema.safeParse(badGender);
    expect(result.success).toBe(false);
  });

  it("rejects a Patient whose identifier.assigner (Reference, resolved through the Identifier<->Reference cycle) is malformed", async () => {
    const schema = await loadPatientSchema();
    const withBadAssigner = {
      ...example,
      identifier: [{ ...(example.identifier as Record<string, unknown>[])[0], assigner: { reference: 42 } }],
    };
    const result = schema.safeParse(withBadAssigner);
    expect(result.success).toBe(false);
  });
});
