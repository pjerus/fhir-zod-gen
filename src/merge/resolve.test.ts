import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveDocument } from "./resolve.js";
import { loadFixtureSchemaSource, FixtureSchemaSource } from "./fixture-schema-source.js";
import type { ResolvedElement, ResolvedSchema } from "./resolved-schema.js";
import type { SchemaSource } from "./schema-source.js";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

let source: FixtureSchemaSource;
let uscorePatient: ResolvedSchema;
let bloodPressure: ResolvedSchema;

function loadFixtureDoc(fileName: string): FhirSchemaDocument {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, fileName), "utf-8")) as FhirSchemaDocument;
}

beforeAll(() => {
  source = loadFixtureSchemaSource(FIXTURES_DIR);
  uscorePatient = resolveDocument(loadFixtureDoc("uscore-patient.fhirschema.json"), source);
  bloodPressure = resolveDocument(loadFixtureDoc("uscore-blood-pressure.fhirschema.json"), source);
});

/** Walks every element in a resolved tree, depth-first, for whole-tree assertions. */
function walkElements(
  elements: Record<string, ResolvedElement>,
  visit: (path: string, el: ResolvedElement) => void,
  prefix = ""
): void {
  for (const [name, el] of Object.entries(elements)) {
    const path = prefix ? `${prefix}.${name}` : name;
    visit(path, el);
    if (el.elements) {
      walkElements(el.elements, visit, path);
    }
  }
}

describe("resolveDocument — US Core Patient (gate from design doc section 4, Phase 2)", () => {
  it("resolves name.array === true, inherited from base r4-patient (name itself carries no array)", () => {
    expect(uscorePatient.elements.name?.type).toBe("HumanName");
    expect(uscorePatient.elements.name?.array).toBe(true);
  });

  it("resolves name's children (family, given) to concrete string types via HumanName, not left unresolved", () => {
    const family = uscorePatient.elements.name?.elements?.family;
    const given = uscorePatient.elements.name?.elements?.given;
    expect(family?.type).toBe("string");
    expect(given?.type).toBe("string");
    expect(given?.array).toBe(true); // HumanName.given is repeating in base R4
    // mustSupport narrowed by the profile survives the merge.
    expect(family?.mustSupport).toBe(true);
    expect(given?.mustSupport).toBe(true);
  });

  it("has zero elements with type 'unknown' anywhere in the resolved tree", () => {
    // Choice-type group markers (e.g. "deceased" with choices:
    // ["deceasedBoolean","deceasedDateTime"]) are a legitimate exception:
    // FHIR Schema gives the group marker itself no `type` at all — each
    // variant (deceasedBoolean, deceasedDateTime) carries its own concrete
    // type instead. That's a real, different shape from defect 4's "profile
    // narrowed and nobody filled in the type" gap; choice-type emission is
    // Phase 3's job (design doc section 4), not something merge/ needs to
    // resolve away.
    const unresolved: string[] = [];
    walkElements(uscorePatient.elements, (path, el) => {
      if (el.type === "unknown" && !el.choices) unresolved.push(path);
    });
    expect(unresolved).toEqual([]);
  });

  it("resolves every element reachable through name/identifier/telecom/address/communication to a concrete type", () => {
    // A broader sweep than the single-field checks above — every element in
    // these five subtrees (not just the ones the profile happens to narrow)
    // must come out with array/min set and type non-empty.
    for (const key of ["name", "identifier", "telecom", "address", "communication"]) {
      const root = uscorePatient.elements[key];
      expect(root, `expected top-level element "${key}"`).toBeDefined();
      walkElements({ [key]: root! }, (path, el) => {
        expect(el.type, `element "${path}" has no concrete type`).toBeTruthy();
        expect(typeof el.array, `element "${path}".array should be a boolean`).toBe("boolean");
        expect(typeof el.min, `element "${path}".min should be a number`).toBe("number");
      });
    }
  });
});

