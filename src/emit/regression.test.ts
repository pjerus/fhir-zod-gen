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
 * issue #5 fixed that, so it is now in the gate. Slicing — what that fixture
 * primarily exists to exercise — is implemented now, and honoured by the
 * runtime slicing gate at the bottom of this file rather than only compiled.
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
  // have an identifier-safe name, so the compile gate never saw one. Gets
  // its own synthetic `url` (issue #14 made `url` the disambiguation key
  // across a batch, so reusing r4-patient's real url here — as if this were
  // a second document — would collide with the real Patient document above,
  // not exercise the identifier-sanitization path this fixture exists for).
  const hyphenated = resolveDocument(
    { ...loadFixture("r4-patient.fhirschema.json"), name: "observation-bodyheight", url: "http://hl7.org/fhir/StructureDefinition/observation-bodyheight" },
    schemaSource
  );
  // Choice types (value[x]): US Core Vital Signs has a required top-level
  // choice group (effective[x], required via vitalsigns.required inherited
  // through the chain), an optional top-level one with complex-typed
  // variants (value[x] -> Quantity/CodeableConcept/Period/...), and the
  // same optional group again nested inside a repeating BackboneElement
  // (component.value[x]) — real coverage for "required", "optional",
  // "complex variant type", and "nested" in one fixture.
  const usCoreVitalSigns = resolveDocument(loadFixture("uscore-vital-signs.fhirschema.json"), schemaSource);

  // Issue #34: real converter output that narrows Observation.value[x] as a
  // Quantity requiring value/unit/system/code, while its own
  // referenceRange.low/high stay plain — so this one document puts two
  // different expansions of `Quantity` into the batch, which is what used
  // to decide the shared Quantity.ts by iteration order.
  const r4BodyWeight = resolveDocument(loadFixture("r4-bodyweight.fhirschema.json"), schemaSource);

  emitted = emitPackage([r4Patient, usCorePatient, usCoreBloodPressure, hyphenated, usCoreVitalSigns, r4BodyWeight], {
    terminology,
  });

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
    // Issue #14: the file name is now the sanitized identifier, not the raw
    // FHIR Schema name — no more "observation-bodyheight.ts".
    expect(fileNames).toContain("ObservationBodyheight.ts");
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

  it("a document whose name is not a valid TS identifier still compiles, and its file name is the sanitized identifier (issue #14)", () => {
    const hyphenated = emitted.find((r) => r.fileName === "ObservationBodyheight.ts")!;
    expect(hyphenated).toBeDefined();
    expect(hyphenated.source).toContain("export const ObservationBodyheightSchema");
    expect(hyphenated.source).not.toContain("observation-bodyheightSchema");
  });

  it("the genuine Identifier <-> Reference cycle is emitted as z.lazy() on both sides, not z.unknown()", () => {
    const identifier = emitted.find((r) => r.fileName === "Identifier.ts")!;
    const reference = emitted.find((r) => r.fileName === "Reference.ts")!;
    // Asserted on the two cycle-forming fields specifically, not on the
    // whole file. The file-wide `not.toContain("z.unknown()")` this replaces
    // became the wrong question once issue #23 landed: Identifier and
    // Reference specialize Element, so they now correctly inherit its
    // `extension`, and Extension is deliberately absent from the fixture
    // SchemaSource (see merge/resolve.ts's module comment) — so an unrelated
    // field legitimately degrades to z.unknown() in this fixture-only build.
    // Narrowing to `assigner`/`identifier` keeps the real subject of the
    // test — that a genuine two-file cycle resolves to z.lazy() rather than
    // being given up on — while dropping a coincidence it was never about.
    expect(identifier.source).toContain('"assigner": z.lazy((): z.ZodTypeAny => ReferenceSchema)');
    expect(reference.source).toContain('"identifier": z.lazy((): z.ZodTypeAny => IdentifierSchema)');
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

describe("semantic gate: choice types (value[x]) validate real data", () => {
  // Minimal, hand-built payload satisfying every OTHER required field on
  // USCoreVitalSignsProfile (category, code, status, subject) so each test
  // below isolates the choice-group behavior it's actually checking.
  //
  // `category` was `[{}]` until slicing landed. That placeholder satisfied
  // the array's own `.min(1)` but matches no slice, and vital-signs profiles
  // slice `category` with a required `VSCat` (1..1) — so it now fails, and
  // correctly: a real Vital Signs Observation must carry that category. The
  // stand-in is filled in rather than the assertion weakened; these tests are
  // about choice groups and just need the rest of the resource to be legal.
  const base = {
    status: "final",
    code: {},
    category: [
      { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] },
    ],
    subject: {},
  };

  async function loadVitalSignsSchema(): Promise<{ safeParse: (data: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }> {
    const path = join(TMP_DIR, "USCoreVitalSignsProfile.ts");
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    return mod.USCoreVitalSignsProfileSchema as {
      safeParse: (data: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
    };
  }

  it("required group (effective[x]): accepts exactly one variant", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({ ...base, effectiveDateTime: "2020-01-01T00:00:00Z" });
    expect(result.success).toBe(true);
  });

  it("required group (effective[x]): rejects when none of the variants are provided", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({ ...base });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes("Exactly one of") && i.message.includes("effective[x]"))).toBe(true);
  });

  it("required group (effective[x]): rejects when two variants are both provided", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({
      ...base,
      effectiveDateTime: "2020-01-01T00:00:00Z",
      effectivePeriod: { start: "2020-01-01T00:00:00Z" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes("Exactly one of") && i.message.includes("effective[x]"))).toBe(true);
  });

  it("optional group (value[x]): accepts none of the variants provided", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({ ...base, effectiveDateTime: "2020-01-01T00:00:00Z" });
    expect(result.success).toBe(true);
  });

  it("optional group (value[x]): accepts a single complex-typed variant (valueQuantity)", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({
      ...base,
      effectiveDateTime: "2020-01-01T00:00:00Z",
      valueQuantity: { value: 72, unit: "beats/minute" },
    });
    expect(result.success).toBe(true);
  });

  it("optional group (value[x]): rejects valueQuantity and valueString both set", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({
      ...base,
      effectiveDateTime: "2020-01-01T00:00:00Z",
      valueQuantity: { value: 72 },
      valueString: "72 bpm",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes("At most one of") && i.message.includes("value[x]"))).toBe(true);
  });

  it("nested group (component.value[x]): accepts a single variant inside a repeating BackboneElement", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({
      ...base,
      effectiveDateTime: "2020-01-01T00:00:00Z",
      component: [{ code: {}, valueQuantity: { value: 120 } }],
    });
    expect(result.success).toBe(true);
  });

  it("nested group (component.value[x]): rejects two variants set on the same component", async () => {
    const schema = await loadVitalSignsSchema();
    const result = schema.safeParse({
      ...base,
      effectiveDateTime: "2020-01-01T00:00:00Z",
      component: [{ code: {}, valueQuantity: { value: 120 }, valueString: "120" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes("At most one of") && i.message.includes("value[x]"))).toBe(true);
  });
});

