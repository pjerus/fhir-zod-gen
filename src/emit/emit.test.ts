import { describe, it, expect } from "vitest";
import { emitDocument } from "./emit.js";
import type { ResolvedElement, ResolvedSchema } from "../merge/index.js";

/** Fills in the fields every ResolvedElement must have, so call sites only spell out what they're testing. */
function el(overrides: Partial<ResolvedElement> & Pick<ResolvedElement, "type">): ResolvedElement {
  return { array: false, min: 0, max: undefined, required: false, ...overrides };
}

function schema(elements: Record<string, ResolvedElement>, overrides: Partial<ResolvedSchema> = {}): ResolvedSchema {
  return {
    name: "TestResource",
    url: "http://example.org/TestResource",
    type: "TestResource",
    kind: "resource",
    elements,
    ...overrides,
  };
}

describe("emitDocument", () => {
  it("emits a required primitive field with no .optional()", () => {
    const { source } = emitDocument(schema({ gender: el({ type: "code", required: true }) }));
    expect(source).toContain('"gender": z.string(),');
  });

  it("emits an optional primitive field with .optional()", () => {
    const { source } = emitDocument(schema({ active: el({ type: "boolean", required: false }) }));
    expect(source).toContain('"active": z.boolean().optional()');
  });

  it("keeps uri/url/canonical as plain z.string(), not z.string().url()", () => {
    const { source } = emitDocument(
      schema({
        system: el({ type: "uri", required: true }),
        homepage: el({ type: "url", required: true }),
        profile: el({ type: "canonical", required: true }),
      })
    );
    expect(source).toContain('"system": z.string(),');
    expect(source).toContain('"homepage": z.string(),');
    expect(source).toContain('"profile": z.string(),');
    expect(source).not.toContain(".url()");
  });

  it("wraps a repeating field in z.array and emits .min()/.max() from resolved cardinality", () => {
    const { source } = emitDocument(
      schema({ component: el({ type: "string", array: true, min: 2, max: 4, required: true }) })
    );
    expect(source).toContain('"component": z.array(z.string()).min(2).max(4),');
  });

  it("omits .min() when resolved min is 0, and omits .max() when max is unbounded (\"*\")", () => {
    const { source } = emitDocument(
      schema({ name: el({ type: "string", array: true, min: 0, max: "*", required: true }) })
    );
    expect(source).toContain('"name": z.array(z.string()),');
  });

  it("recurses into nested (resolved) elements as z.object", () => {
    const { source } = emitDocument(
      schema({
        name: el({
          type: "HumanName",
          array: true,
          required: false,
          elements: {
            family: el({ type: "string", required: false }),
            given: el({ type: "string", array: true, required: false }),
          },
        }),
      })
    );
    expect(source).toMatch(/"name": z\.array\(z\.object\(\{/);
    expect(source).toContain('"family": z.string().optional(),');
    expect(source).toContain('"given": z.array(z.string()).optional(),');
  });

  it("emits an invariant TODO marker per constraint id, keyed by id (Record, not array)", () => {
    const { source } = emitDocument(
      schema({
        name: el({
          type: "HumanName",
          required: false,
          constraint: {
            "us-core-6": {
              expression: "family.exists() or given.exists()",
              human: "At least family or given must be present.",
              severity: "error",
            },
          },
        }),
      })
    );
    expect(source).toContain("TODO(invariant us-core-6): At least family or given must be present.");
  });

  it("escapes a `*/` inside constraint human text so it can't close the comment early", () => {
    const { source } = emitDocument(
      schema({
        weird: el({
          type: "string",
          required: false,
          constraint: {
            "weird-1": { expression: "true", human: "contains */ a close marker", severity: "warning" },
          },
        }),
      })
    );
    expect(source).toContain("contains *-/ a close marker");
    expect(source).not.toContain("contains */ a close marker");
  });

  it("falls back to z.unknown() with a defect-5 TODO for a cyclic reference, instead of recursing forever", () => {
    const { source, warnings } = emitDocument(
      schema({ assigner: el({ type: "Identifier", isCyclic: true, required: false }) })
    );
    expect(source).toContain('"assigner": z.unknown()');
    expect(source).toContain("TODO(defect 5)");
    expect(source).toContain("cyclic reference");
    expect(warnings).toHaveLength(1);
  });

  it("falls back to z.unknown() with a defect-5 TODO for a complex type with no resolved structure (e.g. Extension)", () => {
    const { source, warnings } = emitDocument(
      schema({ extension: el({ type: "Extension", required: false }) })
    );
    expect(source).toContain('"extension": z.unknown()');
    expect(source).toContain("TODO(defect 5)");
    expect(source).not.toContain("ExtensionSchema");
    expect(warnings).toHaveLength(1);
  });

  it("falls back to z.unknown() with a phase-3c TODO for a choice-type group marker, and skips its variants", () => {
    const { source } = emitDocument(
      schema({
        deceased: el({ type: "unknown", choices: ["deceasedBoolean", "deceasedDateTime"], required: false }),
        deceasedBoolean: el({ type: "boolean", choiceOf: "deceased", required: false }),
        deceasedDateTime: el({ type: "dateTime", choiceOf: "deceased", required: false }),
      })
    );
    expect(source).toContain('"deceased": z.unknown()');
    expect(source).toContain("TODO(phase 3c)");
    expect(source).not.toContain('"deceasedBoolean"');
    expect(source).not.toContain('"deceasedDateTime"');
  });

  it("emits a readable header, the schema const, and an inferred type export", () => {
    const { fileName, source } = emitDocument(
      schema(
        { active: el({ type: "boolean", required: false }) },
        { name: "Patient", url: "http://hl7.org/fhir/StructureDefinition/Patient", kind: "resource" }
      )
    );
    expect(fileName).toBe("Patient.ts");
    expect(source).toContain('import { z } from "zod";');
    expect(source).toContain("// Source: http://hl7.org/fhir/StructureDefinition/Patient");
    expect(source).toContain("export const PatientSchema = z.object({");
    expect(source).toContain("export type Patient = z.infer<typeof PatientSchema>;");
  });

  it("notes a profile (derivation: constraint) narrows its base, in the header comment", () => {
    const { source } = emitDocument(
      schema(
        { active: el({ type: "boolean", required: false }) },
        { derivation: "constraint", base: "http://hl7.org/fhir/StructureDefinition/Patient" }
      )
    );
    expect(source).toContain("// This is a profile (constraint)");
    expect(source).toContain("// Kind: resource, base: http://hl7.org/fhir/StructureDefinition/Patient");
  });
});