describe("resolveDocument — defect 6 (requiredness comes from the PARENT's required array)", () => {
  it("marks identifier itself required (it's in the document's own required array)", () => {
    expect(uscorePatient.elements.identifier?.required).toBe(true);
  });

  it("marks identifier.system and identifier.value required (identifier's OWN required array names its children)", () => {
    expect(uscorePatient.elements.identifier?.elements?.system?.required).toBe(true);
    expect(uscorePatient.elements.identifier?.elements?.value?.required).toBe(true);
  });

  it("marks identifier.use NOT required — present in identifier.elements but absent from identifier.required", () => {
    expect(uscorePatient.elements.identifier?.elements?.use?.required).toBe(false);
  });

  it(
    "marks communication NOT required (absent from the document's required array) even though it HAS " +
      "required children — the exact 'my children are required' vs 'I am required' confusion defect 6 names",
    () => {
      expect(uscorePatient.elements.communication?.required).toBe(false);
    }
  );

  it(
    "marks communication.language required — inherited from base r4-patient's communication.required:" +
      '["language"], even though US Core Patient\'s OWN communication element never restates `required`. ' +
      "Proves inheritance (profile silent -> base value inherited), not a reset to nothing-required.",
    () => {
      expect(uscorePatient.elements.communication?.elements?.language?.required).toBe(true);
    }
  );

  it("marks communication.preferred NOT required — inherited from base, base never listed it either", () => {
    expect(uscorePatient.elements.communication?.elements?.preferred?.required).toBe(false);
  });
});

describe("resolveDocument — cycle detection (Reference <-> Identifier)", () => {
  it("terminates and marks the re-entrant element cyclic instead of expanding forever", () => {
    // identifier.assigner : Reference; Reference.identifier : Identifier —
    // walking that path from US Core Patient's own `identifier` element is
    // the real path this resolver takes, not a synthetic one.
    const assigner = uscorePatient.elements.identifier?.elements?.assigner;
    expect(assigner?.type).toBe("Reference");
    expect(assigner?.isCyclic).toBeFalsy(); // Reference itself isn't the cycle point
    const nestedIdentifier = assigner?.elements?.identifier;
    expect(nestedIdentifier?.type).toBe("Identifier");
    expect(nestedIdentifier?.isCyclic).toBe(true);
    expect(nestedIdentifier?.elements).toBeUndefined();
  });

  it("still resolves Reference's other (non-cyclic) fields normally", () => {
    const assigner = uscorePatient.elements.identifier?.elements?.assigner;
    expect(assigner?.elements?.reference?.type).toBe("string");
    expect(assigner?.elements?.display?.type).toBe("string");
  });
});

