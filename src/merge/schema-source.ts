import type { FhirSchemaDocument } from "../fhir-schema-types.js";

/**
 * Narrow lookup that `merge/` uses to resolve a base resource or a complex
 * type by name/URL. Deliberately an interface with no I/O of its own — see
 * the module comment in resolve.ts for why `merge/` itself must not read
 * files or hit the network.
 *
 * Two lookup shapes because the two callers need different keys:
 *   - `getByUrl` resolves `FhirSchemaDocument.base` (a canonical URL,
 *     e.g. "http://hl7.org/fhir/StructureDefinition/Patient") when walking
 *     a profile up to the resource it constrains.
 *   - `getByType` resolves an element's `type` (a bare name, e.g.
 *     "HumanName") when expanding a complex-type-valued element's own
 *     structure.
 * Phase 4's `resolve/` will back this with a real IG package index; for
 * Phase 2 it's backed by the fixtures under fixtures/ and fixtures/datatypes/
 * (see fixture-schema-source.ts, which is intentionally NOT part of this
 * file — it does the fs reads this interface exists to keep out of merge/).
 */
export interface SchemaSource {
  getByUrl(url: string): FhirSchemaDocument | undefined;
  getByType(name: string): FhirSchemaDocument | undefined;
}
