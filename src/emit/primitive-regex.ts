/**
 * FHIR primitive regex constraints -> Zod `.regex(...)`.
 *
 * FHIR gives most primitive types a regex on their StructureDefinition's
 * `value` element. `@atomic-ehr/fhirschema` does not carry it into FHIR
 * Schema (a converted `id` document has `elements: {}` and no regex field at
 * all), so it's lifted from the raw StructureDefinitions in `resolve/` and
 * handed to emit/ as a `type -> pattern` map. That keeps emit/ a pure
 * `(ResolvedSchema) => string` with no lookups of its own, and means R5 gets
 * R5's regexes without a code change — the alternative, a hardcoded table,
 * would be exactly the "trust the docs over the data" mistake this project
 * was rebuilt to avoid.
 *
 * ## Which types, and why not all of them
 *
 * Two groups are deliberately excluded, and both exclusions are load-bearing
 * rather than conservatism:
 *
 * - **Types we don't emit as strings** (`boolean`, `integer`, `decimal`,
 *   `positiveInt`, `unsignedInt`, `integer64`). Their regex describes a
 *   *serialization* — `integer`'s is `-?([0]|([1-9][0-9]*))` — and we emit
 *   `z.number().int()` / `z.boolean()`, against which a string pattern is
 *   meaningless.
 * - **Types whose regex carries no real signal**: `uri`/`url`/`canonical`
 *   are `\S*` (merely "no whitespace") and `string`/`markdown` are
 *   `[ \r\n\t\S]+` (merely "non-empty"). Neither justifies new rejection
 *   surface, and narrowing `uri` would cut against the project's explicit
 *   rule that it stays a plain `z.string()` — FHIR's uri grammar is broader
 *   than any tidy pattern suggests.
 *
 * What's left is the set that carries genuine structure and is named in
 * CLAUDE.md's own gap list.
 *
 * ## `Resource.id` does not get the `id` regex, and that's correct
 *
 * A reasonable reader will check `Patient.id` first and conclude this is
 * broken. R4 declares `Resource.id` as `http://hl7.org/fhirpath/System.String`
 * (with a `structuredefinition-fhir-type` extension naming `string`), not as
 * the `id` primitive type, so the converter types it `string` and no regex
 * applies. The constraint does land wherever the type really is `id` —
 * `Meta.versionId`, `Extension.valueId` — verified at runtime against
 * generated output. This follows the data rather than the name, which is the
 * behaviour this project wants.
 */

/**
 * Primitive types whose FHIR regex is worth enforcing. Deliberately a
 * closed allow-list rather than "everything the map happens to contain": a
 * future package could supply a regex for `uri`, and the decision not to
 * apply it belongs here, not to whoever assembled the map.
 */
export const PRIMITIVE_REGEX_TYPES = new Set([
  "id",
  "code",
  "oid",
  "uuid",
  "base64Binary",
  "date",
  "dateTime",
  "instant",
  "time",
]);

/**
 * Wraps a FHIR regex so it constrains the whole string.
 *
 * Two separate mistakes are being avoided, and skipping either makes the
 * constraint silently useless rather than merely imperfect:
 *
 * 1. **Anchoring.** FHIR regexes are defined as whole-string matches, but
 *    Zod's `.regex()` is `RegExp.test`, a substring search. Unanchored,
 *    `id`'s `[A-Za-z0-9\-\.]{1,64}` matches inside `"bad id!"` and accepts it.
 * 2. **The non-capturing group.** `^` and `$` bind tighter than `|`, so
 *    `/^true|false$/` parses as `/(^true)|(false$)/` and accepts
 *    `"falsehood"`. Several FHIR regexes are top-level alternations, so the
 *    group is what makes the anchors actually apply.
 */
export function anchorFhirRegex(pattern: string): string {
  return `^(?:${pattern})$`;
}

/**
 * The `.regex(...)` suffix for a primitive element, or `""` when none
 * applies — no map supplied, type not eligible, or no pattern for it.
 */
export function primitiveRegexSuffix(type: string, patterns: Record<string, string> | undefined): string {
  if (!patterns || !PRIMITIVE_REGEX_TYPES.has(type)) return "";
  const pattern = patterns[type];
  if (!pattern) return "";
  // Emitted as a literal, so a `/` inside a FHIR pattern (base64Binary has
  // one) has to be escaped or it would close the literal early.
  return `.regex(/${anchorFhirRegex(pattern).replace(/\//g, "\\/")}/)`;
}