describe("resolveDocument — specializations inherit from their base too (issue #23)", () => {
  it("resolves `extension` as an array — `array: true` is stated only on DomainResource, two levels up a chain of specializations", () => {
    // The whole of #23. us-core-patient (constraint) -> Patient
    // (specialization) -> DomainResource (specialization) -> Resource. Only
    // the first hop is a profile; stopping the walk at the first
    // non-profile, as this resolver used to, never reaches the one document
    // that says `extension` repeats.
    expect(loadFixtureDoc("r4-patient.fhirschema.json").elements?.extension).toBeUndefined();
    expect(uscorePatient.elements.extension?.array).toBe(true);
  });

  it("inherits DomainResource's own fields onto a resource whose document restates none of them", () => {
    const r4Patient = loadFixtureDoc("r4-patient.fhirschema.json");
    for (const name of ["text", "contained", "modifierExtension"]) {
      expect(r4Patient.elements?.[name], `r4-patient's own document should not restate ${name}`).toBeUndefined();
      expect(uscorePatient.elements[name]?.type, `${name} should resolve via DomainResource`).toBeTruthy();
    }
    expect(uscorePatient.elements.text?.type).toBe("Narrative");
    expect(uscorePatient.elements.contained?.array).toBe(true);
  });

  it("inherits Resource's fields from the far end of the chain (two specialization hops up)", () => {
    expect(uscorePatient.elements.id?.type).toBe("string");
    expect(uscorePatient.elements.meta?.type).toBe("Meta");
    expect(uscorePatient.elements.implicitRules?.type).toBe("uri");
    expect(uscorePatient.elements.language?.type).toBe("code");
  });

  it("applies to BackboneElements — they inherit modifierExtension from BackboneElement and id/extension from Element", () => {
    const communication = uscorePatient.elements.communication;
    expect(communication?.type).toBe("BackboneElement");
    expect(communication?.elements?.modifierExtension?.array).toBe(true);
    expect(communication?.elements?.extension?.array).toBe(true);
    expect(communication?.elements?.id?.type).toBe("string");
  });

  it("merges those inherited fields UNDER the profile chain's own structure, never over it", () => {
    // The regression this guards: assigning BackboneElement's three-field
    // map to childResolvedBase instead of merging it discards everything the
    // base chain already resolved for this backbone, and every real child
    // (here `language`, whose CodeableConcept type comes from base
    // r4-patient) collapses to "unknown".
    const language = uscorePatient.elements.communication?.elements?.language;
    expect(language?.type).toBe("CodeableConcept");
    expect(language?.required).toBe(true);
  });

  it("applies to complex datatypes as well — HumanName specializes Element, so it inherits `id`/`extension`", () => {
    const name = uscorePatient.elements.name;
    expect(loadFixtureDoc("datatypes/HumanName.fhirschema.json").elements?.id).toBeUndefined();
    expect(name?.elements?.id?.type).toBe("string");
    expect(name?.elements?.extension?.array).toBe(true);
  });

  it("a specialization whose base is absent from the SchemaSource degrades to its own elements, rather than throwing the way a profile does", () => {
    // Asymmetric on purpose: a profile states only its narrowings, so a
    // missing base leaves nothing to resolve against and must throw (see the
    // out-of-scope-base-chain block below). A specialization's own elements
    // are already concrete — a missing base costs it only the inherited
    // ones, which is a smaller gap than refusing to resolve at all.
    const orphan: FhirSchemaDocument = {
      name: "Orphan",
      url: "http://example.org/Orphan",
      type: "Orphan",
      kind: "resource",
      class: "resource",
      derivation: "specialization",
      base: "http://example.org/NotInThisSource",
      elements: { alpha: { type: "string" } },
    };
    const resolved = resolveDocument(orphan, new FixtureSchemaSource([orphan]));
    expect(resolved.elements.alpha?.type).toBe("string");
    expect(resolved.elements.id).toBeUndefined();
  });
});

describe("resolveDocument — a hoisted slice copy still yields a type when there's no base (issue #27)", () => {
  it("keeps the discarded copy's `type` as a last resort, rather than falling through to 'unknown'", () => {
    // Real shape, from hl7.fhir.us.core#6.1.0's QuestionnaireResponse
    // profile: `questionnaire` is a primitive (canonical) carrying an
    // attached extension, and that `extension` child is itself sliced with a
    // single slice whose schema the converter hoists onto it. Discarding the
    // hoisted copy (issue #23) is right for cardinality, but this element has
    // no base to recover `type` from — a primitive's children are never
    // expanded from a type document — so `type` has to survive or emit/
    // degrades a perfectly known Extension to z.unknown().
    const doc: FhirSchemaDocument = {
      name: "HostProfile",
      url: "http://example.org/HostProfile",
      type: "HostProfile",
      kind: "resource",
      class: "resource",
      derivation: "specialization",
      elements: {
        questionnaire: {
          type: "canonical",
          elements: {
            extension: {
              type: "Extension",
              min: 0,
              max: 1,
              slicing: { slices: { uri: { match: {}, schema: { type: "Extension", min: 0, max: 1 } } } },
            },
          },
        },
      },
    };

    const el = resolveDocument(doc, new FixtureSchemaSource([doc])).elements.questionnaire?.elements?.extension;
    expect(el?.type).toBe("Extension");
    // Still discarded, which is the point of issue #23's fix: the 0..1 is the
    // slice's cardinality, not the container's.
    expect(el?.max).toBeUndefined();
  });
});

