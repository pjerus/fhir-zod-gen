/**
 * FHIR slicing -> Zod. Pure source-text generation, same contract as the
 * rest of emit/ — see docs/design/slicing-design.md for the grounding data
 * and the decisions behind what this does and deliberately doesn't enforce.
 *
 * ## Why array-level `.superRefine()` and not `z.discriminatedUnion`
 *
 * Slicing partitions a repeating element into named groups with their own
 * cardinalities. `z.discriminatedUnion` needs a flat literal key shared by
 * every variant and is *closed* — anything matching no variant is rejected.
 * Neither holds here: the discriminating value usually sits inside a nested
 * array (`code.coding[].code`), and slicing `rules` is `open` in 100% of the
 * 33 slicing blocks in `hl7.fhir.us.core#6.1.0`, meaning elements matching no
 * slice are legal. A discriminated union would reject conformant data, which
 * is the one failure mode this project exists to avoid.
 *
 * So the array's element schema stays the ordinary unsliced base type — every
 * valid slice member is automatically a valid instance of it, since profiles
 * only narrow — and slicing rides on top as a pure count check.
 *
 * ## Why this never reads a slice's own `schema`
 *
 * `@atomic-ehr/fhirschema` replaces a slice's inner
 * `schema.elements.*.pattern.value` with the literal string
 * `"[Circular Reference]"` (confirmed twice, on two unrelated profiles; see
 * the design doc's section 7 and issue #26). The *uncorrupted* copy of the
 * same information is `slices[name].match`, which is what this reads.
 * `sliceChecksFor` additionally refuses any pattern still carrying the
 * sentinel, rather than comparing real data against that string — which would
 * be silently always-false.
 *
 * Re-validating each slice member's own narrower schema is out of scope by
 * the same token: it would mean compiling per-slice mini-schemas out of
 * exactly the corrupted field, for no conformance gain the count check
 * doesn't already give.
 */

import type { ResolvedElement } from "../merge/index.js";

/** The converter's cycle-detection sentinel, which leaks into slice schemas. See this module's comment. */
const CIRCULAR_SENTINEL = "[Circular Reference]";

/** Name of the emitted runtime matcher. Double-underscored and file-local, so it can't collide across the barrel. */
export const SLICE_MATCHER = "__fhirSliceMatches";

/**
 * The matcher, emitted once into any file that needs it. Plain structural
 * recursion with no Zod API surface at all, so it stays Zod 3/4 agnostic.
 *
 * FHIR pattern semantics, which are not plain deep equality: an object
 * pattern requires every key it names to match and ignores keys it doesn't;
 * an array pattern requires each of its entries to be matched by *some*
 * element of the value (not positionally, not exhaustively), so extra
 * codings/entries in real data are fine.
 *
 * The scalar-pattern-against-array-value case is load-bearing and was not
 * obvious. The converter is inconsistent about whether a pattern for a
 * repeating element is wrapped in an array: US Core's blood pressure gives
 * `{code: {coding: [{system, code}]}}` while genomics-reporting's TMB gives
 * `{coding: {system, code}}` — same meaning, one wrapped and one not, for the
 * same `CodeableConcept.coding` field that is always an array in real data.
 * Without this branch the second shape matches nothing at all, and 57 of
 * genomics-reporting's 81 conformant examples were rejected for having zero
 * members of a slice every one of them actually satisfies.
 */
export const SLICE_MATCHER_SOURCE = `function ${SLICE_MATCHER}(value: unknown, pattern: unknown): boolean {
  if (pattern === null || typeof pattern !== "object") return value === pattern;
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value)) return false;
    return pattern.every((p) => value.some((v) => ${SLICE_MATCHER}(v, p)));
  }
  // An unwrapped object pattern against a repeating value: satisfied by any
  // one element, matching FHIR's own "pattern applies to the element" reading.
  if (Array.isArray(value)) return value.some((v) => ${SLICE_MATCHER}(v, pattern));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(pattern as Record<string, unknown>).every(
    ([k, p]) => ${SLICE_MATCHER}((value as Record<string, unknown>)[k], p)
  );
}`;

/** One named slice's enforceable count constraint. */
export interface SliceCheck {
  name: string;
  /** Absent `min` means 0 — five of US Core's 33 slicing blocks omit it entirely. */
  min: number;
  /** `undefined` means unbounded; no ceiling is emitted. */
  max?: number;
  /** A deep-partial match pattern, ready for SLICE_MATCHER. Never sourced from a slice's inner `schema`. */
  pattern: unknown;
}

