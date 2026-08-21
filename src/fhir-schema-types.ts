/**
 * Minimal typing for the "FHIR Schema" intermediate format
 * (https://github.com/fhir-schema/fhir-schema).
 *
 * FHIR Schema flattens a StructureDefinition's differential/snapshot into a
 * simpler, JSON-Schema-shaped tree that's much easier to walk than raw FHIR
 * StructureDefinition elements (which mix cardinality, slicing, and typing
 * across a flat `element[]` array keyed by dot-path).
 *
 * NOTE: this is a pragmatic subset covering the fields this generator uses.
 * It is deliberately not a complete/authoritative typing of the format —
 * treat it as a first pass to be tightened once wired against real IG
 * output. If a field is missing that you need, that's expected; extend
 * FhirSchemaElement below.
 */

export type FhirSchemaPrimitiveType =
  | "boolean"
  | "integer"
  | "integer64"
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
  | "uuid";

export interface FhirSchemaBinding {
  strength: "required" | "extensible" | "preferred" | "example";
  valueSet?: string;
  /** Only populated for `required` bindings where we've pre-resolved the
   * code list (e.g. via a terminology snapshot). Absent otherwise. */
  codes?: string[];
}

export interface FhirSchemaConstraint {
  key: string;
  severity: "error" | "warning";
  human: string;
  /** FHIRPath expression. Not evaluated by this tool — emitted as a
   * reference so callers can wire it into fhirpath.js themselves. */
  expression?: string;
}

export interface FhirSchemaElement {
  /** Primitive type, or the name of a complex/backbone type (e.g. "HumanName"). */
  type?: FhirSchemaPrimitiveType | string;
  array?: boolean;
  min?: number;
  max?: number | "*";
  required?: boolean;
  binding?: FhirSchemaBinding;
  constraint?: FhirSchemaConstraint[];
  /** Nested elements, for complex types and backbone elements. */
  elements?: Record<string, FhirSchemaElement>;
  /** Choice types, e.g. value[x] -> { valueString: {...}, valueQuantity: {...} } */
  choices?: string[];
  choiceOf?: string;
  short?: string;
}

export interface FhirSchemaDocument {
  url: string;
  name: string;
  type: string;
  kind: "resource" | "complex-type" | "primitive-type" | "logical";
  base?: string;
  derivation?: "specialization" | "constraint";
  elements: Record<string, FhirSchemaElement>;
  required?: string[];
}
