# fhir-zod-gen

Generate [Zod](https://zod.dev) schemas — runtime validators plus inferred TypeScript
types, in one artifact — from FHIR Implementation Guides.

> Status: **early / seeking contributors.** IG packages resolve and generate
> end-to-end, including profiles whose base is itself a profile (multi-level
> chains, e.g. `us-core-blood-pressure -> us-core-vital-signs -> vitalsigns ->
> Observation` — four levels), complex-typed fields resolve to real cross-file
> imports with `z.lazy()` for genuine cycles, and merge narrows cardinality
> correctly (a profile can only tighten, never silently widen, a base's `min`/
> `max`). Generated output is gated on compiling as a whole set (`tsc --strict
> --noEmit` across every file together — cross-file imports mean per-file
> compilation proves nothing) and on accepting/rejecting real conformant
> examples.
>
> Remaining gaps are listed concretely under [What's enforced, and what
> isn't](#whats-enforced-and-what-isnt) — the short version is that most
> FHIRPath invariants are still emitted as comments rather than evaluated.
> This is a starting point to build on, not a finished validator.

FHIR® is HL7's trademark for the healthcare interoperability standard; this
project is community tooling and is not affiliated with or endorsed by HL7.

## Why

FHIR already has a mature validation story in Java: the [official HL7 FHIR
Validator](https://github.com/hapifhir/org.hl7.fhir.core) can load any IG's
NPM package and validate resources against its profiles at runtime, with no
code generation step. There isn't an equivalent for the TypeScript/JavaScript
ecosystem, which is where a large and growing share of health-tech tooling —
web apps, SMART on FHIR apps, Node backends, and increasingly AI agents —
actually lives.

Zod is a natural fit for that role: it's a validator and a type source in one
declaration, and — unlike a generic runtime validator you'd call as an
opaque library — the generated schema is plain, readable TypeScript that
shows up in autocomplete and stays in your own repo.

This tool doesn't parse raw FHIR `StructureDefinition` differentials/snapshots
directly. That format is flexible but genuinely painful to walk correctly
(slicing, snapshot-vs-differential, cross-references). Instead it consumes
[**FHIR Schema**](https://github.com/fhir-schema/fhir-schema), a simplified
JSON-Schema-like intermediate format designed specifically as a
cross-language source for codegen. Health Samurai's team already ships a
Python/Pydantic generator on top of it; this project aims to be the
TypeScript/Zod equivalent.

## Install

```bash
npm install -g fhir-zod-gen
# or, without installing:
npx fhir-zod-gen <input> -o ./generated
```

## Usage

```bash
# From an IG package identifier — downloaded, converted and generated for you
fhir-zod-gen hl7.fhir.us.core#6.1.0 -o ./generated

# ...or from FHIR Schema JSON you already have
fhir-zod-gen ./examples/patient.fhirschema.json -o ./generated
```

```ts
import { PatientSchema, type Patient } from "./generated/Patient.js";

const result = PatientSchema.safeParse(incomingJson);
if (!result.success) {
  console.error(result.error.issues);
}
const patient: Patient = result.data;
```

Point it at a directory of FHIR Schema `.json` files to generate a whole IG
at once — it writes one `.ts` file per profile plus a barrel `index.ts`.

### IG packages

Given a package identifier (`hl7.fhir.us.core#6.1.0`, or a bare id for the
registry's `latest`), the CLI downloads the package **and its declared
dependency closure** — US Core is nothing but constraints on base R4, so
`hl7.fhir.r4.core` has to come along for any of it to resolve — converts
every StructureDefinition to FHIR Schema, and generates.

Packages land in the standard FHIR package cache (`~/.fhir/packages`, shared
with sushi, the IG publisher and HAPI), so the download happens once. Override
it with `--cache-dir <dir>`. The first run for a large IG is a few hundred MB
and about a minute; later runs read the cache.

Before downloading anything, the CLI resolves and prints the full dependency
closure — package ids, versions, what's already cached, and approximate size
where it's actually knowable (a not-yet-cached package's size can't be shown
without downloading it; the registry doesn't expose it). In an interactive
terminal it asks before proceeding; a non-interactive run (CI, piped input)
just logs the closure and continues. If everything is already cached, there's
nothing to ask about and it proceeds straight to generation.

US Core's closure is a real example of why this matters: on top of
`hl7.fhir.r4.core`, it pulls in several terminology packages — `us.nlm.vsac`
and `us.cdc.phinvads` among them — that exist to back `required`-strength
ValueSet bindings with a real code list (`gender: z.enum([...])` instead of
`gender: z.string()`). Together they're most of a ~646 MB first-run download.
If you don't need enum expansion, `--skip-terminology` omits known
terminology-only packages from the download entirely — required bindings
then degrade to `z.string()` with the same `TODO(defect 2)` marker used
whenever a binding's ValueSet can't be found at all. For US Core 6.1.0
specifically, none of its required bindings actually need the terminology
packages to expand (their ValueSets are already reachable without them), so
`--skip-terminology` produces **byte-identical** output while skipping
~389 MB of the ~646 MB closure.

## Verified against

Beyond the fixture-based unit suite, the generator has been run end-to-end
(download or cache read -> convert -> merge -> emit -> compile the whole
output set together under `tsc --strict --noEmit`) against:

- `hl7.fhir.r4.core#4.0.1` — 191/191 resource StructureDefinitions resolve
- `hl7.fhir.us.core#6.1.0` — 49/49 resource profiles resolve, including all
  15 that previously failed on multi-level base chains
- `hl7.fhir.r5.core#5.0.0` — R5 is supported: 225 documents resolve, and a
  generated R5 `Patient` schema correctly accepts a conformant resource and
  rejects an invalid `gender`, verified at runtime
- `hl7.fhir.uv.sdc#3.0.0` (Structured Data Capture — questionnaire-heavy)
- `hl7.fhir.uv.smart-app-launch#2.1.0` (mostly non-resource content)
- `hl7.fhir.uv.genomics-reporting#2.0.0`
- `hl7.fhir.us.mcode#3.0.0` (oncology, heavy extension usage)
- `kbv.ita.erp#1.4.4` — a non-HL7, national (German e-prescription) IG from
  a different publisher and registry namespace entirely
- The **Da Vinci prior-authorization family**, all three of which generate
  and compile as a set: `hl7.fhir.us.davinci-crd#2.0.1` (51 files, Coverage
  Requirements Discovery), `hl7.fhir.us.davinci-dtr#2.0.1` (45 files,
  Documentation Templates and Rules) and `hl7.fhir.us.davinci-pas#2.2.1`
  (64 files, Prior Authorization Support). PAS is the heaviest dependency
  graph we've run — 13 direct dependencies including three different US Core
  versions side by side — and until recently it produced **nothing at all**:
  one dependency pinned to a version its registry never published aborted
  the whole run. A dependency that can't be fetched is now a warning naming
  the package and what it cost, not a failed run.

Across all of these: zero crashes, zero compile failures, and no filename
collisions (generated file count always matched files actually written to
disk). Warnings remain within known, tracked gaps (slicing,
unresolvable-type fallbacks) — exact counts aren't cited here since
they shift as those gaps close; check `-v` output against a given commit if
you need a number.

### Against real example resources

Compiling isn't the same as being *right*, so the generated schemas are also
run against the conformance-tested example resources four of these packages
ship in their own `package/example/` directory — the closest thing to ground
truth available offline. `src/validation/examples.test.ts` gates on the
result and ratchets in both directions: a new failure fails the build, and
so does a known failure that starts passing without being removed from the
list.

**All 441 matched examples validate**, with no documented exceptions
outstanding. Bundles and resources with no resolvable profile are excluded
rather than counted as passes.

## What it generates

Real output for R4 `Patient`, abridged — complex types are cross-file
imports, not inlined copies, so a `HumanName` is the same schema everywhere
it appears:

```ts
// AUTO-GENERATED by fhir-zod-gen — do not edit by hand.
// Source: http://hl7.org/fhir/StructureDefinition/Patient
// Kind: resource, base: http://hl7.org/fhir/StructureDefinition/DomainResource
import { z } from "zod";
import { HumanNameSchema } from "./HumanName.js";
import { IdentifierSchema } from "./Identifier.js";
// ...Address, Attachment, CodeableConcept, ContactPoint, Extension, Meta, ...

export const PatientSchema = z.object({
  "identifier": z.array(IdentifierSchema).optional(),
  "active": z.boolean().optional(),
  "name": z.array(HumanNameSchema).optional(),
  "gender": z.enum(["male", "female", "other", "unknown"]).optional(),
  "birthDate": z.string().regex(/^(?:([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?)$/).optional(),
  // value[x] arrives flattened into its real variants, with a .superRefine()
  // below enforcing that at most one of them is set:
  "deceasedBoolean": z.boolean().optional(),
  "deceasedDateTime": z.string().regex(/* ... */).optional(),
  "contact": z.array(z.object({
    "name": HumanNameSchema.optional(),
    // ...
  })).optional(),
});

export type Patient = z.infer<typeof PatientSchema>;
```

One file per profile plus one per shared datatype, and a barrel `index.ts`.
Because a field's type lives in a sibling file, **generated output has to be
type-checked as a set** — `tsc --noEmit` on a single file proves nothing.

Mapping rules, briefly:

| FHIR Schema | Zod |
|---|---|
| name listed in the **parent's** `required` array | field is not `.optional()` |
| `array: true` | wrapped in `z.array(...)`, with `.min()`/`.max()` from cardinality |
| nested `elements` (backbone/complex types) | recursive `z.object({...})` |
| a complex-typed field | a cross-file import of that type's own generated schema — `z.lazy(() => ...)` where the reference is a genuine cycle (e.g. `Identifier` <-> `Reference`) |
| a type that genuinely can't be resolved (no SchemaSource entry, e.g. `Extension`) | `z.unknown()` + a visible `/* TODO */` — never a dangling reference |
| `binding.strength` extensible/preferred/example | left as `z.string()` — FHIR permits out-of-valueset values at those strengths, so an enum would reject conformant data |
| `binding.strength` required, ValueSet expandable | `z.enum([...])`. If it can't be fully expanded: `z.string()` + a warning, **never** a partial enum — that would reject valid codes |
| a primitive with a real FHIR regex (`id`, `code`, `date`, ...) | `.regex(/^(?:...)$/)`, read from the package rather than hardcoded. `uri`/`url`/`canonical`/`string` are deliberately excluded — their patterns are near-vacuous, and FHIR's uri grammar is broader than WHATWG URL |
| `value[x]` choice types | flattened into `valueQuantity`, `valueString`, ... plus a `.superRefine()` enforcing that the group is 0..1 (or exactly 1 when required) — not each variant independently |
| slicing | the array keeps its unsliced element type, and a `.superRefine()` counts deep-matches per named slice. Not `z.discriminatedUnion` — see [what's enforced](#whats-enforced-and-what-isnt) |
| a datatype narrowed at one use site (e.g. vital-signs' `valueQuantity`) | the shared datatype file stays permissive; the narrowing is re-applied at that field with a `.superRefine()` |
| a primitive carrying `id`/`extension` | a `_<field>` sibling key beside the value, which is where FHIR actually serializes it |
| `constraint` (FHIRPath invariants) | the `A.exists() or B.exists()` shape is enforced at runtime; every other shape stays a `/* TODO(invariant ...) */` comment so you know it exists |

## What's enforced, and what isn't

The most useful thing to know before adopting this is where the line sits.
Everything below is a deliberate decision with a reason, not a list of
oversights — and the whole set errs in one direction on purpose: **it will
sometimes accept data a profile would reject, and it is designed never to
reject data a profile permits.** A false rejection breaks a working
integration; a missed constraint is a gap you can layer on top of.

**Enforced at runtime**

- Field presence and cardinality, including `.min()`/`.max()` on arrays.
- Required-strength ValueSet bindings, as `z.enum`.
- FHIR's real regex patterns on primitives that carry signal.
- `value[x]` mutual exclusivity across the whole choice group.
- Slice cardinality — "this array has at least one member matching X".
- A profile's datatype narrowing, at the field that states it.
- FHIRPath invariants of the `A.exists() or B.exists()` shape — 63 of the
  158 invariant markers in US Core's output, the largest single group.

**Deliberately not enforced**

- **Most FHIRPath invariants.** Anything involving `resolve()`, `%resource`,
  `htmlChecks()`, type tests or arithmetic needs a FHIRPath interpreter at
  runtime, which every generated file would then depend on. They stay
  visible as `/* TODO(invariant ...) */` comments.
- **`severity: "warning"` invariants**, even translatable ones. FHIR means
  those as advice; enforcing one would reject data the profile itself
  considers conformant.
- **Slicing beyond cardinality** — `rules: "closed"`, `ordered`/`openAtEnd`,
  and a slice member's own narrower schema. `z.discriminatedUnion` is the
  intuitive fit here and is the wrong tool: `rules` is `open` throughout
  real IGs, so members matching no slice are legal, and a closed union would
  reject them. The full reasoning is in
  [`docs/design/slicing-design.md`](./docs/design/slicing-design.md).
- **Slices discriminated by binding or profile** (29 of them across seven
  packages) — there is no honest deep-match pattern to synthesize, and
  guessing one would reject conformant data.
- **Terminology-server-backed bindings** — checking a code against a live,
  large value set needs a real terminology service in any language.
- **Extensions' inner structure** — objects aren't strict, so unmodelled
  extensions are accepted rather than rejected.

Where something can't be resolved at all, the generated file says so out
loud — `z.unknown()` with a visible marker, never a dangling reference to a
schema that doesn't exist.

## Roadmap

Rough priority order — PRs and issues on any of these are very welcome:

1. **More FHIRPath invariant shapes.** `A.empty() or B.empty()` and
   `(A.exists() and B.exists()).not()` are the plausible next two. Count the
   emitted markers before building: the `field.matches('...')` family looks
   like the obvious next win and is 35 distinct rules for **zero** emitted
   markers in US Core.
2. **Opt-in `fhirpath.js` evaluation** for the invariants a hand-written
   translator can't reach — as an `EmitOptions` flag, so consumers who want
   them take the dependency and nobody else pays.
3. **Per-site constraints beyond requiredness.** A profile can narrow a
   datatype's bindings and patterns at a use site, not just which fields are
   required; only requiredness is re-applied today.
4. **`zod-to-json-schema` interop test suite** — confirm round-tripping
   generated schemas into JSON Schema for tool-calling contexts (see below)
   doesn't lose required/enum information.

## A note for AI agent builders

If you're building agents or tool-calling integrations that read or write
FHIR data, see [`docs/WRITEUP.md`](./docs/WRITEUP.md#why-this-matters-more-than-usual-right-now-ai-agents) —
it goes into why this shape of schema is specifically useful there
(tool-calling parameter schemas doubling as runtime guardrails on model
output), not just for traditional app validation.

## Contributing

This is a fresh project — no CI-gated conventions yet, just: open an issue
before a big PR, add a test alongside any mapping-rule change, and keep the
generated output readable (it's meant to be read, not just executed).

## License

MIT