describe("resolveDocument — types with no SchemaSource entry (Extension)", () => {
  it("resolves the generic `extension` element's own type concretely without needing Extension's structure", () => {
    const extension = uscorePatient.elements.extension;
    expect(extension?.type).toBe("Extension");
    expect(extension?.min).toBe(0);
    // Was `max === 1` before issue #23. That assertion had become the wrong
    // question rather than merely a stale number: the 1 was never this
    // element's own cardinality. us-core-patient's differential has *no*
    // container row for `Patient.extension` — only six sliceName rows — and
    // the converter hoists the first slice's schema (`us-core-race`, 0..1)
    // onto the container. `extension` is 0..* here, as it is on every
    // DomainResource.
    expect(extension?.max).toBeUndefined();
  });

  it("leaves `elements` unexpanded for a type not in this SchemaSource, rather than throwing or fabricating structure", () => {
    expect(uscorePatient.elements.extension?.elements).toBeUndefined();
    expect(uscorePatient.elements.extension?.isCyclic).toBeFalsy();
  });
});

describe("resolveDocument — error handling for out-of-scope base chains", () => {
  it("throws when a profile's base cannot be found via the injected SchemaSource", () => {
    const doc: FhirSchemaDocument = {
      url: "http://example.org/StructureDefinition/orphan-profile",
      name: "OrphanProfile",
      type: "Patient",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      base: "http://example.org/StructureDefinition/does-not-exist",
      elements: {},
    };
    expect(() => resolveDocument(doc, source)).toThrow(/was not found via SchemaSource\.getByUrl/);
  });

  it("throws when a profile in the base chain declares no base", () => {
    const stubSource: SchemaSource = {
      getByUrl: (url) => (url === "urn:mid-profile" ? midProfile : undefined),
      getByType: () => undefined,
    };
    const midProfile: FhirSchemaDocument = {
      url: "urn:mid-profile",
      name: "MidProfile",
      type: "Patient",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      elements: {},
    };
    const leafProfile: FhirSchemaDocument = {
      url: "urn:leaf-profile",
      name: "LeafProfile",
      type: "Patient",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      base: "urn:mid-profile",
      elements: {},
    };
    expect(() => resolveDocument(leafProfile, stubSource)).toThrow(/declares no base/);
  });

  it("throws a clear error on a circular base chain (A -> B -> A) instead of hanging or overflowing the stack", () => {
    const stubSource: SchemaSource = {
      getByUrl: (url) => (url === "urn:a" ? docA : url === "urn:b" ? docB : undefined),
      getByType: () => undefined,
    };
    const docA: FhirSchemaDocument = {
      url: "urn:a",
      name: "A",
      type: "Patient",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      base: "urn:b",
      elements: {},
    };
    const docB: FhirSchemaDocument = {
      url: "urn:b",
      name: "B",
      type: "Patient",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      base: "urn:a",
      elements: {},
    };
    expect(() => resolveDocument(docA, stubSource)).toThrow(/circular base chain/);
  });
});

