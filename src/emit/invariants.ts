/**
 * Translating the mechanically-tractable subset of FHIRPath invariants into
 * runtime checks (issue #41).
 *
 * ## What is and isn't attempted
 *
 * A FHIR profile states rules that cardinality and types can't express —
 * conditions across more than one field, or on a field's content — in
 * FHIRPath. Evaluating FHIRPath in general means shipping an interpreter
 * (realistically `fhirpath.js`) and making every generated file depend on it
 * at runtime, which collides with this project's positioning: generated files
 * stand alone, and `emit/` is meant to be adoptable without inheriting
 * anything of ours. So the general case stays a `TODO(invariant …)` block
 * comment on the field, exactly as before.
 *
 * This module translates **one shape**, chosen by measurement rather than by
 * how easy it looked:
 *
 *     A.exists() or B.exists() [or C.exists() …]
 *
 * Counting every `constraint` in `hl7.fhir.us.core#6.1.0` and
 * `hl7.fhir.r4.core#4.0.1` (266 distinct rules) against the 158 invariant
 * markers US Core's generated output actually carries, that one shape is 63
 * of the 158 — 40% of the emitted population, and the largest single group by
 * a wide margin. The runners-up are not close and mostly don't pay: the
 * `field.matches('…')` family is 35 distinct rules but contributes **zero**
 * markers to US Core's output (those elements aren't emitted here), and
 * `(status='x' or status='y') implies field.exists()` is another 8 rules for
 * zero markers. Anything involving `resolve()`, `%resource`, `htmlChecks()`,
 * `descendants()`, type tests (`is` / `ofType()`) or arithmetic is out of
 * reach without an interpreter and is not attempted at any price.
 *
 * ## Why the bar for translating is "all operands resolve, or none"
 *
 * A mistranslated invariant **falsely rejects conformant data**, which this
 * project treats as strictly worse than not enforcing a rule — the same
 * reasoning that forbids a partial `z.enum` for a required binding that can't
 * be fully expanded. So an invariant is enforced only when *every* operand
 * resolves to a key this object actually emits; one unresolvable operand
 * abandons the whole rule and leaves its comment in place. There is no
 * partial enforcement.
 *
 * Two consequences of that rule are load-bearing:
 *
 *   - **`severity: "warning"` invariants are never enforced.** US Core has
 *     five (`con-3`, `us-core-4`, `us-core-5`, `sdcqr-1`, `dom-6`). FHIR
 *     means them as advice; turning one into a hard rejection would reject
 *     data the profile itself considers conformant.
 *   - **A `value.exists()` operand is a choice group, not a key.** `value[x]`
 *     is flattened into `valueQuantity`, `valueString`, … and there is no
 *     `value` key in the emitted object at all. Reading it as a plain key
 *     would make `vs-3` ("if there is no value a data absent reason must be
 *     present") fail on *every* instance, including the ones that carry a
 *     perfectly good `valueQuantity`. It resolves to its variant keys
 *     instead, and satisfying any one of them satisfies the operand.
 */

/** The name of the file-local helper generated files call. Double underscore: not part of the public surface. */
const EXISTS_HELPER = "__fhirInvariantExistsAny";

/**
 * Emitted once per file that needs it, mirroring slicing.ts's matcher.
 *
 * `exists()` in FHIRPath is a statement about a *collection* being non-empty,
 * not about a JSON key being set: a present-but-empty array does not exist,
 * and neither does an explicit `null`. Both cases occur in real payloads, so
 * a bare `!== undefined` would enforce the wrong rule.
 */
export const INVARIANT_HELPER_SOURCE = `function ${EXISTS_HELPER}(data: unknown, keys: string[]): boolean {
  if (data === null || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return keys.some((key) => {
    const value = record[key];
    // FHIRPath exists() is "the collection is non-empty" — an empty array
    // does not exist, and neither does null.
    return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
  });
}`;

/** One invariant this module was able to translate, ready to emit. */
export interface TranslatedInvariant {
  /** The FHIR constraint id, e.g. "obs-3" — used in the runtime message so a failure is traceable to the profile. */
  id: string;
  /** The profile's own human-readable text for the rule. */
  human: string;
  /**
   * One entry per `X.exists()` operand, in source order. Each holds the JSON
   * keys that satisfy it — exactly one for an ordinary field, one per variant
   * for a choice group. The rule is violated when every entry is unsatisfied.
   */
  operands: string[][];
}

