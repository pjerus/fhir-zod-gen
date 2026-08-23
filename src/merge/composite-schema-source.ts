import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import type { SchemaSource } from "./schema-source.js";

/**
 * One SchemaSource over several, tried in order (issue #50).
 *
 * Generating more than one IG in a single run means one batch — one set of
 * shared datatype files, one barrel — and that batch has to resolve base
 * chains and complex types across every package in it. Each package brings
 * its own closure-backed source; this is what lets `merge/` see all of them.
 *
 * First hit wins, in the order the user named the packages on the command
 * line. That matters when two closures disagree about the same canonical —
 * `davinci-pas` alone pulls in three different US Core versions — and the
 * rule is deliberately "the leftmost input decides" rather than anything
 * cleverer: it is predictable from the command that was run, and it keeps
 * output deterministic for a given argument order. A resolution that varied
 * with iteration order is exactly the failure mode issue #34 was filed for.
 *
 * Pure, like everything else in `merge/` — the I/O already happened when each
 * underlying source was built.
 */
export function compositeSchemaSource(sources: SchemaSource[]): SchemaSource {
  return {
    getByUrl(url: string): FhirSchemaDocument | undefined {
      for (const source of sources) {
        const found = source.getByUrl(url);
        if (found) return found;
      }
      return undefined;
    },
    getByType(name: string): FhirSchemaDocument | undefined {
      for (const source of sources) {
        const found = source.getByType(name);
        if (found) return found;
      }
      return undefined;
    },
  };
}