describe("resolveDocument — multi-level profile chains (issue #5)", () => {
  // Three synthetic layers standing in for
  // us-core-blood-pressure -> us-core-vital-signs -> vitalsigns -> Observation:
  // `leaf` narrows over `mid`, which narrows over `base` (a true resource,
  // derivation "specialization"). `mid` is deliberately silent about
  // `alpha` (doesn't restate it in its own `required`) even though `base`
  // requires it — proving a middle layer's silence inherits rather than
  // resets, generalized past the two-level case resolve.test.ts already
  // covers for `communication`.
  const stubSource: SchemaSource = {
    getByUrl: (url) => (url === "urn:mid" ? mid : url === "urn:base" ? base : undefined),
    getByType: () => undefined,
  };
  const base: FhirSchemaDocument = {
    url: "urn:base",
    name: "Base",
    type: "Thing",
    kind: "resource",
    class: "type",
    derivation: "specialization",
    required: ["alpha", "beta"],
    elements: {
      alpha: { type: "string" },
      beta: { type: "string" },
      gamma: { type: "string" },
    },
  };
  const mid: FhirSchemaDocument = {
    url: "urn:mid",
    name: "Mid",
    type: "Thing",
    kind: "resource",
    class: "profile",
    derivation: "constraint",
    base: "urn:base",
    // Only restates `gamma` as newly required — silent about `alpha`/`beta`,
    // which base already requires.
    required: ["gamma"],
    elements: {},
  };
  const leaf: FhirSchemaDocument = {
    url: "urn:leaf",
    name: "Leaf",
    type: "Thing",
    kind: "resource",
    class: "profile",
    derivation: "constraint",
    base: "urn:mid",
    elements: {},
  };

  it("resolves a three-level chain end-to-end with concrete types for every element", () => {
    const resolved = resolveDocument(leaf, stubSource);
    expect(resolved.elements.alpha?.type).toBe("string");
    expect(resolved.elements.beta?.type).toBe("string");
    expect(resolved.elements.gamma?.type).toBe("string");
  });

  it("a middle layer that doesn't restate an already-required field inherits it rather than resetting it", () => {
    const resolved = resolveDocument(leaf, stubSource);
    // alpha/beta: required by `base`, never restated by `mid` or `leaf` —
    // must survive both silent layers.
    expect(resolved.elements.alpha?.required).toBe(true);
    expect(resolved.elements.beta?.required).toBe(true);
    // gamma: required only by `mid`'s own differential — must still surface
    // through `leaf`, which doesn't restate it either.
    expect(resolved.elements.gamma?.required).toBe(true);
  });

  it("resolving `mid` directly (one level up) also shows alpha/beta inherited, not just leaf", () => {
    const resolvedMid = resolveDocument(mid, stubSource);
    expect(resolvedMid.elements.alpha?.required).toBe(true);
    expect(resolvedMid.elements.beta?.required).toBe(true);
    expect(resolvedMid.elements.gamma?.required).toBe(true);
  });
});

describe("resolveDocument — US Core Blood Pressure (real four-level chain, issue #5)", () => {
  // us-core-blood-pressure -> us-core-vital-signs -> vitalsigns -> Observation.
  // Previously threw at the second hop (Phase 2 gap tracked as issue #5,
  // measured then as 15 of 49 US Core resource profiles failing to resolve
  // for the same reason).

  it("resolves with zero elements left at type 'unknown' anywhere in the tree (choice-group markers excepted)", () => {
    const unresolved: string[] = [];
    walkElements(bloodPressure.elements, (path, el) => {
      if (el.type === "unknown" && !el.choices) unresolved.push(path);
    });
    expect(unresolved).toEqual([]);
  });

  it("resolves status/code/subject to concrete types, required — inherited unchanged through all four layers", () => {
    // None of these are in us-core-blood-pressure's OWN elements (its only
    // direct elements are `code` and `component`, per the fixture) or in
    // us-core-vital-signs's own `required` (["category"] only) — they're
    // required only because base Observation (code, status) and vitalsigns
    // (subject) say so, and nothing above silently resets that.
    expect(bloodPressure.elements.status?.type).toBe("code");
    expect(bloodPressure.elements.status?.required).toBe(true);
    expect(bloodPressure.elements.subject?.type).toBe("Reference");
    expect(bloodPressure.elements.subject?.required).toBe(true);
  });

  it("`code` is required (inherited from base Observation) even though blood pressure's own layer redeclares it with a `pattern`, not a fresh `required`", () => {
    expect(bloodPressure.elements.code?.type).toBe("CodeableConcept");
    expect(bloodPressure.elements.code?.required).toBe(true);
  });

  it("`category`'s slicing metadata survives the merge, though it's declared on us-core-vital-signs/vitalsigns, not on blood pressure itself", () => {
    const category = bloodPressure.elements.category;
    expect(category?.required).toBe(true);
    expect(category?.slicing?.slices).toBeDefined();
    expect(Object.keys(category?.slicing?.slices ?? {})).toContain("VSCat");
  });

  it("blood pressure's own component slicing (systolic/diastolic) resolves, with each slice's value type concrete", () => {
    const component = bloodPressure.elements.component;
    expect(component?.type).toBe("BackboneElement");
    expect(component?.min).toBe(2);
    expect(component?.slicing?.slices).toBeDefined();
    expect(Object.keys(component?.slicing?.slices ?? {}).sort()).toEqual(["diastolic", "systolic"]);
    // Component's own child structure (value[x] choices, dataAbsentReason)
    // is inherited from base Observation.component, not redeclared by any
    // profile layer — proof the BackboneElement merge chain survives too.
    expect(component?.elements?.valueQuantity?.type).toBe("Quantity");
    expect(component?.elements?.dataAbsentReason?.type).toBe("CodeableConcept");
  });

  it("resolves Observation.component.referenceRange via `elementReference` (points at the sibling top-level referenceRange, not repeated structure)", () => {
    // Incidental fixture-verified finding, not part of the base-chain walk
    // itself: base Observation uses `elementReference` to dedupe this
    // element against its own top-level `referenceRange`. Without following
    // it, this element would be the one committed fixture the "zero
    // unresolved" gate above can't clear.
    const referenceRange = bloodPressure.elements.component?.elements?.referenceRange;
    expect(referenceRange?.type).toBe("BackboneElement");
    expect(referenceRange?.elements?.low?.type).toBe("Quantity");
    expect(referenceRange?.elements?.text?.type).toBe("string");
  });
});