describe("semantic gate: slicing is enforced at runtime, not just emitted", () => {
  // The design doc (docs/design/slicing-design.md §6) asks specifically for
  // this: a conformant resource parses and a non-conformant one is rejected
  // by the emitted `.superRefine` actually running, rather than the generated
  // source merely looking right. Blood pressure is the fixture that exists
  // for slicing — `component` is 2..* overall with `systolic` and `diastolic`
  // slices at 1..1 each, matched on their LOINC codes.
  const systolic = {
    code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
    valueQuantity: { value: 120, unit: "mmHg" },
  };
  const diastolic = {
    code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] },
    valueQuantity: { value: 80, unit: "mmHg" },
  };
  const base = {
    status: "final",
    code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
    category: [
      { coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] },
    ],
    subject: {},
    effectiveDateTime: "2020-01-01T00:00:00Z",
  };

  async function loadBloodPressureSchema(): Promise<{
    safeParse: (data: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  }> {
    const path = join(TMP_DIR, "USCoreBloodPressureProfile.ts");
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    return mod.USCoreBloodPressureProfileSchema as {
      safeParse: (data: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
    };
  }

  it("accepts a conformant blood pressure: one component matching each slice", async () => {
    const schema = await loadBloodPressureSchema();
    expect(schema.safeParse({ ...base, component: [systolic, diastolic] }).success).toBe(true);
  });

  it("still accepts an extra component matching no slice — `rules: open` means unsliced members are legal", async () => {
    // The single most important thing not to get wrong: every observed
    // slicing block in US Core is `open`, so an unrecognised member must not
    // be a rejection.
    const other = { code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] }, valueQuantity: { value: 60 } };
    const schema = await loadBloodPressureSchema();
    expect(schema.safeParse({ ...base, component: [systolic, diastolic, other] }).success).toBe(true);
  });

  it("rejects a missing slice member (no systolic), naming the slice", async () => {
    const schema = await loadBloodPressureSchema();
    const result = schema.safeParse({ ...base, component: [diastolic, diastolic] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes('at least 1') && i.message.includes('"systolic"'))).toBe(true);
  });

  it("rejects two members of a 1..1 slice", async () => {
    const schema = await loadBloodPressureSchema();
    const result = schema.safeParse({ ...base, component: [systolic, systolic, diastolic] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message.includes('at most 1') && i.message.includes('"systolic"'))).toBe(true);
  });

  it("matches on the pattern's named keys only — a component carrying extra codings alongside the slice's still counts", async () => {
    // FHIR pattern semantics are partial-match, not deep equality. A real
    // resource routinely carries a second, local coding next to the LOINC one.
    const schema = await loadBloodPressureSchema();
    const withExtraCoding = {
      ...systolic,
      code: { coding: [{ system: "http://example.org/local", code: "SYS" }, { system: "http://loinc.org", code: "8480-6" }] },
    };
    expect(schema.safeParse({ ...base, component: [withExtraCoding, diastolic] }).success).toBe(true);
  });
});

