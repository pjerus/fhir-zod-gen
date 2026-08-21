/**
 * Expands a ValueSet canonical URL into a concrete, ordered code list, given
 * an injected TerminologySource. Pure: no I/O, no lookups beyond what the
 * source provides.
 *
 * Never returns a partial list on a partial failure — design doc section 7
 * ("REJECT/DO BETTER #4") and this phase's brief are explicit: a partial
 * enum rejects conformant data, which is worse than not narrowing at all.
 * Any unsupported construct anywhere in the expansion (an exclude, a filter,
 * a missing CodeSystem, ...) fails the whole expansion rather than silently
 * dropping just that part.
 */

import type { TerminologySource } from "./terminology-source.js";
import type { CodeSystemConcept } from "./resources.js";

export type ExpansionResult = { ok: true; codes: string[] } | { ok: false; reason: string };

/** Strips a canonical URL's `|version` suffix (e.g. ".../ValueSet/link-type|4.0.1") for lookup. */
function stripVersion(url: string): string {
  const i = url.indexOf("|");
  return i === -1 ? url : url.slice(0, i);
}

/** Walks `concept` (and nested `concept.concept`) collecting codes in source order, skipping classification-only `abstract` codes. */
function collectCodes(concepts: CodeSystemConcept[], out: string[], seen: Set<string>): void {
  for (const concept of concepts) {
    if (!concept.abstract && !seen.has(concept.code)) {
      seen.add(concept.code);
      out.push(concept.code);
    }
    if (concept.concept?.length) {
      collectCodes(concept.concept, out, seen);
    }
  }
}

export function expandValueSet(valueSetUrl: string, source: TerminologySource): ExpansionResult {
  const url = stripVersion(valueSetUrl);
  const valueSet = source.getValueSet(url);
  if (!valueSet) {
    return { ok: false, reason: `ValueSet "${url}" not found in terminology source` };
  }

  const compose = valueSet.compose;
  if (!compose || compose.include.length === 0) {
    return { ok: false, reason: `ValueSet "${url}" has no compose.include (intensional or empty definition)` };
  }
  if (compose.exclude && compose.exclude.length > 0) {
    return { ok: false, reason: `ValueSet "${url}" has compose.exclude — exclusion expansion not implemented` };
  }

  const codes: string[] = [];
  const seen = new Set<string>();

  for (const include of compose.include) {
    if (include.concept && include.concept.length > 0) {
      for (const concept of include.concept) {
        if (!seen.has(concept.code)) {
          seen.add(concept.code);
          codes.push(concept.code);
        }
      }
      continue;
    }

    if (include.filter && include.filter.length > 0) {
      return { ok: false, reason: `ValueSet "${url}" uses an intensional filter — not implemented` };
    }

    if (include.system) {
      const systemUrl = stripVersion(include.system);
      const codeSystem = source.getCodeSystem(systemUrl);
      if (!codeSystem) {
        return { ok: false, reason: `CodeSystem "${systemUrl}" not found in terminology source` };
      }
      collectCodes(codeSystem.concept ?? [], codes, seen);
      continue;
    }

    return {
      ok: false,
      reason: `ValueSet "${url}" has a compose.include entry with no system or concept list (e.g. composing another ValueSet by reference) — not implemented`,
    };
  }

  if (codes.length === 0) {
    return { ok: false, reason: `ValueSet "${url}" expanded to zero codes` };
  }

  return { ok: true, codes };
}
