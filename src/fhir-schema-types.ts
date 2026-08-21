/**
 * Ground-truth typing for the "FHIR Schema" intermediate format, as actually
 * emitted by @atomic-ehr/fhirschema's `translate()` — not the format
 * described by https://github.com/fhir-schema/fhir-schema's docs, which
 * diverge from what the converter produces (noted inline below where it
 * matters).
 *
 * Derived from two sources, in priority order:
 *   1. The committed fixtures under fixtures/ — real translate() output for
 *      base R4 Patient, the US Core Patient profile, and the US Core Blood
 *      Pressure profile (slicing + choice types).
 *   2. @atomic-ehr/fhirschema's own dist/types.d.ts — the type contract for
 *      the same code that produced those fixtures, useful for fields that
 *      exist in the format but happen not to appear in these three specific
 *      documents.
 * Where a field is typed from (2) but wasn't directly observed in (1), it's
 * flagged in a comment. If you need to extend this file, prefer adding a
 * fixture that exercises the new field over trusting the docs.
 *
 * This replaces a v0.1 file written against an *imagined* shape of FHIR
 * Schema. See docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md
 * section 1 for the defects that caused, verified against these same
 * fixtures.
 *
 * Still a deliberately pragmatic subset, not the full converter surface —
 * extend FhirSchemaElement when a field you need is missing.
 */

/** Matches @atomic-ehr/fhirschema's FHIR_PRIMITIVE_TYPES (R4). */
export type FhirSchemaPrimitiveType =
  | "boolean"
  | "integer"
  | "string"
  | "decimal"
  | "uri"
  | "url"
  | "canonical"
  | "base64Binary"
  | "instant"
  | "date"
  | "dateTime"
  | "time"
  | "code"
  | "oid"
  | "id"
  | "markdown"
  | "unsignedInt"
  | "positiveInt"
  | "uuid"
  | "xhtml";

/**
 * No `codes` field — required-strength bindings carry only a `valueSet`
 * URI. Expanding that into a concrete code list needs the ValueSet/CodeSystem
 * resources (see fixtures/valuesets/); the converter does not pre-resolve it.
 * Verified: r4-patient.gender / uscore-patient.gender both have
 * `{strength:"required", valueSet:"…/administrative-gender"}`, no `codes`.
 */
export interface FhirSchemaBinding {
  strength: "required" | "extensible" | "preferred" | "example";
  valueSet?: string;
  /** Present on some but not all bindings (e.g. gender's is "AdministrativeGender"). */
  bindingName?: string;
}

/**
 * A single constraint's detail. Note the container is a Record keyed by
 * constraint id (see FhirSchemaElement.constraint / FhirSchemaDocument.constraint
 * below) — NOT an array, and NOT a field called `constraints` (plural).
 * fhir-schema/fhir-schema's own docs say "constraints"; the converter emits
 * singular "constraint" as an id-keyed object. The converter wins — verified
 * directly in fixtures/uscore-patient.fhirschema.json:
 * `elements.name.constraint["us-core-6"] = {expression, human, severity}`.
 */
export interface FhirSchemaConstraintDetail {
  expression: string;
  human: string;
  severity: "error" | "warning";
}

/**
 * A fixed/pattern value. `value`'s shape depends on `type`: a JSON primitive
 * for primitive types (e.g. `{type:"uri", value:"http://unitsofmeasure.org"}`),
 * or a nested FHIR data type shape for complex types (e.g.
 * `{type:"CodeableConcept", value:{coding:[{system,code}]}}`). Left as
 * `unknown` rather than modeling every FHIR data type here.
 */
export interface FhirSchemaPattern {
  type: string;
  value: unknown;
  string?: string;
}

export type FhirSchemaDiscriminatorType =
  | "value"
  | "exists"
  | "pattern"
  | "type"
  | "profile"
  | "position";

export interface FhirSchemaDiscriminator {
  type: FhirSchemaDiscriminatorType;
  path: string;
}

/**
 * One slice's match condition + the element shape for members of that slice.
 * `match`'s shape mirrors the discriminated field (e.g. for a `pattern`
 * discriminator on `code`, `match.code` is a partial CodeableConcept) — left
 * as `unknown` for the same reason as FhirSchemaPattern.value. `schema` is
 * itself a full element definition (elements/required/mustSupport/...) for
 * members of the slice.
 */
export interface FhirSchemaSliceMatch {
  match?: unknown;
  schema?: FhirSchemaElement;
  min?: number;
  max?: number;
}

/**
 * `min` is observed directly on the slicing object itself in real output
 * (fixtures/uscore-blood-pressure.fhirschema.json: `component.slicing.min`,
 * duplicating `component.min`) even though @atomic-ehr/fhirschema's own
 * dist/types.d.ts does not declare it on FHIRSchemaSlicing — another spot
 * where the converter's actual output is ahead of its declared types.
 */
export interface FhirSchemaSlicing {
  discriminator?: FhirSchemaDiscriminator[];
  rules?: "open" | "closed" | "openAtEnd";
  ordered?: boolean;
  min?: number;
  slices?: Record<string, FhirSchemaSliceMatch>;
}