/**
 * Issue #34. `r4-bodyweight` requires `value`/`unit`/`system`/`code` on the
 * Quantity it uses for `Observation.value[x]`; every other Quantity in the
 * batch (its own referenceRange.low/high, blood pressure's components)
 * requires nothing. One shared Quantity.ts serves them all, and it used to
 * be whichever expansion the walk reached first — which in
 * hl7.fhir.us.core#6.1.0 meant 11 narrowed use sites dictating terms to 590
 * unnarrowed ones, falsely rejecting 18 of that package's own examples.
 *
 * Asserted on the real emitted source rather than on internals: the bug was
 * only ever visible in the file that reaches disk.
 */
describe("issue #34: a profile's narrowing does not contaminate the shared datatype file", () => {
  function quantityFile() {
    return emitted.find((r) => r.fileName === "Quantity.ts")!;
  }

  /**
   * Asserted over *both* batch orders, because order is the whole bug and
   * the batch above happens to reach a plain Quantity first — verified by
   * reverting candidateConsensus to first-wins and watching only the
   * narrowed-first case fail.
   */
  it.each([
    ["as batched above", () => quantityFile().source],
    [
      "with the narrowing document first",
      () => {
        const narrowedFirst = emitPackage(
          [
            resolveDocument(loadFixture("r4-bodyweight.fhirschema.json"), schemaSource),
            resolveDocument(loadFixture("uscore-blood-pressure.fhirschema.json"), schemaSource),
          ],
          { terminology }
        );
        return narrowedFirst.find((r) => r.fileName === "Quantity.ts")!.source;
      },
    ],
  ])("emits a Quantity that accepts a legal bare value (%s)", (_label, sourceOf) => {
    const source = sourceOf();

    for (const field of ["value", "unit", "system", "code"]) {
      expect(source, `Quantity.${field} must not be required by the shared file`).toMatch(
        new RegExp(`"${field}": [^\\n]*\\.optional\\(\\)`)
      );
    }
  });

  it("says which narrowing it had to give up", () => {
    const warnings = quantityFile().warnings.join("\n");

    expect(warnings).toContain("Quantity");
    for (const field of ["value", "unit", "system", "code"]) {
      expect(warnings).toContain(field);
    }
  });

  it("actually accepts a Quantity carrying only a value, at runtime", async () => {
    const mod = (await import(pathToFileURL(join(TMP_DIR, "Quantity.ts")).href)) as {
      QuantitySchema: { safeParse(d: unknown): { success: boolean } };
    };

    expect(mod.QuantitySchema.safeParse({ value: 43 }).success).toBe(true);
    // The shape from US Core's own Observation-cbc-hematocrit example, which
    // this bug rejected: a UCUM quantity with no `code`.
    expect(mod.QuantitySchema.safeParse({ value: 43, unit: "%", system: "http://unitsofmeasure.org" }).success).toBe(
      true
    );
  });
});