/** What a generated file needs from an element to resolve an invariant's operands: its children, and which of them are choice-group markers. */
export interface InvariantScope {
  /** The element's own children, keyed exactly as they are emitted. */
  children: Record<string, { choices?: string[]; choiceOf?: string }>;
}

/**
 * `A.exists() or B.exists() [or …]`, with optional surrounding parens and
 * arbitrary internal whitespace. Deliberately anchored and deliberately
 * restricted to single-segment names: a dotted operand like
 * `identifier.system.exists()` reaches into a nested object and would need a
 * path walk whose empty-collection semantics differ from this one. Those stay
 * comments.
 */
const EXISTS_OR = /^\(?\s*([A-Za-z_][A-Za-z0-9_]*)\.exists\(\)(?:\s+or\s+([A-Za-z_][A-Za-z0-9_]*)\.exists\(\))+\s*\)?$/;
const OPERAND = /([A-Za-z_][A-Za-z0-9_]*)\.exists\(\)/g;

/**
 * Translates one constraint, or returns undefined to leave it a comment.
 *
 * `undefined` is the answer for everything this module doesn't recognize with
 * certainty — an unrecognized shape, a warning-severity rule, or an operand
 * naming something this object doesn't emit. See the module comment on why
 * there is no partial credit.
 */
export function translateInvariant(
  id: string,
  detail: { expression?: string; human?: string; severity?: string },
  scope: InvariantScope
): TranslatedInvariant | undefined {
  if (detail.severity !== undefined && detail.severity !== "error") return undefined;
  const expression = detail.expression?.trim().replace(/\s+/g, " ");
  if (!expression || !EXISTS_OR.test(expression)) return undefined;

  const names = [...expression.matchAll(OPERAND)].map((m) => m[1]);
  if (names.length < 2) return undefined;

  const operands: string[][] = [];
  for (const name of names) {
    const keys = resolveOperand(name, scope);
    if (!keys) return undefined; // one unresolvable operand abandons the whole rule
    operands.push(keys);
  }
  return { id, human: detail.human ?? expression, operands };
}

/**
 * The emitted JSON keys that satisfy one operand, or undefined when it names
 * something this object doesn't emit.
 *
 * A choice-group marker resolves to its variant keys (see the module comment
 * on `vs-3`). Variants are read by scanning for `choiceOf === name` rather
 * than trusting the marker's own `choices` list, matching how
 * objectSchemaBody builds its choice groups — what matters is the keys this
 * object actually emits, not what a list says it should.
 */
function resolveOperand(name: string, scope: InvariantScope): string[] | undefined {
  const child = scope.children[name];
  if (!child) return undefined;
  if (child.choices) {
    const variants = Object.entries(scope.children)
      .filter(([, el]) => el.choiceOf === name)
      .map(([key]) => key);
    return variants.length > 0 ? variants : undefined;
  }
  return [name];
}

/**
 * The `.superRefine()` enforcing every translated invariant on one element,
 * as a single call rather than one per rule — the same shape the choice-group
 * and slice-cardinality checks use.
 *
 * Attached to the element's own schema, so for a repeating element it runs
 * per member: a FHIR constraint on `Observation.referenceRange` is a rule
 * about each reference range, not about the array.
 */
export function invariantSuperRefine(invariants: TranslatedInvariant[], baseIndent: string): string {
  const inner = `${baseIndent}  `;
  const checks = invariants
    .map((invariant) => {
      const conditions = invariant.operands
        .map((keys) => `${inner}  !${EXISTS_HELPER}(data, ${JSON.stringify(keys)})`)
        .join(" &&\n");
      const message = JSON.stringify(`${invariant.id}: ${invariant.human}`);
      return [
        `${inner}if (`,
        conditions,
        `${inner}) {`,
        `${inner}  ctx.addIssue({`,
        `${inner}    code: "custom",`,
        `${inner}    message: ${message},`,
        `${inner}    path: [],`,
        `${inner}  });`,
        `${inner}}`,
      ].join("\n");
    })
    .join("\n");
  return `.superRefine((data, ctx) => {\n${checks}\n${baseIndent}})`;
}
