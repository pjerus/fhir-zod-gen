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
> Remaining gaps: FHIRPath invariants are emitted as `/* TODO */` comments, not
> evaluated; primitive regex constraints (`id`, `code`, etc.) aren't enforced
> yet. This is a starting point to build on, not a finished validator.

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

Given a FHIR Schema document for `Patient`, roughly:

```ts
export const PatientSchema = z.object({
  "resourceType": z.string(),
  "active": z.boolean().optional(),
  "name": z.array(z.object({
    "use": z.enum(["usual", "official", "temp", "nickname", "anonymous", "old", "maiden"]).optional(),
    "family": z.string().optional(),
    "given": z.array(z.string()).optional(),
  })).optional(),
  "gender": z.enum(["male", "female", "other", "unknown"]).optional(),
  "birthDate": z.string().optional(),
});

export type Patient = z.infer<typeof PatientSchema>;
```

Mapping rules, briefly:

| FHIR Schema | Zod |
|---|---|
| name listed in the **parent's** `required` array | field is not `.optional()` |
| `array: true` | wrapped in `z.array(...)`, with `.min()`/`.max()` from cardinality |
| nested `elements` (backbone/complex types) | recursive `z.object({...})` |
| a complex-typed field | a cross-file import of that type's own generated schema — `z.lazy(() => ...)` where the reference is a genuine cycle (e.g. `Identifier` <-> `Reference`) |
| a type that genuinely can't be resolved (no SchemaSource entry, e.g. `Extension`) | `z.unknown()` + a visible `/* TODO */` — never a dangling reference |
| `binding.strength` extensible/preferred/example | left as `z.string()` — FHIR permits out-of-valueset values at those strengths, so an enum would reject conformant data |
| `constraint` (FHIRPath invariants) | **not evaluated** — emitted as a `/* TODO(invariant ...) */` comment so you know it exists |

## Roadmap

Rough priority order — PRs and issues on any of these are very welcome:

1. **FHIRPath invariants as `.refine()`** — wire up
   [fhirpath.js](https://github.com/HL7/fhirpath.js) so `constraint`
   expressions actually get evaluated, not just commented.
2. **Slicing → `z.discriminatedUnion`** — FHIR slices map naturally onto
   Zod's discriminated unions; specced at
   [`docs/design/slicing-design.md`](./docs/design/slicing-design.md), not
   yet implemented.
3. **Primitive regex constraints** — FHIR's `id`, `code`, etc. have real
   regex patterns we're currently ignoring in favor of a plain `z.string()`.
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
