/**
 * Minimal typing for the ValueSet/CodeSystem JSON needed to expand a
 * `required`-strength binding into a concrete code list. Deliberately not a
 * full FHIR resource model — only the fields expand.ts actually reads.
 *
 * Shape verified against the committed fixtures under fixtures/valuesets/
 * (e.g. ValueSet-administrative-gender.json / CodeSystem-administrative-gender.json).
 */

/**
 * One `compose.include` entry. Two supported shapes (design doc Phase 3b
 * scope — "handle at minimum"):
 *   - `system` + explicit `concept` list: only those codes.
 *   - `system` with no `concept`: every code from that CodeSystem (all of
 *     `fixtures/valuesets/ValueSet-*.json`'s `compose.include` entries are
 *     this shape — verified, none carry an explicit `concept` list).
 * `filter` (intensional, e.g. "is-a") and a bare `valueSet` reference
 * (composing other ValueSets by canonical URL) are recognized but not
 * expanded — see expand.ts's fallthrough.
 */
export interface ValueSetComposeInclude {
  system?: string;
  concept?: { code: string }[];
  valueSet?: string[];
  filter?: unknown[];
}

export interface ValueSetResource {
  resourceType: "ValueSet";
  url: string;
  compose?: {
    include: ValueSetComposeInclude[];
    /** Present but deliberately unhandled — expand.ts refuses to expand rather than silently ignoring it. */
    exclude?: ValueSetComposeInclude[];
  };
}

/**
 * `concept` nests recursively (a hierarchical CodeSystem, e.g. SNOMED-style
 * children) — expand.ts's collectCodes walks `concept.concept` to depth.
 * `abstract` marks a classification-only code not meant for direct use (FHIR
 * CodeSystem convention); such codes are excluded from the expanded list but
 * their children are still walked.
 */
export interface CodeSystemConcept {
  code: string;
  abstract?: boolean;
  concept?: CodeSystemConcept[];
}

export interface CodeSystemResource {
  resourceType: "CodeSystem";
  url: string;
  concept?: CodeSystemConcept[];
}
