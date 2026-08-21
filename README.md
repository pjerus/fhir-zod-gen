# fhir-zod-gen

Generate [Zod](https://zod.dev) schemas — runtime validators plus inferred TypeScript
types, in one artifact — from FHIR Implementation Guides.

> Status: **early / seeking contributors.** IG packages resolve and generate
> end-to-end, profiles merge over their base resources, and generated output is
> gated on compiling (`tsc --noEmit`) and on accepting/rejecting real conformant
> examples.
>
> Known gaps, tracked as issues: profiles whose base is *itself* a profile don't
> resolve yet ([#5](https://github.com/pjerus/fhir-zod-gen/issues/5) — about 30%
> of US Core), complex-typed fields fall back to `z.unknown()` pending cross-file
> imports and `z.lazy()` ([#6](https://github.com/pjerus/fhir-zod-gen/issues/6)),
> and choice types, slicing, and FHIRPath invariants are unimplemented. This is a
> starting point to build on, not a finished validator.

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
| a type that can't be resolved, or a cycle | `z.unknown()` + a visible `/* TODO */` — never a dangling reference ([#6](https://github.com/pjerus/fhir-zod-gen/issues/6)) |
| `binding.strength` extensible/preferred/example | left as `z.string()` — FHIR permits out-of-valueset values at those strengths, so an enum would reject conformant data |
| `constraint` (FHIRPath invariants) | **not evaluated** — emitted as a `/* TODO(invariant ...) */` comment so you know it exists |

## Roadmap

Rough priority order — PRs and issues on any of these are very welcome:

1. **FHIRPath invariants as `.refine()`** — wire up
   [fhirpath.js](https://github.com/HL7/fhirpath.js) so `constraint`
   expressions actually get evaluated, not just commented.
2. **Slicing → `z.discriminatedUnion`** — FHIR slices map naturally onto
   Zod's discriminated unions; not yet implemented.
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
