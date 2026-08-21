import type { CodeSystemResource, ValueSetResource } from "./resources.js";

/**
 * Narrow lookup that expand.ts uses to resolve a ValueSet and its backing
 * CodeSystem(s) by canonical URL. Deliberately an interface with no I/O of
 * its own — same shape as merge/schema-source.ts's SchemaSource: this module
 * (terminology/) must not read files or hit the network itself.
 *
 * Phase 4's package pipeline will back this with real IG package contents;
 * for now it's backed by the fixtures under fixtures/valuesets/ (see
 * fixture-terminology-source.ts, which does the fs reads this interface
 * exists to keep out of expand.ts).
 */
export interface TerminologySource {
  getValueSet(url: string): ValueSetResource | undefined;
  getCodeSystem(url: string): CodeSystemResource | undefined;
}