describe("resolveDocument — cardinality narrowing, not widening (issue #3)", () => {
  // A three-level chain (base -> mid -> leaf, mirroring issue #5's shape)
  // purpose-built to exercise min/max composition: `field`'s cardinality is
  // touched at different layers in different tests below, with the OTHER
  // layers deliberately silent, so each test isolates which layer's value
  // should win and proves the tighter-of-two rule composes across hops
  // rather than only holding for a single profile-over-base merge.
  function chain(
    fieldOnBase: { min?: number; max?: number | "*" },
    fieldOnMid: { min?: number; max?: number | "*" } | undefined,
    fieldOnLeaf: { min?: number; max?: number | "*" } | undefined
  ): { base: FhirSchemaDocument; mid: FhirSchemaDocument; leaf: FhirSchemaDocument; source: SchemaSource } {
    const base: FhirSchemaDocument = {
      url: "urn:card-base",
      name: "CardBase",
      type: "Thing",
      kind: "resource",
      class: "type",
      derivation: "specialization",
      elements: { field: { type: "string", array: true, ...fieldOnBase } },
    };
    const mid: FhirSchemaDocument = {
      url: "urn:card-mid",
      name: "CardMid",
      type: "Thing",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      base: "urn:card-base",
      elements: fieldOnMid ? { field: fieldOnMid } : {},
    };
    const leaf: FhirSchemaDocument = {
      url: "urn:card-leaf",
      name: "CardLeaf",
      type: "Thing",
      kind: "resource",
      class: "profile",
      derivation: "constraint",
      base: "urn:card-mid",
      elements: fieldOnLeaf ? { field: fieldOnLeaf } : {},
    };
    const source: SchemaSource = {
      getByUrl: (url) => (url === "urn:card-base" ? base : url === "urn:card-mid" ? mid : undefined),
      getByType: () => undefined,
    };
    return { base, mid, leaf, source };
  }

  it("a profile that widens min (base 1 -> profile 0) resolves to the base's tighter min", () => {
    const { leaf, source } = chain({ min: 1 }, { min: 0 }, undefined);
    expect(resolveDocument(leaf, source).elements.field?.min).toBe(1);
  });

  it("a profile that widens max (base 5 -> profile 10) resolves to the base's tighter max", () => {
    const { leaf, source } = chain({ max: 5 }, { max: 10 }, undefined);
    expect(resolveDocument(leaf, source).elements.field?.max).toBe(5);
  });

  it("legitimate narrowing still works: base min 0 -> profile min 1 resolves to 1", () => {
    const { leaf, source } = chain({ min: 0 }, { min: 1 }, undefined);
    expect(resolveDocument(leaf, source).elements.field?.min).toBe(1);
  });

  it("legitimate narrowing still works: base max 5 -> profile max 2 resolves to 2", () => {
    const { leaf, source } = chain({ max: 5 }, { max: 2 }, undefined);
    expect(resolveDocument(leaf, source).elements.field?.max).toBe(2);
  });

  it('unbounded max ("*") is the loosest value in both directions: a concrete max always wins over "*"', () => {
    // Base unbounded, profile narrows to a concrete number — legitimate,
    // profile's tighter value wins.
    const narrowed = chain({ max: "*" }, { max: 3 }, undefined);
    expect(resolveDocument(narrowed.leaf, narrowed.source).elements.field?.max).toBe(3);
    // Base concrete, profile widens to unbounded — malformed, base's
    // tighter value must still win.
    const widened = chain({ max: 3 }, { max: "*" }, undefined);
    expect(resolveDocument(widened.leaf, widened.source).elements.field?.max).toBe(3);
  });

  it("both sides silent on max leaves it undefined (no fabricated bound)", () => {
    const { leaf, source } = chain({}, undefined, undefined);
    expect(resolveDocument(leaf, source).elements.field?.max).toBeUndefined();
  });

  it("one side silent on max defers entirely to the other side, rather than treating 'unstated' as a comparable value", () => {
    const { leaf, source } = chain({ max: 4 }, undefined, undefined);
    expect(resolveDocument(leaf, source).elements.field?.max).toBe(4);
  });

  it("min composes across a full three-level chain: a malformed widening at the MIDDLE layer doesn't survive an outer SILENT layer", () => {
    // base min:1 (tight) -> mid maliciously sets min:0 (widening attempt,
    // caught at the mid hop) -> leaf never touches `field` at all. If the
    // guard only checked one hop at a time correctly but leaf's silence
    // somehow re-derived from raw base/mid instead of the already-reduced
    // value, this is the case that would catch it.
    const { leaf, source } = chain({ min: 1 }, { min: 0 }, undefined);
    const resolvedMid = resolveDocument(source.getByUrl("urn:card-mid")!, source);
    expect(resolvedMid.elements.field?.min).toBe(1); // caught at the mid hop
    const resolvedLeaf = resolveDocument(leaf, source);
    expect(resolvedLeaf.elements.field?.min).toBe(1); // still 1 through the silent outer layer
  });

  it("max composes across a full three-level chain the same way: widening at mid doesn't survive leaf's silence", () => {
    const { leaf, source } = chain({ max: 5 }, { max: 10 }, undefined);
    const resolvedLeaf = resolveDocument(leaf, source);
    expect(resolvedLeaf.elements.field?.max).toBe(5);
  });

  it("a legitimate three-layer narrowing chain (min tightens at every hop) still resolves to the tightest, outermost value", () => {
    const { leaf, source } = chain({ min: 0, max: "*" }, { min: 1, max: 5 }, { max: 2 });
    const resolved = resolveDocument(leaf, source).elements.field;
    expect(resolved?.min).toBe(1); // inherited from mid, leaf doesn't touch min
    expect(resolved?.max).toBe(2); // narrowed again at leaf
  });

  it("real US Core Blood Pressure chain: array cardinality set by the outermost profile survives unchanged (regression check)", () => {
    // component's min:2 is declared on blood pressure itself (the
    // outermost, tightest layer in real conformant data) — confirms the
    // tighter-of-two rule doesn't accidentally loosen a real, legitimate
    // value while guarding against malformed ones.
    expect(bloodPressure.elements.component?.min).toBe(2);
    expect(bloodPressure.elements.category?.min).toBe(1);
  });
});
