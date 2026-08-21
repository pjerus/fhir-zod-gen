# CLAUDE.md

## What this is

`fhir-zod-gen` — a CLI + library that reads [FHIR Schema](https://github.com/fhir-schema/fhir-schema)
JSON documents and emits `.ts` files containing a Zod schema plus its inferred type,
one file per profile plus a barrel `index.ts`.

It does **not** parse raw FHIR `StructureDefinition` snapshots/differentials. FHIR Schema
is the deliberate intermediate format — that decision is load-bearing, don't "improve" it
by adding StructureDefinition walking.

Status is v0.1. See the Roadmap in `README.md` for what's intentionally missing
(IG package resolution, FHIRPath invariants, slicing, primitive regexes).

## Commands

```bash
npm install          # NOT yet run in this checkout — node_modules/ and dist/ are absent
npm run build        # tsc -> dist/
npm test             # vitest run
npm run dev -- ./examples/patient.fhirschema.json -o ./generated   # tsx, no build step
```

`npm run lint` is declared in `package.json` but **eslint is not in devDependencies** — it
will fail. Either add eslint or don't rely on that script.

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build && npm test` on Node 20.

## Layout

| File | Role |
|---|---|
| `src/fhir-schema-types.ts` | Hand-written subset typing of the FHIR Schema format. Deliberately incomplete — extend `FhirSchemaElement` when you need a field. |
| `src/mapper.ts` | The core. Maps one FHIR Schema doc → generated TypeScript **source text**. |
| `src/generate.ts` | Fans `mapper` over many docs, writes files + barrel index. |
| `src/cli.ts` | Arg parsing, file/dir loading. |
| `src/mapper.test.ts` | Colocated vitest tests, assert against generated source strings. |
| `generated/` | Checked-in sample output from `examples/patient.fhirschema.json`. Regenerate, don't hand-edit. |

`WRITEUP.md` at the root is a byte-identical duplicate of `docs/WRITEUP.md`; README links to
the `docs/` one.

## How the generator works

`mapper.ts` builds **strings**, not runtime Zod objects. Every function returns TypeScript
source text with explicit indentation threaded through as a parameter. When changing it,
the output must stay readable — the generated file is meant to be read in a repo and in
autocomplete, not just executed.

## Mapping rules that look like bugs but aren't

These are conformance decisions, documented in code comments. Don't "fix" them without
reading the comment first:

- **Only `binding.strength === "required"` with a resolved `codes` list becomes `z.enum`.**
  Extensible/preferred/example bindings stay `z.string()` — FHIR permits out-of-valueset
  values at those strengths, so an enum would reject conformant data.
- **`uri`/`url`/`canonical` map to plain `z.string()`, not `z.string().url()`.** FHIR uris
  are broader than WHATWG URLs.
- **`constraint` (FHIRPath invariants) are emitted as `/* TODO(invariant …) */` comments,
  never evaluated.** Evaluating them needs fhirpath.js at runtime; the comment is the
  deliberate visible-gap marker.
- **Date/time primitives are `z.string()`** — FHIR's date regexes are a v0.2 item.
- Unknown `type` values fall through to `` `${type}Schema` `` — i.e. an assumed reference to
  another generated schema in the same output dir. There is no cross-file resolution check.

## Known incomplete spots in `mapper.ts`

- `GenContext.knownTypes` is declared and threaded through but never populated or read.
- `objectSchemaBody` skips any element with `choiceOf` set (`continue`) and never emits the
  base `value[x]` entry — choice types are effectively dropped today.
- The `else if (el.binding && el.binding.strength !== "required")` branch is an intentional
  no-op left for readability.

## Conventions

- ESM (`"type": "module"`) with `moduleResolution: NodeNext` — **relative imports must carry
  the `.js` extension**, including in `.ts` source (`./mapper.js`, not `./mapper`).
- `strict: true`. `rootDir` is `src`, output `dist`.
- Tests live next to the code as `*.test.ts` and assert on generated source strings.
- Add a test alongside any mapping-rule change (per `README.md` contributing note).

## Environment note

This directory is **not a git repository** — no `git init` has been run, despite the
`.gitignore` and `.github/` present. Don't assume git commands will work.
