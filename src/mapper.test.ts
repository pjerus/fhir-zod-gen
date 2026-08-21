import { describe, it, expect } from "vitest";
import { generateSchemaFile } from "./mapper.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const patientDoc: FhirSchemaDocument = {
  url: "http://hl7.org/fhir/StructureDefinition/Patient",
  name: "Patient",
  type: "Patient",
  kind: "resource",
  class: "resource",
  derivation: "specialization",
  elements: {
    // `min: 1` (not a `required` boolean — that field doesn't exist on a
    // real FhirSchemaElement, see fhir-schema-types.ts) is the one path that
    // currently makes mapper.ts emit a non-optional field.
    resourceType: { type: "code", min: 1 },
    active: { type: "boolean" },
    gender: {
      type: "code",
      binding: {
        strength: "required",
        valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender",
      },
    },
    name: {
      array: true,
      elements: {
        family: { type: "string" },
        given: { type: "string", array: true },
      },
    },
  },
};

describe("generateSchemaFile", () => {
  it("marks required elements as non-optional", () => {
    const { source } = generateSchemaFile(patientDoc);
    expect(source).toContain('"resourceType": z.string()');
    expect(source).not.toMatch(/"resourceType": z\.string\(\)\.optional\(\)/);
  });

  // The old version of this test asserted z.enum generation using a
  // `binding.codes` field. That field never existed on real FHIR Schema
  // output (see fhir-schema-types.ts) — see src/defects.test.ts defect #2
  // for the real (currently failing) behavior against real fixtures.

  it("recurses into nested backbone elements", () => {
    const { source } = generateSchemaFile(patientDoc);
    expect(source).toContain('"family": z.string().optional()');
    expect(source).toContain('"given": z.array(z.string()).optional()');
  });

  it("wraps array elements in z.array", () => {
    const { source } = generateSchemaFile(patientDoc);
    expect(source).toMatch(/"name": z\.array\(z\.object\(/);
  });

  it("emits a usable inferred type export", () => {
    const { source } = generateSchemaFile(patientDoc);
    expect(source).toContain("export type Patient = z.infer<typeof PatientSchema>;");
  });
});