/**
 * One element in the tree. Two shapes coexist under this one type depending
 * on where the element came from:
 *
 * - **Base resource elements** (e.g. r4-patient's `name`, `gender`) carry
 *   concrete `type`/`array`/`min`/`max`.
 * - **Profile elements that only narrow a base element** (e.g.
 *   uscore-patient's `name`) carry NONE of type/array/min/max — those live
 *   on the base resource this profile derives from. A profile element only
 *   restates what it narrows: `mustSupport`, a tighter `binding`, an added
 *   `constraint`, sub-`elements` for further-narrowed children, etc.
 *   Verified: uscore-patient.elements.name = `{short, constraint, mustSupport,
 *   index, elements}` — no type/array/min/max at all. Resolving these to
 *   concrete types requires walking to the base (Phase 2's `merge/`); this
 *   type does not encode that resolution.
 */
export interface FhirSchemaElement {
  /** Primitive type, or the name of a complex/backbone type (e.g. "HumanName"). */
  type?: FhirSchemaPrimitiveType | string;
  array?: boolean;
  min?: number;
  max?: number;
  /**
   * Child element names that are required *within this element* — e.g.
   * `identifier: {required:["system","value"]}` means identifier.system and
   * identifier.value are required whenever an identifier is present. This is
   * the same shape as FhirSchemaDocument.required, just scoped one level
   * down. NOT a boolean — there is no per-element "is this element itself
   * required" flag; that's derived from the parent's `required` array (or,
   * at the document root, from FhirSchemaDocument.required) containing this
   * element's name.
   */
  required?: string[];
  /** For Reference-typed elements: allowed target resource type names. */
  refers?: string[];
  binding?: FhirSchemaBinding;
  pattern?: FhirSchemaPattern;
  fixed?: FhirSchemaPattern;
  /** Keyed by constraint id — see FhirSchemaConstraintDetail. */
  constraint?: Record<string, FhirSchemaConstraintDetail>;
  /** Nested elements, for complex types and backbone elements. */
  elements?: Record<string, FhirSchemaElement>;
  /** Choice types, e.g. value[x] -> choices:["valueString","valueQuantity",...] on the value[x] entry itself. */
  choices?: string[];
  /** Set on each expanded variant (e.g. "deceasedBoolean") naming the value[x] element it's a variant of ("deceased"). */
  choiceOf?: string;
  short?: string;
  mustSupport?: boolean;
  isModifier?: boolean;
  isModifierReason?: string;
  isSummary?: boolean;
  slicing?: FhirSchemaSlicing;
  /** Extension-slice declarations (US Core profiles use this heavily). Keyed by extension name. */
  extensions?: Record<string, FhirSchemaElement>;
  /** Canonical URL — present on extension declarations. */
  url?: string;
  /** Positional index in the original StructureDefinition, for stable ordering. */
  index?: number;
  /**
   * Present in @atomic-ehr/fhirschema's own dist/types.d.ts (element-level
   * "is this element itself required", used internally on slice `schema`
   * entries — e.g. uscore-blood-pressure's systolic/diastolic slice schemas
   * both carry `_required: true`) but not otherwise observed on ordinary
   * elements in these fixtures. Underscore-prefixed in the converter's own
   * output; kept here verbatim rather than renamed.
   */
  _required?: boolean;
  /**
   * Declared in @atomic-ehr/fhirschema's dist/types.d.ts but not observed in
   * any of the three committed fixtures. Documented here for completeness,
   * not fixture-verified — confirm against real output before relying on it.
   */
  excluded?: string[];
  /** Same caveat as `excluded` — declared upstream, not observed here. */
  elementReference?: string[];
}

/**
 * A full FHIR Schema document (one StructureDefinition's worth). `class`
 * distinguishes a base resource ("resource") from a profile ("profile");
 * @atomic-ehr/fhirschema's type also allows "extension" | "type" | "logical",
 * not observed in these three fixtures.
 */
export interface FhirSchemaDocument {
  url: string;
  version?: string;
  name: string;
  type: string;
  kind: "resource" | "complex-type" | "primitive-type" | "logical";
  class: "resource" | "profile" | "extension" | "type" | "logical";
  base?: string;
  derivation?: "specialization" | "constraint";
  description?: string;
  elements: Record<string, FhirSchemaElement>;
  /**
   * Child element names required at the document root. Array of names, NOT
   * a boolean and NOT present unless something is actually required —
   * absent entirely on base r4-patient (nothing is unconditionally required
   * on plain Patient); `["gender","identifier","name"]` on uscore-patient,
   * where US Core mandates those three.
   */
  required?: string[];
  /** Same caveat as FhirSchemaElement.excluded — declared upstream, not observed here. */
  excluded?: string[];
  /** Top-level extension-slice declarations — see FhirSchemaElement.extensions. */
  extensions?: Record<string, FhirSchemaElement>;
  /** Keyed by constraint id — see FhirSchemaConstraintDetail. */
  constraint?: Record<string, FhirSchemaConstraintDetail>;
}
