# Slicing → Zod design

> **Status: implemented** in `src/emit/slicing.ts` (tests in
> `src/emit/slicing.test.ts`, runtime gate at the bottom of
> `src/emit/regression.test.ts`). The design below was followed as written;
> four points have been overtaken by events since it was authored, noted
> here rather than by editing the body:
>
> 1. **The matcher needed one branch this document doesn't describe.** §2's
>    `__fhirSliceMatches` returns false for an object pattern against an array
>    value, and the converter is inconsistent about wrapping: US Core writes
>    `{code:{coding:[{system,code}]}}` while genomics-reporting writes
>    `{coding:{system,code}}` for the same always-repeating
>    `CodeableConcept.coding`. As shipped, an object pattern met by *any*
>    element of an array value matches. Without it, 57 of
>    genomics-reporting's 81 conformant examples were rejected.
> 2. **§2's note that `ExtensionSchema` is "today: `z.unknown()` with a TODO"
>    is stale** — issue #6 made it a real cross-file reference, and #23 made
>    `extension` correctly `array: true`, which is what lets extension slicing
>    emit against a real array at all.
> 3. **§7's recommendation to file the converter bug upstream was
>    considered and declined** — see issue #26 for the maintenance-signal
>    evidence behind that call.
>
> §7's hazard is not hypothetical: two US Core profiles
> (`USCoreLaboratoryResultObservationProfile`,
> `USCoreConditionProblemsHealthConcernsProfile`) have a `category` slice
> whose `match` is empty and whose only other pattern source is the corrupted
> `schema.pattern`. Both degrade to a loud warning and no constraint, exactly
> as §4 prescribes.
>
> 4. **The empty-`match` case turned out to be the rule, not the exception,
>    and is now repaired upstream of `emit/` (issue #32).** This document
>    treats a missing `match` as a rare degradation; measured across seven
>    IGs it is `{}` for 558 of 711 slices, which left 60 slice cardinalities
>    unenforced in generated output. `resolve/slice-match-recovery.ts` now
>    reads the discriminating `pattern[x]`/`fixed[x]` back off the raw
>    StructureDefinition and writes it into `match` before `merge/` sees the
>    document — so everything §4 and §7 say about `emit/` still holds
>    verbatim, `emit/` still reads only `match`, and the warning path is now
>    reached by 29 slices instead of 60. Of the two US Core profiles named
>    above, the laboratory one recovers; the problems/health-concerns one has
>    no pattern in its source at all and correctly still warns.

**Author:** research/design subagent (no code written)
**Scope:** de-risk Phase 3d (slicing) before dispatch. Grounded in the three
committed fixtures plus a direct scan of the real `hl7.fhir.us.core#6.1.0`
package cached at `~/.fhir/packages/hl7.fhir.us.core#6.1.0`.
**Standing rule this whole doc obeys:** never reject conformant data. Every
recommendation below defaults to the permissive option when in doubt, and
says so explicitly.

---

## 1. What slicing shapes actually occur

### In our three committed fixtures

| Fixture | Sliced element | Discriminator | Rules | # slices |
|---|---|---|---|---|
| `uscore-blood-pressure.fhirschema.json` | `component` (array, `2..*`) | `[{type:"pattern", path:"code"}]` | `open` | 2 (`systolic`, `diastolic`) |
| `vitalsigns.fhirschema.json` / `uscore-vital-signs.fhirschema.json` | `category` (array, `1..*`) | `[{type:"value", path:"coding.code"}, {type:"value", path:"coding.system"}]` | `open` | 1 (`VSCat`) |
| `uscore-patient.fhirschema.json` | `extension` (array, `0..*`) | **absent** — no `discriminator` key at all | unset | 6 (`race`, `ethnicity`, `tribalAffiliation`, `birthsex`, `sex`, `genderIdentity`) |

Verified by direct read (not paraphrase — see each fixture's line numbers
below).

- **`pattern` discriminator**, `fixtures/uscore-blood-pressure.fhirschema.json:35-45`:
  ```json
  "slicing": {
    "discriminator": [{ "type": "pattern", "path": "code" }],
    "ordered": false, "rules": "open", "min": 2,
    "slices": { "systolic": {...}, "diastolic": {...} }
  }
  ```
  Each slice's `match` is a partial `CodeableConcept` shape wrapped under the
  discriminator's path (`match.code = {coding:[{system,code}]}`, matching
  `path:"code"`):
  ```json
  "systolic": { "match": { "code": { "coding": [
    { "system": "http://loinc.org", "code": "8480-6" } ] } }, "min": 1, "max": 1 }
  ```

