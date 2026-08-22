/**
 * Fills in the `slicing.slices[name].match` patterns `translate()` leaves
 * empty, by reading them back off the raw StructureDefinition (issue #32).
 *
 * ## Why this exists at all
 *
 * `match` is the FHIR Schema field that carries a slice's discriminating
 * value, and it is the only pattern source `emit/slicing.ts` trusts. The
 * converter populates it rarely: `{}` for 558 of the 711 slices across seven
 * real IGs, which leaves **240 slice cardinalities with a real `min`/`max`
 * unenforceable**. 196 of those 240 are recoverable here, because the
 * discriminating `pattern[x]`/`fixed[x]` is sitting in the source
 * StructureDefinition the converter was handed.
 *
 * This is the same move `primitiveRegexes()` makes for primitive regexes,
 * for the same reason and at the same layer: information present in the
 * source, absent from the converted form, lifted by the layer that already
 * owns package I/O so that `merge/` and `emit/` stay pure. The recovered
 * value goes into the document's own `match` field rather than a side
 * channel, so nothing downstream has to learn that recovery happened — and
 * a converter release that starts populating `match` itself silently
 * retires this code path rather than colliding with it.
 *
 * ## The shape it reads
 *
 * A sliced element's members are written in the raw definition as ids
 * carrying the slice name after a colon, with the discriminating value
 * either on the slice head or one to two levels beneath it:
 *
 *     Observation.category:us-core                 patternCodeableConcept
 *     Extension.extension:code.url                 fixedUri "code"
 *     Observation.component:gene-studied.code      patternCodeableConcept
 *
 * The path below the slice head becomes the nesting of the match object, so
 * the third example yields `{code: {coding: [...]}}` — exactly what the
 * converter would have written, and what `__fhirSliceMatches` deep-matches
 * members against.
 *
 * ## Why a partly-usable slice is skipped whole
 *
 * A slice can state several patterns at once (genomics-reporting's
 * `sample-allelic-frequency` discriminates on both `code` and
 * `value[x].system`). Dropping one and keeping the rest yields a *weaker*
 * pattern, which matches more members than the slice really has — harmless
 * for a `min` floor, but it inflates the count against a `max` ceiling and
 * rejects conformant data. So any unusable pattern disqualifies its whole
 * slice, which is the same rule as "never a partial enum" wearing different
 * clothes. Unusable means a choice-type `[x]` segment (whose real key
 * depends on which variant the data carries) or a `fixed[x]` holding an
 * object (exact-equality semantics that a deep partial match would widen).
 */

import type { FhirSchemaDocument, FhirSchemaElement } from "../fhir-schema-types.js";

/** One `pattern[x]`/`fixed[x]` found under a slice head, and where it sat. */
interface FoundPattern {
  /** Element names between the slice head and the pattern; empty means the head itself. */
  path: string[];
  value: unknown;
}

interface RawElement {
  id?: string;
  [key: string]: unknown;
}

const PATTERN_KEY = /^(pattern|fixed)[A-Z]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Indexes every raw element's discriminating pattern by slice head, e.g.
 * `component:gene-studied`. Heads that carry anything unusable map to
 * `undefined`, which is how a poisoned head stays distinguishable from one
 * that was simply never seen.
 */
function indexPatternsBySlice(elements: RawElement[]): Map<string, FoundPattern[] | undefined> {
  const found = new Map<string, FoundPattern[] | undefined>();

  for (const element of elements) {
    const key = Object.keys(element).find((k) => PATTERN_KEY.test(k));
    if (!key || !element.id) continue;

    // The id's leading segment is the resource/type name, which the
    // document's element tree doesn't have a key for.
    const segments = element.id.split(".").slice(1);
    const sliceDepths = segments.flatMap((segment, i) => (segment.includes(":") ? [i] : []));
    if (sliceDepths.length === 0) continue;

    const head = segments.slice(0, sliceDepths[0] + 1).join(".");
    const path = segments.slice(sliceDepths[0] + 1);

    // Nested slicing (two colons in one id) would need the match to nest
    // through an inner slicing block rather than through element names. It
    // does not occur in any package measured for #32, so it is refused
    // rather than guessed at.
    const usable =
      sliceDepths.length === 1 &&
      !head.includes("[x]") &&
      !path.some((segment) => segment.includes("[x]")) &&
      (key.startsWith("pattern") || !isPlainObject(element[key]));

    if (!usable) {
      found.set(head, undefined);
      continue;
    }

    const existing = found.get(head);
    if (existing === undefined && found.has(head)) continue;
    found.set(head, [...(existing ?? []), { path, value: element[key] }]);
  }

  return found;
}

/** Nests each pattern at its own path and merges them into one match object. */
function buildMatch(patterns: FoundPattern[]): unknown {
  let match: unknown;

  for (const { path, value } of patterns) {
    if (path.length === 0) {
      // A pattern on the slice head is the whole match; it can only combine
      // with deeper ones if it is an object to merge them into.
      if (match === undefined) match = value;
      else if (isPlainObject(match) && isPlainObject(value)) match = { ...value, ...match };
      else return undefined;
      continue;
    }

    if (match === undefined) match = {};
    if (!isPlainObject(match)) return undefined;

    let cursor = match;
    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      if (next === undefined) cursor[segment] = {};
      else if (!isPlainObject(next)) return undefined;
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]] = value;
  }

  return match;
}

/**
 * Fills empty `match` fields in `document` from `structureDefinition`,
 * in place. Returns how many slices were filled.
 *
 * A slice whose `match` the converter already populated is never touched:
 * the converter's own answer wins wherever it gave one.
 */
export function recoverSliceMatches(structureDefinition: unknown, document: FhirSchemaDocument): number {
  const sd = structureDefinition as {
    differential?: { element?: RawElement[] };
    snapshot?: { element?: RawElement[] };
  };
  const rawElements = [...(sd.differential?.element ?? []), ...(sd.snapshot?.element ?? [])];
  if (rawElements.length === 0) return 0;

  const patterns = indexPatternsBySlice(rawElements);
  if (patterns.size === 0) return 0;

  let recovered = 0;

  const visit = (elements: Record<string, FhirSchemaElement> | undefined, prefix: string): void => {
    for (const [name, element] of Object.entries(elements ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;

      for (const [sliceName, slice] of Object.entries(element.slicing?.slices ?? {})) {
        if (isPlainObject(slice.match) && Object.keys(slice.match).length > 0) continue;

        const found = patterns.get(`${path}:${sliceName}`);
        if (!found) continue;

        const match = buildMatch(found);
        if (match === undefined) continue;

        slice.match = match;
        recovered++;
      }

      visit(element.elements, path);
    }
  };

  visit(document.elements, "");

  return recovered;
}
