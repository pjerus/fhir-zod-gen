import type { CodeSystemResource, ValueSetResource } from "./resources.js";
import type { TerminologySource } from "./terminology-source.js";

/**
 * One TerminologySource over several, tried in order (issue #50) — the
 * terminology counterpart of merge/'s compositeSchemaSource, and it follows
 * the same first-hit-wins rule for the same reasons. See that file.
 *
 * Worth stating what this does *not* attempt: when two packages publish
 * different expansions of the same ValueSet canonical, this takes the
 * leftmost and does not reconcile them. Reconciling would mean deciding
 * which codes a profile "really" permits, and a wrong answer there emits a
 * z.enum that rejects conformant data — the failure this project treats as
 * worse than under-enforcing (see emit.ts on why a required binding that
 * can't be fully expanded degrades to z.string() rather than a partial enum).
 */
export function compositeTerminologySource(sources: TerminologySource[]): TerminologySource {
  return {
    getValueSet(url: string): ValueSetResource | undefined {
      for (const source of sources) {
        const found = source.getValueSet(url);
        if (found) return found;
      }
      return undefined;
    },
    getCodeSystem(url: string): CodeSystemResource | undefined {
      for (const source of sources) {
        const found = source.getCodeSystem(url);
        if (found) return found;
      }
      return undefined;
    },
  };
}