- **`value` discriminator, two ANDed paths**, `fixtures/vitalsigns.fhirschema.json`
  (`category` element — confirmed also inherited unchanged into
  `uscore-vital-signs.fhirschema.json` and further into blood pressure via
  `resolve.test.ts:341-345`):
  ```json
  "slicing": {
    "discriminator": [
      { "type": "value", "path": "coding.code" },
      { "type": "value", "path": "coding.system" }
    ],
    "rules": "open", "min": 1,
    "slices": { "VSCat": { "match": { "coding": [
      { "code": "vital-signs", "system": "http://terminology.hl7.org/CodeSystem/observation-category" }
    ] } }, "min": 1, "max": 1 } }
  }
  ```
  **Key finding:** even though there are *two* discriminator entries, they
  collapse into **one** `match` object shaped exactly like the `pattern` case
  — `{coding: [{code, system}]}`. The converter has already done the work of
  combining multi-path `value` discriminators into a single deep-match
  pattern. This means our emitter does not need to special-case "how many
  discriminator paths" or interpret `path` strings at all — see §2.

- **Extension slicing**, `fixtures/uscore-patient.fhirschema.json` (top-level
  `extensions` map, and mirrored in `elements.extension.slicing`):
  ```json
  "race": { "max": 1, "short": "...", "mustSupport": false,
    "url": "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race", "index": 0 }
  ```
  and inside `elements.extension.slicing.slices.race`:
  ```json
  { "match": {}, "schema": { "...", "url": "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race", "max": 1 }, "max": 1 }
  ```
  `match` is **empty** (`{}`) for every extension slice. `slicing.discriminator`
  is **absent entirely** — not an empty array, the key doesn't exist. The only
  place the distinguishing value lives is `schema.url` (mirrored on the
  top-level `document.extensions[name].url`).

  **This is a converter-specific representational choice, not a FHIR-spec
  fact** — worth stating explicitly because it contradicts the raw spec (see
  next section). Treat "no `discriminator` key on a `slicing` block" as our
  signal for "this is extension slicing, match by `schema.url`" — verified
  against the only fixture we have of this shape. Recommend a regression test
  asserting this invariant, and degrading safely (no slicing enforcement,
  loud warning) if a future document breaks it rather than crashing or
  guessing.

### More broadly, across real US Core (quantified, not assumed)

`~/.fhir/packages/hl7.fhir.us.core#6.1.0` was already cached on disk
(presumably from earlier fixture work). I scanned all 59 `StructureDefinition-*.json`
files' `differential.element[].slicing` blocks directly (raw FHIR, not FHIR
Schema — but discriminator `type` is a spec-defined enum that the converter
passes through verbatim, confirmed by our own fixtures matching
`FhirSchemaDiscriminatorType`):

```
discriminator type counts: {'pattern': 24, 'value': 5}
slicing blocks total: 28, across 25 distinct profiles
rules distribution: {'open': 28}          ← zero closed, zero openAtEnd, anywhere
ordered distribution: {None: 25, False: 3} ← zero ordered:true, anywhere
```

- **`pattern` is the dominant shape** (24/29 discriminator entries, ~83%) —
  `Observation.category`, `Practitioner.identifier`, `Observation.code.coding`
  (Pulse Oximetry), and the blood-pressure `component` case we already have.