/** True if the converter's sentinel appears anywhere in this pattern. */
function carriesSentinel(value: unknown): boolean {
  if (value === CIRCULAR_SENTINEL) return true;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(carriesSentinel);
}

/**
 * The enforceable slice-count constraints on one element, or `[]` where
 * there's nothing safe to enforce.
 *
 * Every rejection path here degrades to "not enforced" with a warning, never
 * to "enforced incorrectly" — a skipped slice loses a constraint we could
 * have checked; a wrong one rejects real patient data.
 */
export function sliceChecksFor(name: string, el: ResolvedElement, warnings: string[]): SliceCheck[] {
  const slices = el.slicing?.slices;
  if (!slices || Object.keys(slices).length === 0) return [];

  // Counting members of a slice is meaningless on a non-repeating element,
  // and merge/ can legitimately produce one (a sliced element whose array
  // flag resolved false). Nothing to enforce rather than something wrong.
  if (!el.array) return [];

  const checks: SliceCheck[] = [];
  for (const [sliceName, slice] of Object.entries(slices)) {
    const min = slice.min ?? 0;
    // `typeof`, not `!== undefined`: a slice's max is declared `number`, but
    // the converter writes the unbounded marker `"*"` on the *element* max
    // (see fixtures/uscore-patient's tribalAffiliation), so a string reaching
    // here should read as unbounded rather than become `count > "*"`.
    const max = typeof slice.max === "number" ? slice.max : undefined;

    // A 0..* slice constrains nothing, so a check for it is dead code in a
    // file whose readability is a stated requirement.
    if (min === 0 && max === undefined) continue;

    // `match` for every observed pattern/value discriminator; for extension
    // slicing the converter leaves `match` empty and puts the distinguishing
    // value on `schema.url` instead (it drops the `{type:"value",
    // path:"url"}` discriminator the raw StructureDefinition carries). Those
    // are the only two shapes, and both end up as one deep-match pattern.
    const hasMatch = slice.match && Object.keys(slice.match).length > 0;
    const pattern = hasMatch ? slice.match : slice.schema?.url ? { url: slice.schema.url } : undefined;

    if (pattern === undefined) {
      // An empty pattern deep-matches *every* element, turning a `min` into
      // "the array is non-empty" and a `max` into a false rejection. Never
      // emit one.
      warnings.push(
        `Slice "${sliceName}" of "${name}" has neither a match pattern nor a slice url — its cardinality ` +
          `(${min}..${max ?? "*"}) is not enforced.`
      );
      continue;
    }

    if (carriesSentinel(pattern)) {
      warnings.push(
        `Slice "${sliceName}" of "${name}" has a match pattern containing "${CIRCULAR_SENTINEL}" — the ` +
          `converter replaced real data with its cycle-detection sentinel, so this slice's cardinality is not enforced.`
      );
      continue;
    }

    checks.push({ name: sliceName, min, max, pattern });
  }

  return checks;
}

/**
 * The `.superRefine()` enforcing every named slice's count on one array.
 *
 * Appended after the array's own `.min()`/`.max()`, which are a different and
 * already-correct number: blood pressure's `component` is `2..*` overall
 * while its `systolic` slice is `1..1` within that. They coexist rather than
 * conflict.
 */
export function sliceSuperRefine(name: string, checks: SliceCheck[], baseIndent: string): string {
  const inner = `${baseIndent}  `;
  const body = checks
    .map((check) => {
      const lines = [
        `${inner}{`,
        `${inner}  const count = items.filter((item) => ${SLICE_MATCHER}(item, ${JSON.stringify(check.pattern)})).length;`,
      ];
      if (check.min > 0) {
        lines.push(
          `${inner}  if (count < ${check.min}) {`,
          `${inner}    ctx.addIssue({ code: "custom", message: \`expected at least ${check.min} ${name} element(s) matching slice "${check.name}", found \${count}\` });`,
          `${inner}  }`
        );
      }
      if (check.max !== undefined) {
        lines.push(
          `${inner}  if (count > ${check.max}) {`,
          `${inner}    ctx.addIssue({ code: "custom", message: \`expected at most ${check.max} ${name} element(s) matching slice "${check.name}", found \${count}\` });`,
          `${inner}  }`
        );
      }
      lines.push(`${inner}}`);
      return lines.join("\n");
    })
    .join("\n");

  return `.superRefine((items, ctx) => {\n${body}\n${baseIndent}})`;
}
