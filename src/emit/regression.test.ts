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
 * Scope note: only r4-patient (base) and uscore-patient (profile) are
 * exercised here. uscore-blood-pressure's base
 * (http://hl7.org/fhir/us/core/StructureDefinition/us-core-vital-signs) is
 * itself a profile, and merge/resolveDocument deliberately throws on
 * multi-level profile chains (see resolve.ts's module comment and
 * resolve.test.ts) — no committed fixture resolves that chain yet, so there
 * is nothing for this phase to emit for it. Slicing (what that fixture
 * exists to exercise) is phase 3d's job regardless.
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
import { emitDocument } from "./emit.js";
import { loadFixtureTerminologySource } from "../terminology/index.js";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";

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

function writeGenerated(fixtureName: string): string {
  const resolved = resolveDocument(loadFixture(fixtureName), schemaSource);
  const { fileName, source } = emitDocument(resolved, { terminology });
  const path = join(TMP_DIR, fileName);
  writeFileSync(path, source, "utf-8");
  return path;
}

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function expectCompiles(path: string): void {
  execFileSync(
    TSC_BIN,
    ["--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", path],
    { cwd: PROJECT_ROOT, stdio: "pipe" }
  );
}

describe("compile gate: generated output must compile under tsc --noEmit", () => {
  it("r4-patient (base resource, no profile merge needed)", () => {
    const path = writeGenerated("r4-patient.fhirschema.json");
    expect(() => expectCompiles(path)).not.toThrow();
  });

  it("uscore-patient (profile, resolved over r4-patient base)", () => {
    const path = writeGenerated("uscore-patient.fhirschema.json");
    expect(() => expectCompiles(path)).not.toThrow();
  });
});

describe("semantic gate: generated USCorePatientProfile validates real data", () => {
  const example = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "examples", "uscore-patient-example.json"), "utf-8")
  ) as Record<string, unknown>;

  async function loadPatientSchema(): Promise<{ safeParse: (data: unknown) => { success: boolean } }> {
    const path = writeGenerated("uscore-patient.fhirschema.json");
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
});
