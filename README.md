# fhir-zod-gen

Generate [Zod](https://zod.dev) schemas — runtime validators plus inferred TypeScript
types, in one artifact — from FHIR Implementation Guides.

> Status: **v0.1, early / seeking contributors.** The core mapping (cardinality,
> nested elements, required bindings → enums, choice types) works and is tested.
> FHIRPath invariants, terminology-server-backed bindings, and slicing are not
> implemented yet — see [Roadmap](#roadmap). This is a starting point to build
> on, not a finished validator.

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

**Not yet supported:** pointing the CLI directly at an IG package name (e.g.
`hl7.fhir.us.core#6.1.0`) and having it resolve + fetch + convert
automatically. Today you need to bring your own FHIR Schema JSON (via the
FHIR Schema converter, or hand-authored for testing). Automating that
resolve-and-fetch step is the top item on the roadmap below.

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
| `min: 1` / `required: true` | field is not `.optional()` |
| `array: true` | wrapped in `z.array(...)`, with `.min()`/`.max()` from cardinality |
| nested `elements` (backbone/complex types) | recursive `z.object({...})` |
| `binding.strength === "required"` with resolved codes | `z.enum([...])` |
| `binding.strength` extensible/preferred/example | left as `z.string()` — FHIR permits out-of-valueset values at those strengths, so an enum would reject conformant data |
| `constraint` (FHIRPath invariants) | **not evaluated** — emitted as a `/* TODO(invariant ...) */` comment so you know it exists |

## Roadmap

Rough priority order — PRs and issues on any of these are very welcome:

1. **IG package resolution** — accept an IG package identifier directly,
   fetch it from the FHIR package registry, convert to FHIR Schema, generate.
2. **FHIRPath invariants as `.refine()`** — wire up
   [fhirpath.js](https://github.com/HL7/fhirpath.js) so `constraint`
   expressions actually get evaluated, not just commented.
3. **Slicing → `z.discriminatedUnion`** — FHIR slices map naturally onto
   Zod's discriminated unions; not yet implemented.
4. **Primitive regex constraints** — FHIR's `id`, `code`, etc. have real
   regex patterns we're currently ignoring in favor of a plain `z.string()`.
5. **`zod-to-json-schema` interop test suite** — confirm round-tripping
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