- **All 5 `value` discriminators are extension-url slicing**
  (`Extension.extension`, discriminator `{type:"value", path:"url"}`) — e.g.
  `USCoreRaceExtension`, `USCoreEthnicityExtension`,
  `USCoreTribalAffiliationExtension`. Interesting wrinkle: **at the raw
  StructureDefinition level, extension slicing DOES carry an explicit
  discriminator** (`value` on `path:"url"`) — it's specifically
  `@atomic-ehr/fhirschema`'s FHIR Schema conversion that drops it and encodes
  `url` on `schema.url` instead. Confirms the project's own standing rule
  ("where the converter's actual output disagrees with the spec/docs, the
  converter wins") applies here too — document this divergence in
  `fhir-schema-types.ts` alongside the existing ones.
- **Zero occurrences of `exists`, `type`, `profile`, or `position` discriminators**
  anywhere in US Core 6.1.0. Not zero-probability in FHIR generally (R5 IGs
  and some international IGs use `type`-discriminated polymorphic slicing,
  e.g. `Bundle.entry.resource`-style), but out of scope for a v1 driven by
  what actually appears in our target IG. Recommend explicitly *not*
  building for these — see §6.
- **Zero `closed` and zero `openAtEnd` rules** anywhere in US Core 6.1.0.
  This directly informs §4.

Caveat, stated plainly rather than glossed over: the `path:"$this"` cases
(24 of the 29 real discriminators use `$this`, meaning the pattern applies to
the *whole* sliced element, not a sub-path — e.g. `Observation.category`
itself, not `category.code`) are **not exercised by any of our three
fixtures**. Our only `pattern` fixture uses `path:"code"` (a sub-path). I'm
inferring from the converter's demonstrated behavior (wrapping `match` under
the discriminator's path) that a `$this` discriminator would produce a
`match` with no wrapper (the bare pattern value directly), but this is
**not fixture-verified** — flag as a gap, not a fact. Recommend adding one
`$this`-shaped fixture (e.g. `USCoreObservationPregnancyStatusProfile`'s
`Observation.category`, or the simpler `USCorePractitionerProfile.identifier`)
in Phase 1-style ground-truth work before or alongside implementing this, per
this project's own "never trust a shape you haven't seen in a fixture" rule.
The design below only needs `slice.match` to already be a complete deep-match
pattern for the sliced array element — it does **not** need to parse
`discriminator[].path` itself (see §2) — so this gap is containable: worst
case, a `$this`-discriminated slice's `match` isn't shaped the way our
matcher expects and the slice quietly fails to match anything, which (per
§4) only affects the `min` floor, never rejects data. Still worth verifying
before shipping.

**Update: verified.** See "Appendix: `$this` verification" at the end of this
document — `fixtures/uscore-observation-pregnancystatus.fhirschema.json` now
exercises this exact shape, and the inference above holds.

---

## 2. Mapping each shape to Zod

### Does `z.discriminatedUnion` fit? Mostly no.

`z.discriminatedUnion(key, variants)` requires: every variant is an object
schema, all variants share one literal-valued top-level key, and the union is
**closed** (anything not matching one variant's literal is rejected). None of
our three observed shapes satisfy this cleanly:

- **`pattern`/`value` (component, category):** the discriminating data lives
  *inside* a nested array (`code.coding[].code`, not a flat top-level field),
  and slicing `rules` is `open` in 100% of observed cases — meaning array
  elements that match *no* slice are still legal. A `discriminatedUnion`
  would reject those, which is exactly the "reject conformant data" failure
  mode this project is built to avoid.
- **Extension slicing:** could theoretically use `url` as a discriminant key
  since it *is* a flat top-level literal field — but `rules` is unset
  (effectively open/unconstrained) and a resource's `extension` array
  legitimately contains extensions **not** in the profile's named slice list
  (any base FHIR extension, or one from an unrelated IG) — same open-array
  problem.

**The one theoretical fit:** a `value`-discriminator on a single flat
top-level field, with `rules: "closed"`, where every legal value really is
covered by a named slice. Zero occurrences of this exact combination in
US Core 6.1.0 (closed rules never appear at all). Not worth building for v1;
note it as a possible future optimization *if* a closed+flat-discriminator
case ever shows up in fixture data, not before.

**Conclusion: the general fallback — `z.array(elementSchema).superRefine(...)`
checking slice membership counts — is not a fallback, it's the only shape
that actually fits what real US Core does.** This directly answers the
"where does it not fit, what's the alternative" framing: nowhere in our
target IG does discriminatedUnion fit, and the alternative is not
"union + refine" either (there's no need for a union of element *types* —
every slice member is still structurally a valid instance of the same base
element type, e.g. every `component` is still `ObservationComponent`,
whether it's the systolic slice or not). It's array-level cardinality
counting.

### The general primitive: a single deep-partial-match helper

Both `pattern` and `value`-discriminator `match` objects are already shaped
as ready-to-use deep-partial patterns (§1's "key finding"). One small
recursive helper handles both, and handles extension-url matching too if we
just synthesize a one-key pattern (`{url: "..."}`) for that case. This keeps
the runtime surface to one function instead of three discriminator-specific
code paths:

```ts
// Emitted once per generated file that needs it (local, unexported — no
// barrel collision risk across files). FHIR pattern-matching semantics:
// object patterns require every named key to match; array patterns require
// every pattern element to be matched by *some* value element (not
// positional, not exhaustive — extra value-array elements are fine).
function __fhirSliceMatches(value: unknown, pattern: unknown): boolean {
  if (pattern === null || typeof pattern !== "object") {
    return value === pattern;
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value)) return false;
    return pattern.every((p) => value.some((v) => __fhirSliceMatches(v, p)));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(pattern as Record<string, unknown>).every(
    ([k, p]) => __fhirSliceMatches((value as Record<string, unknown>)[k], p)
  );
}
```

This is a plain structural-recursion function, identical in Zod 3 and 4 (no
Zod API surface at all), so it doesn't touch the "version-agnostic emitted
output" constraint from the design doc's §7.

### Emitted shape for `component` (pattern discriminator)

The array's *element* schema stays the plain, unsliced base type
(`ObservationComponent`, from `component.elements` — already correctly
resolved per `resolve.test.ts:348-357`, unaffected by any of this). Slicing
is layered on as a `.superRefine()` **on the array**, after the existing
`.min()`/`.max()` calls emit.ts already produces from `el.min`/`el.max`
(unchanged — see §3 for why the overall array bound and per-slice bounds are
different numbers that don't conflict):

```ts
component: z.array(z.object({
  "id": z.string().optional(),
  "code": CodeableConceptSchema,
  "valueQuantity": QuantitySchema.optional(),
  // ...rest of the existing, already-correct ObservationComponent shape...
})).min(2).superRefine((items, ctx) => {
  const slices = [
    { name: "systolic", min: 1, max: 1,
      match: (v: unknown) => __fhirSliceMatches(v, {"code":{"coding":[{"system":"http://loinc.org","code":"8480-6"}]}}) },
    { name: "diastolic", min: 1, max: 1,
      match: (v: unknown) => __fhirSliceMatches(v, {"code":{"coding":[{"system":"http://loinc.org","code":"8462-4"}]}}) },
  ];
  for (const slice of slices) {
    const count = items.filter(slice.match).length;
    if (count < slice.min) {
      ctx.addIssue({ code: "custom", message: `expected at least ${slice.min} "component" element(s) matching slice "${slice.name}", found ${count}` });
    }
    if (slice.max !== undefined && count > slice.max) {
      ctx.addIssue({ code: "custom", message: `expected at most ${slice.max} "component" element(s) matching slice "${slice.name}", found ${count}` });
    }
  }
}).optional(),
```

(Whether `.max()` per-slice is actually emitted is a §4 decision — shown
here for completeness; the recommended v1 default keeps it, see §4.)

### Emitted shape for `extension` (url-based)

Same helper, same `.superRefine()` shape, pattern synthesized as `{url: "..."}`
instead of taken from `match` (which is `{}` for this shape):

```ts
extension: z.array(ExtensionSchema).superRefine((items, ctx) => {
  const slices = [
    { name: "race", min: 0, max: 1,
      match: (v: unknown) => __fhirSliceMatches(v, {"url":"http://hl7.org/fhir/us/core/StructureDefinition/us-core-race"}) },
    { name: "tribalAffiliation", min: 0, max: undefined,
      match: (v: unknown) => __fhirSliceMatches(v, {"url":"http://hl7.org/fhir/us/core/StructureDefinition/us-core-tribal-affiliation"}) },
    // ...ethnicity, birthsex, sex, genderIdentity...
  ];
  for (const slice of slices) {
    const count = items.filter(slice.match).length;
    if (count < slice.min) { /* same addIssue as above */ }
    if (slice.max !== undefined && count > slice.max) { /* same */ }
  }
}).optional(),
```

Note `ExtensionSchema` here is whatever the *rest* of Phase 3/defect 5
resolves `Extension` to (today: `z.unknown()` with a TODO, per
`emit.ts:159-168`) — url-matching only needs `(v as {url?:unknown})?.url` to
exist, which `__fhirSliceMatches` handles fine against `z.unknown()`-typed
runtime values (the check is purely structural, not dependent on Extension
being fully typed). **Slicing enforcement here is fully decoupled from
defect 5's cross-file Extension resolution** — worth calling out explicitly
in the dispatch brief since it means Phase 3d doesn't block on Phase 3's
Extension-type work, and vice versa.

### Where the extension/URL slice list comes from

Two equally-valid sources exist on `ResolvedElement`: `el.slicing.slices`
(keyed by slice name, `schema.url` per slice) and `el.extensions` (the
document/element-level named-extension map, also carrying `url`). They
mirror each other in the fixture. Recommend reading from `el.slicing.slices`
uniformly for **all three** shapes (pattern, value, extension) — one code
path in emit.ts, rather than branching into `el.extensions` as a second
data source for one shape only. `el.extensions` stays available for a
possible future feature (named accessor exports, e.g. a convenience
`patientRaceExtension` helper) but isn't needed for slice validation itself.

---

## 3. The array problem — this is the crux, and here's the concrete resolution

FHIR slicing partitions a repeating element into named, individually-
cardinality-constrained groups. Zod validates arrays element-wise
(`z.array(elementSchema)` applies `elementSchema` to each item
independently) — there is no built-in Zod primitive for "N elements of this
array must satisfy predicate P". `.superRefine()` on the array is the
correct and only tool: it receives the *whole parsed array* (after each
element already passed `elementSchema`) and can inspect it collectively.

**The design decision that makes this tractable:** don't try to validate
each slice's *narrower* schema (e.g. that a systolic component's `code`
exactly matches the fixed pattern down to every field, or that its
`valueQuantity.unit`/`system`/`code` are the fixed `mmHg`/UCUM values the
slice schema declares). That would require compiling a second, per-slice
mini zod-schema from `slice.schema.elements` — doubling the emitter's
surface, and directly exposed to the `[Circular Reference]` corruption in
§7. Instead:

1. **The array element type stays the existing, already-correct
   unsliced base type** (`component.elements`, resolved once, shared by
   every slice member and any non-sliced elements alike). This is always
   safe/permissive: FHIR profiles narrow, never widen, so every valid slice
   member is *automatically* a valid instance of the unsliced base type. No
   new rejection risk introduced here at all.
2. **Slice cardinality is a pure array-level count**, expressed as one
   `.superRefine()` per sliced array, checking "how many elements does
   `slice.match` deep-match" against each slice's own `min`/`max` (from
   `slicing.slices[name].min`/`.max` — **not** to be confused with the
   *array's own* `min`/`max`, which is a different, already-handled number:
   `component.min = 2` is the overall array floor, already emitted correctly
   today via the existing `el.array` branch in `elementToZod`
   (`emit.ts:171-181`) with zero changes needed. `slicing.slices.systolic.min/max`
   is the *systolic-specific* floor/ceiling (1/1) — a separate, additional
   constraint layered on top via `.superRefine()`. They coexist without
   conflict: `.min(2)` on the array, then `.superRefine` checking systolic
   count ∈ [1,1] and diastolic count ∈ [1,1] within that already-≥2-length
   array.

This is a genuinely correct, not half-right, answer to "exactly one element
matches the systolic pattern within a 2..* array" — it's precisely what
`.superRefine` is for, and it doesn't require re-deriving or re-validating
anything already handled by the element schema.

---

## 4. Slice cardinality and `rules` — what to enforce, what not to, and why

Grounded in both the fixture data (§1: 100% `open`, 0% `closed`/`openAtEnd`)
and a risk analysis of what each enforcement choice can get wrong:

| Constraint | Enforce in v1? | Reasoning |
|---|---|---|
| Sliced array's own overall `min`/`max` | **Yes — already works**, no change needed | Ordinary `el.min`/`el.max` on the array element itself, already emitted by existing code. |
| Per-slice `min` (floor) | **Yes** | Positive assertion sourced from `slicing.slices[name].min`, matched via the reliable `match` field (§7 confirms `match` is never corrupted in our fixtures — only the redundant inner `schema.elements.*.pattern` is). Risk: only fires if the matcher *under*-matches (misses a real member) — mitigated by using the converter's own pre-combined `match` object rather than re-deriving matching logic from `discriminator[].path` ourselves. |
| Per-slice `max` (ceiling) | **Yes, but flagged lower-confidence** | Symmetric risk: only fires if the matcher *over*-matches (a false positive — an element structurally satisfies the pattern without being a "true" intended slice member). For LOINC-code-pattern and URL-based matching this is a narrow, low-probability failure mode (system+code pairs and canonical URLs are effectively unique identifiers), but it's real in principle (e.g. two different codings on one component, one of which happens to also carry the pattern's system+code as a *secondary* coding). Recommend shipping it — US Core's own slices are min=max=1 in every observed case, so max-enforcement is exactly what makes the schema mean anything beyond "at least one" — but call this out explicitly in the dispatch brief as the one place a false-reject could theoretically slip through, and make sure the semantic-gate test (design doc §5) includes a case that would catch it. |
| `rules: "closed"` — reject elements matching **no** named slice | **No, not in v1** | This is a pure negative constraint (forbidding *anything else*) layered on top of an open-by-default matcher we just built — the highest-risk thing to get wrong, and the one category where a matcher bug or an unmodeled-but-legal shape directly causes a false reject. Zero occurrences in US Core 6.1.0 to validate against even if we wanted to build it. Skip entirely; if `rules === "closed"` is ever seen, emit a comment noting it's present but unenforced (loud gap, not silent — matches this project's existing convention for defect 5/choice types) rather than attempting enforcement without a fixture to prove it against. |
| `openAtEnd` — unsliced elements must appear after all sliced ones | **No** | Positional/ordering constraint, meaningfully more complex (would need to track *which* array index each match came from, not just counts), zero fixture occurrences, zero occurrences anywhere in US Core 6.1.0. Not worth inventing against zero evidence. |
| `ordered: true` | **No** | Same reasoning — zero occurrences observed (`{None: 25, False: 3}` — literally never `true`). |

**Summary framing for the dispatch brief:** v1 slicing enforces *presence
and count floors/ceilings for named slices*, using the converter's own
pre-computed `match` data, and explicitly does **not** attempt to forbid
anything, order anything, or re-validate a slice member's internal shape
beyond what the (always-safe) unsliced base type already checks. Every
constraint it emits is additive on top of already-correct existing
behavior, and every constraint it *doesn't* emit degrades to "not enforced,"
never to "enforced incorrectly."

---

## 5. Extension slicing — proposed emitted shape

Already covered concretely in §2's second code sample. Restated as the
answer to this specific question: match by `url`, sourced from
`slicing.slices[name].schema.url` (verified present on all 6 slices in the
one fixture we have; also mirrors `document.extensions[name].url`). Same
`__fhirSliceMatches` helper, same `.superRefine()` shape as the general case
— no separate code path needed beyond "how is the pattern constructed"
(§2's "Where the extension/URL slice list comes from"). This is the
**lowest-risk** slicing shape to enforce fully (both min and max, no
hedging) because canonical URL equality has effectively zero false-positive
or false-negative surface, unlike LOINC-pattern matching.

---

## 6. Staged plan — what v1 should and should not attempt

**Ship in v1** (genuinely correct, fixture-verified, matches the "at least
1 real occurrence in our target IG" bar):

1. Extension slicing by `url` (§5) — the single most common real shape
   (6/6 observed slices in our one fixture; broader US Core scan shows
   extension-url slicing on every US Core extension StructureDefinition).
   Enforce both `min` and `max` per named extension.
2. `pattern`/`value`-discriminator slicing on repeating complex-type
   elements (`component`, `category`), using `slice.match` directly with
   `__fhirSliceMatches`, without interpreting `discriminator[].path` — this
   is the mechanism that generalizes across both discriminator types with
   zero special-casing (§1's key finding). Enforce `min`; enforce `max` with
   the caveat noted in §4.
3. The array element's own schema stays the existing unsliced base type —
   no new work, no new risk, this is already correct.
4. A defensive guard (see §7) that detects the `"[Circular Reference]"`
   sentinel anywhere a `pattern.value` or `fixed.value` is read (not just in
   slicing) and degrades to "no constraint, loud warning" rather than
   silently treating the literal string as real match data.

**Explicitly do not attempt in v1** (say so with a visible marker, per this
project's existing "loud gap beats silent gap" convention — same pattern as
the choice-type and defect-5 TODOs already in `emit.ts`):

1. `rules: "closed"` enforcement (§4) — zero fixture evidence, highest
   false-reject risk category.
2. `openAtEnd` / `ordered: true` positional slicing — zero fixture evidence
   anywhere in US Core 6.1.0.
3. Re-validating a slice member's full narrower schema (fixed units, nested
   required fields beyond what the unsliced base type already requires) —
   would require compiling per-slice mini-schemas from `slice.schema`,
   doubling emitter surface and walking directly into the `[Circular
   Reference]` hazard (§7) for no conformance benefit the array-level
   `.superRefine` doesn't already provide.
4. `exists`/`type`/`profile`/`position` discriminators — zero occurrences in
   US Core 6.1.0, no fixture to build or test against. If one of these is
   ever hit, the safe fallback is the same as any other "sliced element we
   don't recognize the shape of": emit the array with its overall
   `min`/`max` only (already correct, already safe) and a warning that named
   slice cardinality isn't enforced for that element — never silently drop
   to `z.unknown()` for the whole array, which would be a regression.
5. `$this`-path discriminator verification (§1's caveat) — recommend a
   fixture before relying on it, even though the mechanism should work
   unchanged if `match` is shaped the way I expect.

**Suggested test shape**, matching `defects.test.ts`'s existing convention
(one `it.fails()` per gap, flipped when fixed): add slicing-specific cases
to a new `src/emit/slicing.test.ts` rather than overloading `defects.test.ts`
(slicing isn't one of the six original verified defects), asserting against
`emitFixture("uscore-blood-pressure.fhirschema.json")` and
`emitFixture("uscore-patient.fhirschema.json")` directly — plus the
semantic-gate style test the design doc's §5 already calls for: a
conformant Observation (2 components, one matching each pattern) parses
successfully, and a non-conformant one (0 or 2 systolic-matching components)
is rejected by the emitted schema when `.superRefine` is actually exercised
at runtime, not just inspected as generated source text.

---

## 7. Known hazard — `"[Circular Reference]"` in `pattern.value`

Confirmed directly, `fixtures/uscore-blood-pressure.fhirschema.json:64-72`
and the mirrored diastolic block at `:144-152`:

```json
"code": {
  "short": "(USCDI) Systolic Blood Pressure Code",
  "pattern": { "type": "CodeableConcept", "value": "[Circular Reference]" },
  "mustSupport": true, "type": "CodeableConcept", "index": 3
}
```

This is `@atomic-ehr/fhirschema`'s own cycle-detection guard leaking into its
output. There is no genuine cycle — a CodeableConcept pattern is a small finite
tree.

**Corrected mechanism (2026-08-21).** An earlier draft of this section, and two
independent investigations, described the cause as "structural repetition across
slices misdetected as recursion." That is wrong, and it was verified wrong: a
synthetic StructureDefinition with a **single** slice and nothing repeated
reproduces it exactly.

What actually distinguishes the corrupted field is that the same value is
reachable by two paths in the result tree — `slice.match` and
`slice.schema.elements.code.pattern.value` — and only the *second* is replaced.
That is the signature of cycle detection keyed on object identity, which flags
any second encounter of the same object, including a shared reference in a DAG.
A DAG is not a cycle; separating the two requires tracking the current ancestor
chain rather than every node visited.

(Inferred from observed behavior — the converter's traversal code has not been
read. See pjerus/fhir-zod-gen#26 for why this was not reported upstream.)

**Does this block pattern-matching on these slices? No — because the design
in §2/§3 never reads this field.** The reliable, uncorrupted source of the
match pattern is `slicing.slices.systolic.match` (verified intact both here
and above at `:46-56`):
```json
"match": { "code": { "coding": [{ "system": "http://loinc.org", "code": "8480-6" }] } }
```
— a completely normal object, not the sentinel string. The corruption is
scoped **only** to the redundant, deeper copy at
`slicing.slices.systolic.schema.elements.code.pattern.value` — exactly the
per-slice "narrower schema" data §3 already recommends not using. So the
hazard doesn't block the recommended design; it specifically blocks the
design *not* recommended (re-deriving each slice's own inner constraints
from `schema.elements`), which is one more concrete reason to skip that
path in v1 rather than a coincidence.

**What to do about it, concretely:**

1. Confirm the design (§2/§3) only ever reads `slicing.slices[name].match`
   for pattern construction, never `slicing.slices[name].schema.elements.*.pattern`
   — make this an explicit code-review checkpoint for whoever implements
   Phase 3d, since "just use the slice's schema" is the natural first
   instinct and is exactly where this bites.
2. Add a defensive, general (not slicing-specific) guard in wherever
   `FhirSchemaPattern.value` / `FhirSchemaElement.fixed.value` is read: if
   `pattern.type` names a complex type (not a FHIR primitive) and
   `pattern.value` is the literal string `"[Circular Reference]"`, treat it
   as absent/unusable — degrade to no constraint from that field, with a
   loud warning, rather than ever comparing real data against the string
   `"[Circular Reference]"` (which would be silently-always-false, and
   worse, easy to miss in review since `"[Circular Reference]" === "[Circular Reference]"`
   would look like a passing test if anyone ever hand-authored a fixture
   containing that literal string as "expected" — a trap for exactly the
   kind of closed-loop-validates-nothing mistake this project's whole
   rebuild was triggered by, per the design doc §1's opening paragraph).
   This guard has value beyond slicing — `fixed`/`pattern` matching on
   non-sliced elements could hit the same converter bug on any complex-type
   pattern/fixed value, not just inside a slice.
3. File the bug upstream against `@atomic-ehr/fhirschema` (structural
   repetition ≠ actual recursion) — not blocking for this project, but worth
   doing since it'll bite the next consumer of this converter too.
4. Add a regression test asserting the guard fires on this exact fixture
   data (`uscore-blood-pressure.fhirschema.json`'s systolic/diastolic `code`
   elements) so a future converter version that fixes the upstream bug is
   noticed (test starts asserting "guard didn't fire, real data present")
   rather than the guard silently mattering less over time without anyone
   noticing the underlying data got better.

---

## Summary for the dispatch brief

- Two real discriminator shapes to build for (`pattern`/`value`-with-match,
  and extension-url), one already-safe no-op (unsliced base element type),
  one small shared runtime helper (`__fhirSliceMatches`), one new
  `.superRefine()` per sliced array.
- `z.discriminatedUnion` doesn't fit anything we actually see in US Core;
  don't reach for it.
- The `[Circular Reference]` hazard is real but contained — it only matters
  if implementation strays into re-deriving slice-member schemas from
  `schema.elements`, which v1 shouldn't do anyway.
- Enforce: per-slice min/max via array-level `.superRefine`, on top of the
  already-correct overall array min/max.
- Don't enforce: `closed` rules, ordering, slice-member internal narrowing,
  unobserved discriminator types (`exists`/`type`/`profile`/`position`).
- One fixture gap flagged for before-or-alongside: a `$this`-path
  `pattern` discriminator (e.g. `Observation.category` on a non-vital-signs
  profile, or `Practitioner.identifier`) to verify the "match has no
  wrapper" assumption in §1's caveat.

---

## Appendix: independent verification (reviewer)

The statistics above were re-derived independently before this document was
accepted, because the whole design rests on them.

**A discrepancy surfaced and was resolved.** Counting slicing across the raw
`StructureDefinition-*.json` files in `hl7.fhir.us.core#6.1.0` gives a
different answer depending on which section you read:

| Source | pattern | value | type | closed |
|---|---|---|---|---|
| `differential` (what the profile authors) | 24 | 5 | 0 | 0 |
| `snapshot` (includes inherited from base R4) | 25 | 115 | **19** | **6** |
| **`translate()` output (what we actually consume)** | **24** | **5** | **0** | **0** |

Since `translate()` builds from the snapshot, the concern was that our
generator would see the inherited `type` discriminators and `closed` rules
that the differential doesn't contain. It does not — the converter normalizes
them away. Verified by running `translate()` over all 59 US Core
StructureDefinitions and walking the output:

```
slicing blocks in CONVERTED output: 33
discriminator types: { pattern: 24, value: 5 }
rules: { open: 28, '(none)': 5 }
```

So the design's scope (pattern + value + extension-url, skip closed/ordered)
is correct **for our pipeline specifically**. Anyone porting this reasoning to
a tool that consumes raw StructureDefinitions should redo the count.

**One correction to the body above:** there are 33 slicing blocks but only 28
carry a `rules` field. Five have none at all. Per the FHIR spec an absent
`rules` means `open`, but the implementation must default it explicitly rather
than assume the field is present.

---

## Appendix: `$this` verification (follow-up)

§1's caveat above flagged that the `path:"code"`-wrapped `match` shape seen
in our only pre-existing `pattern` fixture (blood pressure's `component`)
was the *only* shape verified, and that the IG's dominant `pattern` shape —
`path:"$this"`, a whole-element match, 24 of 29 real discriminators — was
unverified. This section closes that gap.

**Fixture added:** `fixtures/uscore-observation-pregnancystatus.fhirschema.json`
(`USCoreObservationPregnancyStatusProfile`, converted via
`scripts/build-fixtures.ts` step 4c). Chosen over the other candidate named
in §1 (`USCorePractitionerProfile.identifier`, also `$this`) after converting
both and inspecting the output: this profile's base is plain `Observation`
(already fixture'd as `fixtures/observation.fhirschema.json`) and its element
types (`CodeableConcept`, `Reference`) are already in `DATATYPES`, so adding
it costs one new profile file and nothing else — no new base resource, no new
datatype, no new ValueSet (its one binding is `preferred` strength, which
correctly stays unexpanded per the project's existing conformance rule). The
Practitioner candidate would have required translating a wholly new base
resource (`Practitioner` isn't in the fixture set at all yet) for the same
verification value. Re-running the full `build-fixtures.ts` script confirmed
all six previously-committed fixtures are byte-identical to their prior
versions — only the new file was added.

Its `category` element:

```json
"category": {
  "slicing": {
    "discriminator": [{ "type": "pattern", "path": "$this" }],
    "rules": "open",
    "slices": {
      "SocialHistory": {
        "match": {
          "coding": [{
            "system": "http://terminology.hl7.org/CodeSystem/observation-category",
            "code": "social-history"
          }]
        },
        "max": 1
      }
    }
  }
}
```

**Verified via a throwaway script** (per this task's scope boundaries, not
committed — `src/merge/` belongs to `issue6-imports-lazy`), calling
`resolveDocument` on this fixture through the same `SchemaSource`/
`resolveDocument` machinery `defects.test.ts` already exercises, and
comparing the resolved `category` slice's `match` against blood pressure's
resolved `component.slicing.slices.systolic.match` side by side:

```
category (path:"$this")  SocialHistory.match  = { "coding": [{ "system": "...", "code": "social-history" }] }
component (path:"code")  systolic.match        = { "code": { "coding": [{ "system": "...", "code": "8480-6" }] } }
```

**The inference holds, confirmed directly rather than assumed:**

- `path:"code"` → `match` is wrapped under the discriminator's path key
  (`{code: {...}}`).
- `path:"$this"` → `match` is the bare pattern value with **no** wrapper
  (`{coding: [...]}` directly — `coding` is `CodeableConcept`'s own field,
  sitting at the top level of `match` because `$this` means "the whole
  sliced element").

Both shapes are ready to feed directly into `__fhirSliceMatches(item, slice.match)`
(§2) applied to the *whole* array element in both cases — no branching on
`discriminator[].path` needed, exactly as the design assumed. `resolveDocument`
also correctly resolves `category`'s `type: "CodeableConcept"` and
`array: true` from base `Observation` (the profile layer restates neither),
same merge behavior already proven for `component` — nothing new required
of `merge/` to support this shape; it already worked.

**One reconfirming, not new, finding:** this fixture's own inner
`slices.SocialHistory.schema.pattern.value` is *also* corrupted to
`{coding: ["[Circular Reference]"]}` — the same `@atomic-ehr/fhirschema`
converter bug §7 documents for blood pressure, now observed a second,
independent time, on a different profile, with the corruption landing one
level differently (inside the array rather than replacing the whole pattern
value). This strengthens §7's existing conclusion rather than changing it:
the bug is systemic to `schema.elements.*.pattern`/`schema.pattern`
whenever it redundantly restates a slice's `match` data, and the fix is the
same — never read that field for matching, use `slice.match`, which is
intact in both observed cases.

No changes needed to §2, §3, §4, §5, or §6 of the design above — the
mechanism proposed there already covers both discriminator-path shapes
without modification. This appendix exists to convert an inference into a
verified fact, not to revise the design.
