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

beforeAll(() => {
  source = loadFixtureSchemaSource(FIXTURES_DIR);
  const doc = JSON.parse(
    readFileSync(join(FIXTURES_DIR, "uscore-patient.fhirschema.json"), "utf-8")
  ) as FhirSchemaDocument;
  uscorePatient = resolveDocument(doc, source);
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

describe("resolveDocument — types with no SchemaSource entry (Extension)", () => {
  it("resolves the generic `extension` element's own type/min/max concretely without needing Extension's structure", () => {
    const extension = uscorePatient.elements.extension;
    expect(extension?.type).toBe("Extension");
    expect(extension?.min).toBe(0);
    expect(extension?.max).toBe(1);
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
