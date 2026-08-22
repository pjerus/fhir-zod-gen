import { describe, it, expect } from "vitest";
import { emitDocument, emitPackage } from "./emit.js";
import type { ResolvedElement, ResolvedSchema } from "../merge/index.js";
import type { TerminologySource } from "../terminology/index.js";

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

  it("emits a plain cross-file reference (not z.unknown()) for a type that is cyclic *within itself*, not with this document — issue #6", () => {
    // A document is never itself part of a datatype cycle (FHIR resources
    // aren't referenced back by the complex types they use) — see
    // emit.ts's buildCyclicEdgeChecker doc comment. z.lazy() only shows up
    // inside the cyclic TYPE's own emitted file (Identifier.ts here), which
    // emitDocument alone doesn't produce (only emitPackage does — see the
    // "wraps both directions of a genuine two-file cycle" test below for
    // that). This test mirrors real merge/ output: the FIRST occurrence of
    // a type in a top-down walk always carries its full elements (here,
    // "identifier" supplies Identifier's own fields, including its own
    // "assigner" field pointing back at "Identifier" — the re-entrant,
    // merge/-cut occurrence that has no elements of its own).
    const { source, fileName } = emitDocument(
      schema({
        identifier: el({
          type: "Identifier",
          isNamedType: true,
          required: false,
          elements: {
            assigner: el({ type: "Identifier", isNamedType: true, isCyclic: true, required: false }),
          },
        }),
      })
    );
    expect(fileName).toBe("TestResource.ts");
    expect(source).toContain('import { IdentifierSchema } from "./Identifier.js";');
    expect(source).toContain('"identifier": IdentifierSchema.optional()');
    expect(source).not.toContain("z.unknown()");
  });

  it("emits a non-cyclic named-type reference as a plain reference, not z.lazy()", () => {
    const { source } = emitDocument(
      schema({ name: el({ type: "HumanName", isNamedType: true, required: false }) })
    );
    expect(source).toContain('import { HumanNameSchema } from "./HumanName.js";');
    expect(source).toContain('"name": HumanNameSchema.optional()');
    expect(source).not.toContain("z.lazy(");
  });

  it("falls back to z.unknown() with a loud TODO for a complex type with no resolved structure (e.g. Extension)", () => {
    const { source, warnings } = emitDocument(
      schema({ extension: el({ type: "Extension", required: false }) })
    );
    expect(source).toContain('"extension": z.unknown()');
    expect(source).toContain("TODO:");
    expect(source).not.toContain("ExtensionSchema");
    expect(warnings).toHaveLength(1);
  });

  it("keeps a primitive-typed element primitive even when it carries an extension slice's own elements (issue #24)", () => {
    // Real shape, from hl7.fhir.us.core#6.1.0's QuestionnaireResponse
    // profile: `questionnaire` is a `canonical` that also has the
    // us-core-extension-questionnaire-uri extension attached, so merge/
    // legitimately populates `elements: { extension }` on it. FHIR JSON puts
    // a primitive's extensions in a *sibling* `_questionnaire` key, never
    // inside the value, so the value's own schema is still just z.string().
    const { source } = emitDocument(
      schema({
        questionnaire: el({
          type: "canonical",
          required: false,
          elements: { extension: el({ type: "Extension", required: false }) },
        }),
      })
    );
    expect(source).toContain('"questionnaire": z.string().optional()');
    expect(source).not.toContain('"questionnaire": z.object(');
  });

  describe("choice types (value[x])", () => {
    function deceasedGroup(required: boolean) {
      return {
        deceased: el({ type: "unknown", choices: ["deceasedBoolean", "deceasedDateTime"], required }),
        deceasedBoolean: el({ type: "boolean", choiceOf: "deceased", required: false }),
        deceasedDateTime: el({ type: "dateTime", choiceOf: "deceased", required: false }),
      };
    }

    it("flattens variants into independent optional fields with their real types, and never emits the group marker itself as a key", () => {
      const { source } = emitDocument(schema(deceasedGroup(false)));
      expect(source).toContain('"deceasedBoolean": z.boolean().optional()');
      expect(source).toContain('"deceasedDateTime": z.string().optional()');
      expect(source).not.toContain('"deceased":');
      expect(source).not.toContain("z.unknown()");
    });

    it("emits an at-most-one .superRefine() for an optional choice group", () => {
      const { source } = emitDocument(schema(deceasedGroup(false)));
      expect(source).toContain(".superRefine((data, ctx) => {");
      expect(source).toContain('const present = (["deceasedBoolean", "deceasedDateTime"] as const).filter((key) => data[key] !== undefined);');
      expect(source).toContain("if (present.length > 1) {");
      expect(source).toContain('code: "custom"');
      expect(source).toContain('At most one of deceasedBoolean, deceasedDateTime may be set (choice type "deceased[x]")');
      expect(source).toContain("path: present,");
      // Not the required-group wording.
      expect(source).not.toContain("Exactly one of");
    });

    it("emits an exactly-one .superRefine() for a required choice group, distinct wording for zero vs. multiple present", () => {
      const { source } = emitDocument(schema(deceasedGroup(true)));
      expect(source).toContain("if (present.length !== 1) {");
      expect(source).toContain('Exactly one of deceasedBoolean, deceasedDateTime is required (choice type "deceased[x]"), but none were provided.');
      expect(source).toContain("but multiple were provided: ${present.join(\", \")}.`,");
      expect(source).toContain('path: present.length === 0 ? ["deceased"] : present,');
      // Not the optional-group wording.
      expect(source).not.toContain("At most one of");
    });

    it("a complex-typed variant (e.g. valueQuantity -> Quantity) keeps its real cross-file reference, not z.unknown()", () => {
      const { source } = emitDocument(
        schema({
          value: el({ type: "unknown", choices: ["valueQuantity", "valueString"], required: false }),
          valueQuantity: el({ type: "Quantity", isNamedType: true, choiceOf: "value", required: false }),
          valueString: el({ type: "string", choiceOf: "value", required: false }),
        })
      );
      expect(source).toContain('import { QuantitySchema } from "./Quantity.js";');
      expect(source).toContain('"valueQuantity": QuantitySchema.optional()');
      expect(source).not.toContain("z.unknown()");
    });

    it("handles a choice group nested inside a BackboneElement", () => {
      const { source } = emitDocument(
        schema({
          component: el({
            type: "BackboneElement",
            array: true,
            required: false,
            elements: {
              code: el({ type: "string", required: true }),
              ...deceasedGroup(false),
            },
          }),
        })
      );
      // The nested object gets its own superRefine, independent of the outer one.
      expect(source).toMatch(/"component": z\.array\(z\.object\(\{[\s\S]*"deceasedBoolean"[\s\S]*\}\)\.superRefine/);
      expect(source).toContain('At most one of deceasedBoolean, deceasedDateTime may be set (choice type "deceased[x]")');
    });

    it("multiple choice groups at the same level share one .superRefine() call, not one per group", () => {
      const { source } = emitDocument(
        schema({
          ...deceasedGroup(false),
          multipleBirth: el({ type: "unknown", choices: ["multipleBirthBoolean", "multipleBirthInteger"], required: false }),
          multipleBirthBoolean: el({ type: "boolean", choiceOf: "multipleBirth", required: false }),
          multipleBirthInteger: el({ type: "integer", choiceOf: "multipleBirth", required: false }),
        })
      );
      expect(source.match(/\.superRefine\(/g)).toHaveLength(1);
      expect(source).toContain("deceased[x]");
      expect(source).toContain("multipleBirth[x]");
    });
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

  it("derives the file name from the sanitized identifier, not the raw name (issue #14)", () => {
    const { fileName, source } = emitDocument(
      schema({}, { name: "Actual Group", url: "http://example.org/StructureDefinition/actual-group" })
    );
    expect(fileName).toBe("ActualGroup.ts");
    expect(source).toContain("export const ActualGroupSchema");
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

  describe("required-strength bindings -> z.enum (defect 2)", () => {
    /** In-memory TerminologySource — a single ValueSet/CodeSystem pair, no fs. */
    function stubTerminology(valueSetUrl: string, codes: string[]): TerminologySource {
      return {
        getValueSet: (url) =>
          url === valueSetUrl
            ? { resourceType: "ValueSet", url, compose: { include: [{ system: "http://example.org/cs" }] } }
            : undefined,
        getCodeSystem: (url) =>
          url === "http://example.org/cs"
            ? { resourceType: "CodeSystem", url, concept: codes.map((code) => ({ code })) }
            : undefined,
      };
    }

    it("emits z.enum([...]) for a required binding whose ValueSet expands successfully", () => {
      const terminology = stubTerminology("http://example.org/vs/gender", ["male", "female", "other", "unknown"]);
      const { source } = emitDocument(
        schema({
          gender: el({ type: "code", required: true, binding: { strength: "required", valueSet: "http://example.org/vs/gender" } }),
        }),
        { terminology }
      );
      expect(source).toContain('"gender": z.enum(["male", "female", "other", "unknown"]),');
    });

    it("keeps an extensible binding as plain z.string(), even with a terminology source that could expand it", () => {
      const terminology = stubTerminology("http://example.org/vs/state", ["AA", "AE"]);
      const { source } = emitDocument(
        schema({
          state: el({ type: "code", required: false, binding: { strength: "extensible", valueSet: "http://example.org/vs/state" } }),
        }),
        { terminology }
      );
      expect(source).toContain('"state": z.string().optional()');
      expect(source).not.toContain("z.enum(");
    });

    it("keeps a preferred binding as plain z.string()", () => {
      const terminology = stubTerminology("http://example.org/vs/lang", ["en", "es"]);
      const { source } = emitDocument(
        schema({
          language: el({ type: "code", required: false, binding: { strength: "preferred", valueSet: "http://example.org/vs/lang" } }),
        }),
        { terminology }
      );
      expect(source).toContain('"language": z.string().optional()');
      expect(source).not.toContain("z.enum(");
    });

    it("degrades to z.string() with a TODO(defect 2) marker, and does not throw, when the ValueSet is absent from the source", () => {
      const emptyTerminology: TerminologySource = { getValueSet: () => undefined, getCodeSystem: () => undefined };
      const { source, warnings } = emitDocument(
        schema({
          linkType: el({ type: "code", required: true, binding: { strength: "required", valueSet: "http://example.org/vs/missing" } }),
        }),
        { terminology: emptyTerminology }
      );
      expect(source).toContain('"linkType": z.string() /* TODO(defect 2)');
      expect(source).not.toContain("z.enum(");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not be expanded");
    });

    it("degrades to z.string() with a TODO(defect 2) marker when no terminology source is configured at all", () => {
      const { source, warnings } = emitDocument(
        schema({
          gender: el({ type: "code", required: true, binding: { strength: "required", valueSet: "http://example.org/vs/gender" } }),
        })
      );
      expect(source).toContain('"gender": z.string() /* TODO(defect 2)');
      expect(warnings[0]).toContain("no terminology source configured");
    });
  });
});

describe("emitPackage", () => {
  it("emits one file per document plus one file per complex datatype they reference, deduplicated across the whole batch", () => {
    const identifierElements: Record<string, ResolvedElement> = {
      value: el({ type: "string", required: false }),
    };
    const patient = schema(
      { identifier: el({ type: "Identifier", isNamedType: true, required: false, elements: identifierElements }) },
      { name: "Patient", url: "http://hl7.org/fhir/StructureDefinition/Patient" }
    );
    const observation = schema(
      { subject: el({ type: "Identifier", isNamedType: true, required: false, elements: identifierElements }) },
      { name: "Observation", url: "http://hl7.org/fhir/StructureDefinition/Observation" }
    );

    const results = emitPackage([patient, observation]);
    const fileNames = results.map((r) => r.fileName).sort();

    expect(fileNames).toEqual(["Identifier.ts", "Observation.ts", "Patient.ts"]);
    const identifierFile = results.find((r) => r.fileName === "Identifier.ts")!;
    expect(identifierFile.source).toContain("export const IdentifierSchema = z.object({");
    expect(identifierFile.source).toContain('"value": z.string().optional(),');
  });

  it("wraps both directions of a genuine two-file cycle in z.lazy(), regardless of which occurrence merge/ happened to flag isCyclic", () => {
    // Mirrors the real Identifier <-> Reference cycle: Identifier.assigner
    // (full elements, not itself flagged cyclic) points at Reference, whose
    // own "identifier" field is the one merge/ cut (isCyclic, no elements).
    const referenceElements: Record<string, ResolvedElement> = {
      identifier: el({ type: "Identifier", isNamedType: true, isCyclic: true, required: false }),
    };
    const identifierElements: Record<string, ResolvedElement> = {
      assigner: el({ type: "Reference", isNamedType: true, required: false, elements: referenceElements }),
    };
    const patient = schema(
      { identifier: el({ type: "Identifier", isNamedType: true, required: false, elements: identifierElements }) },
      { name: "Patient", url: "http://hl7.org/fhir/StructureDefinition/Patient" }
    );

    const results = emitPackage([patient]);
    const identifierFile = results.find((r) => r.fileName === "Identifier.ts")!;
    const referenceFile = results.find((r) => r.fileName === "Reference.ts")!;

    // The occurrence merge/ flagged isCyclic (Reference.identifier) is lazy...
    expect(referenceFile.source).toContain('"identifier": z.lazy((): z.ZodTypeAny => IdentifierSchema)');
    // ...and so is the OTHER direction (Identifier.assigner), even though
    // merge/ never flagged it — required for runtime safety against
    // circular-ES-module load order, see emit.ts's module comment.
    expect(identifierFile.source).toContain('"assigner": z.lazy((): z.ZodTypeAny => ReferenceSchema)');

    // Patient -> Identifier is NOT part of the cycle: plain reference.
    const patientFile = results.find((r) => r.fileName === "Patient.ts")!;
    expect(patientFile.source).toContain('"identifier": IdentifierSchema.optional()');
    expect(patientFile.source).not.toContain("z.lazy(");
  });

  it("a self-referential datatype refers to its own local const instead of importing itself (issue #23)", () => {
    // Real shape, and only reachable once specializations inherit from their
    // base: Extension specializes Element, and Element.extension is itself
    // an Extension. The self-edge was already emitted as z.lazy() correctly
    // (it is a genuine cycle), but the file also emitted
    // `import { ExtensionSchema } from "./Extension.js"` alongside its own
    // `export const ExtensionSchema`, which tsc rejects outright:
    // "Import declaration conflicts with local declaration".
    const extensionElements: Record<string, ResolvedElement> = {
      url: el({ type: "uri", required: true }),
      extension: el({ type: "Extension", isNamedType: true, isCyclic: true, array: true, required: false }),
    };
    const patient = schema(
      { extension: el({ type: "Extension", isNamedType: true, array: true, required: false, elements: extensionElements }) },
      { name: "Patient", url: "http://hl7.org/fhir/StructureDefinition/Patient" }
    );

    const extensionFile = emitPackage([patient]).find((r) => r.fileName === "Extension.ts")!;

    expect(extensionFile.source).toContain("export const ExtensionSchema");
    expect(extensionFile.source).toContain('"extension": z.array(z.lazy((): z.ZodTypeAny => ExtensionSchema))');
    expect(extensionFile.source).not.toContain('from "./Extension.js"');
  });

  describe("issue #14: duplicate document names", () => {
    it("two documents with the same name but different urls produce two files and two exported consts, not one overwriting the other", () => {
      const first = schema({}, { name: "Example Lipid Profile", url: "http://example.org/StructureDefinition/lipid-1" });
      const second = schema({}, { name: "Example Lipid Profile", url: "http://example.org/StructureDefinition/lipid-2" });

      const results = emitPackage([first, second]);

      expect(results).toHaveLength(2);
      const fileNames = results.map((r) => r.fileName);
      // Neither file is silently dropped, and the two names are distinct.
      expect(new Set(fileNames).size).toBe(2);
      // Every colliding member gets a suffix — no arbitrary "first one wins
      // the bare name" that would depend on array order.
      for (const name of fileNames) {
        expect(name).toMatch(/^ExampleLipidProfile_[0-9a-z]+\.ts$/);
      }

      // Each file's own const/type identifier agrees with its file name.
      for (const result of results) {
        const ident = result.fileName.replace(/\.ts$/, "");
        expect(result.source).toContain(`export const ${ident}Schema = `);
        expect(result.source).toContain(`export type ${ident} = z.infer<typeof ${ident}Schema>;`);
      }
    });

    it("is deterministic: re-running emitPackage over the same input produces byte-identical file names", () => {
      const docs = [
        schema({}, { name: "Example Lipid Profile", url: "http://example.org/StructureDefinition/lipid-1" }),
        schema({}, { name: "Example Lipid Profile", url: "http://example.org/StructureDefinition/lipid-2" }),
        schema({}, { name: "Example Lipid Profile", url: "http://example.org/StructureDefinition/lipid-3" }),
      ];

      const first = emitPackage(docs).map((r) => r.fileName).sort();
      const second = emitPackage(docs).map((r) => r.fileName).sort();

      expect(second).toEqual(first);
    });

    it("a document name that isn't a valid TS identifier is sanitized in the file name too, not just the const (issue #14 point 1)", () => {
      const results = emitPackage([schema({}, { name: "Actual Group", url: "http://example.org/StructureDefinition/actual-group" })]);
      expect(results).toHaveLength(1);
      expect(results[0].fileName).toBe("ActualGroup.ts");
    });

    it("a non-colliding name is left bare, with no suffix", () => {
      const results = emitPackage([schema({}, { name: "Patient", url: "http://hl7.org/fhir/StructureDefinition/Patient" })]);
      expect(results[0].fileName).toBe("Patient.ts");
    });

    it("throws rather than silently overwriting when two documents share the same url", () => {
      const dup = schema({}, { name: "Patient", url: "http://hl7.org/fhir/StructureDefinition/Patient" });
      expect(() => emitPackage([dup, { ...dup }])).toThrow(/same url/);
    });
  });
});
