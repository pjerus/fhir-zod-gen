import type {
  FhirSchemaBinding,
  FhirSchemaConstraintDetail,
  FhirSchemaDocument,
  FhirSchemaElement,
  FhirSchemaSlicing,
} from "../fhir-schema-types.js";

/**
 * One element after profile-over-base merge. Unlike FhirSchemaElement (where
 * a profile element may carry none of type/array/min/max — see that type's
 * doc comment), every ResolvedElement has a concrete `type`: that's the
 * whole point of merge/. Everything else about an element (bindings,
 * constraints, slicing, mustSupport, ...) is carried through unchanged for
 * Phase 3 to interpret — merge/ merges structure, not meaning.
 */
export interface ResolvedElement {
  /**
   * Always concrete after resolution: a FHIR primitive name, a named
   * complex/backbone type, or (only if the input genuinely had no type
   * anywhere in its base chain — not expected from any committed fixture)
   * the literal "unknown", mirroring mapper.ts's existing z.unknown()
   * fallback so callers have one sentinel to check for rather than having
   * to handle `undefined` specially.
   */
  type: string;
  array: boolean;
  min: number;
  max: number | "*" | undefined;
  /**
   * Derived from the PARENT's `required` array (or the document's, at the
   * root) — never from this element's own `required`, which lists this
   * element's *children*. See design doc section 1, defect 6.
   */
  required: boolean;
  /**
   * Nested element definitions. Populated when:
   *   - `type` is "BackboneElement" (structure is always inline, no lookup
   *     needed), or
   *   - `type` names a complex type this call's SchemaSource resolved (via
   *     getByType) — its own elements, further recursively resolved.
   * Absent when `type` is a FHIR primitive, when `isCyclic` is true (this
   * is exactly where recursion was cut short), or when `type` names a
   * complex type the injected SchemaSource has no entry for (e.g.
   * "Extension" against the fixture-backed source built for Phase 2 — see
   * resolve.ts's module comment). That last case is NOT the same as
   * defect 4's z.unknown(): `type` is still a concrete string, just not
   * further expanded because this SchemaSource doesn't carry that type's
   * structure.
   */
  elements?: Record<string, ResolvedElement>;
  /**
   * True when expanding `type` would re-enter a type already being
   * expanded higher up the current resolution path (e.g.
   * Identifier -> Reference -> Identifier). `elements` is deliberately left
   * undefined instead of expanding forever — this flag is what lets Phase 3
   * tell "cut short by a cycle" apart from "primitive, nothing to expand"
   * apart from "SchemaSource doesn't have this type", so it knows where a
   * generated schema will need z.lazy().
   */
  isCyclic?: boolean;
  binding?: FhirSchemaBinding;
  constraint?: Record<string, FhirSchemaConstraintDetail>;
  choices?: string[];
  choiceOf?: string;
  mustSupport?: boolean;
  short?: string;
  refers?: string[];
  slicing?: FhirSchemaSlicing;
  /**
   * Passed through verbatim, NOT resolved — a named extension's own
   * value[x] structure is exactly the same "would need Extension's full
   * choice-type closure" problem that keeps merge/ from expanding the
   * generic `extension` element itself (see resolve.ts). Extension slicing
   * is Phase 3's job per the design doc's Phase 3 section.
   */
  extensions?: Record<string, FhirSchemaElement>;
}

/** A fully profile-over-base-merged document. */
export interface ResolvedSchema {
  name: string;
  url: string;
  type: string;
  kind: FhirSchemaDocument["kind"];
  base?: string;
  derivation?: FhirSchemaDocument["derivation"];
  elements: Record<string, ResolvedElement>;
}
