import { describe, it, expect } from "vitest";
import { generateSchemaFile } from "./mapper.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const patientDoc: FhirSchemaDocument = {
  url: "http://hl7.org/fhir/StructureDefinition/Patient",
  name: "Patient",
  type: "Patient",
  kind: "resource",
  derivation: "specialization",
  elements: {
    resourceType: { type: "code", required: true },
    active: { type: "boolean" },
    gender: {
      type: "code",
      binding: {
        strength: "required",
        valueSet: "http://hl7.org/fhir/ValueSet/administrative-gender",
        codes: ["male", "female", "other", "unknown"],
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

  it("turns required-strength bindings into z.enum", () => {
    const { source } = generateSchemaFile(patientDoc);
    expect(source).toContain(
      '"gender": z.enum(["male", "female", "other", "unknown"]).optional()'
    );
  });

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
