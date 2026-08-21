# fhir-zod-gen — correctness rebuild design

**Date:** 2026-08-21
**Status:** approved (design shape); implementation in progress
**Scope:** Take fhir-zod-gen from a v0.1 skeleton that produces silently-wrong
output into a generator that emits correct Zod schemas for real FHIR
Implementation Guides.

---

## 1. The problem

The v0.1 generator was written against an *imagined* FHIR Schema format, not the
real one. Its tests pass because they assert a hand-written mapper against a
hand-authored fixture that shares the same wrong assumptions — a closed loop that
validates nothing.

This was verified directly, not inferred. Method:

```bash
curl -sL -o uscore.tgz "https://packages2.fhir.org/packages/hl7.fhir.us.core/6.1.0"
tar -xzf uscore.tgz
npm install @atomic-ehr/fhirschema   # v0.0.14
node -e "translate(StructureDefinition-us-core-patient.json)"
```

Running the existing `generateSchemaFile()` against that real converted output
produced **25 fields, 23 of them `.optional()`, 18 warnings, and a dangling
`ExtensionSchema` reference that does not compile.**

### Verified defects

| # | Defect | Evidence from real output | Consequence |
|---|---|---|---|
| 1 | `required` is an array of child element names, not a per-element boolean | `required: ["gender","identifier","name"]`; 3/3 occurrences are arrays, 0 booleans | `mapper.ts:98` reads `el.required` as boolean → never truthy → `name`/`gender` emit `.optional()` despite being required |
| 2 | `binding.codes` does not exist in real output | `gender.binding` = `{strength:"required", valueSet:"…/administrative-gender"}` — no `codes` | `z.enum` generation never fires. Enums require ValueSet expansion from the package |
| 3 | `constraint` is an object keyed by constraint id, not an array | `{k:"constraint", t:"object"}` | `el.constraint?.length` is `undefined` → invariant TODO markers never emit |
| 4 | Profile elements carry no `type`/`array`/`min`/`max` | `elements.name` = `{array:null, type:null, min:null, max:null}` | Everything becomes `z.unknown()`; `name` loses `array:true` |
| 5 | No base or cross-file resolution | `ExtensionSchema` referenced but never generated | Output does not compile |

**Defect #4 is architectural.** A profile (`derivation: "constraint"`) only
restates what it *narrows*. Types and cardinality live in the **base** resource.
Generating US Core Patient correctly requires loading base R4 Patient's FHIR
Schema and merging the profile over it. The current generator has no concept of a
base at all.

### Dead code confirming the diagnosis

- `FhirSchemaDocument.required?: string[]` — declared, never read. The author
  half-knew the real shape.
- `GenContext.knownTypes` — initialized empty, never written or read.
- `choices` — never read; `choiceOf` elements are `continue`d past, so choice
  types are silently dropped.

---

## 2. Positioning constraint

The project stays independently owned, but should be **useful to other codegen
projects** — specifically `@atomic-ehr/codegen` (Health Samurai), which is
actively developed, emits TypeScript, and deliberately ships *no runtime
validation*. That is the gap this fills.

Design consequence: **the mapping layer must be a pure `(FhirSchema) => string`
library with no I/O.** Package fetching, file writing, and CLI argument handling
live strictly outside it, behind a narrow documented adapter seam. Another
project must be able to adopt the emitter without inheriting our CLI, our
registry client, or our file layout.

This is also the right shape for testing: the emitter is tested against committed
fixtures with no network.

### Prior art (do not reinvent)

- **`@atomic-ehr/codegen`** — live Health Samurai generator (TS, Python/Pydantic,
  C#). No Zod anywhere. This is the adoption target.
- **`@solarahealth/fhir-r4`** — the closest existing thing: FHIR R4 + Zod, but
  from a bespoke non-FHIR-Schema pipeline, last published ~1 year ago. Its
  generated `Patient`/`Observation` **must be read before Phase 3** — they have
  already made choice-type and slicing decisions worth stealing or explicitly
  rejecting.
- **`zod-fhir`** — abandoned toy, 3 commits, broken on recursive types. Ignore.

Nobody ships a maintained **FHIR Schema → Zod** generator. That is the gap.

### Rejected: fhir.schema.org

Investigated and rejected. `fhir.schema.org` is **NXDOMAIN** — the hostname does
not resolve. It originated as a 2016 SWAT4LS *poster* (Mayo/W3C) explicitly
framed by its authors as a discussion-starter. Its only implementation,
`crDDI/fhir_to_sdo`, has 6 commits, all April–May 2016. The hosting URL cited in
the paper 404s.

The live successor, `health-lifesci.schema.org`, is a separate lineage (ScheMed
community group), never mentions FHIR, and is a shallow page-annotation
vocabulary with no `Patient` type, no `Observation` equivalent, and nothing for
`Reference`, `CodeableConcept`, or `Bundle`. Any mapping would be invented by us,
systematically lossy, with no upstream authority to defer to.

**Not a build target.** If a JSON-LD story is wanted later it is a separate,
weaker project.

---

## 3. Architecture

```
                    ┌─────────────────────────────────────┐
   IG package  ───► │  resolve/  (I/O — network, tarballs) │
   e.g.             │  fhir-package-installer              │
   us.core#6.1.0    │  @atomic-ehr/fhirschema translate()  │
                    └──────────────┬──────────────────────┘
                                   │  FhirSchemaDocument[]
                    ┌──────────────▼──────────────────────┐
                    │  merge/   (pure)                     │
                    │  profile-over-base resolution        │
                    └──────────────┬──────────────────────┘
                                   │  ResolvedSchema
                    ┌──────────────▼──────────────────────┐
                    │  emit/    (pure — THE ADOPTABLE PART)│
                    │  (ResolvedSchema) => string          │
                    └──────────────┬──────────────────────┘
                                   │  TypeScript source
                    ┌──────────────▼──────────────────────┐
                    │  write/   (I/O — files, barrel index)│
                    └─────────────────────────────────────┘
```

Only `resolve/` and `write/` touch the outside world. `merge/` and `emit/` are
pure and fixture-tested.

### Module responsibilities

- **`resolve/`** — fetch an IG package, convert StructureDefinitions to FHIR
  Schema, provide a `SchemaSource` lookup interface (`getByUrl`, `getByType`).
  Depends on: `fhir-package-installer`, `@atomic-ehr/fhirschema`.
- **`merge/`** — given a profile and a `SchemaSource`, walk to the base chain and
  produce a fully-populated `ResolvedSchema` where every element has concrete
  `type`, `array`, `min`, `max`. No network.
- **`emit/`** — `ResolvedSchema` → TypeScript source text. No I/O, no lookups
  beyond what `ResolvedSchema` carries.
- **`write/`** — file output, barrel index generation.

---

## 4. Phases

Each phase is one reviewable PR. Phases 0–2 are strictly sequential — each is the
next one's contract.

### Phase 0 — Foundation ✅ complete
`git init`, private GitHub remote, `npm install`, fix the broken `lint` script
(eslint was declared but never installed; `--ext` removed in eslint 9+), wire
lint into CI, drop duplicate root `WRITEUP.md`, gitignore stray zips.

### Phase 1 — Ground truth (sequential, reviewed hardest)
Commit real converted fixtures under `fixtures/`:
- `r4-patient.fhirschema.json` (base, from `hl7.fhir.r4.core#4.0.1`)
- `uscore-patient.fhirschema.json` (profile with extensions)
- `uscore-blood-pressure.fhirschema.json` (slicing + choice types)
- `valuesets/` — the `ValueSet-*.json` / `CodeSystem-*.json` needed to expand the
  `required` bindings those three profiles use (e.g. `administrative-gender`),
  plus a conformant `Patient` example from the package's own `example/` dir

Committing the ValueSets here is what keeps Phase 3 offline: enum generation
needs expansion, and expansion must not require a network call in tests.

Include the conversion script that produced them (`scripts/build-fixtures.ts`) so
they are reproducible, not magic.

Rewrite `src/fhir-schema-types.ts` against ground truth. Add tests that **fail**
against current `mapper.ts`, one per verified defect above. Those failing tests
are the deliverable — they encode the contract.

**Gate:** the new types must be derived from the committed fixtures, not from
docs. Where the docs and the converter disagree (docs say `constraints`, the
converter emits `constraint`), the converter wins and the discrepancy gets a
comment.

### Phase 2 — Base resolution + merge (sequential, single agent)
Implement `merge/`. Profile-over-base element merging, base chain walking,
cross-file type references. This is where FHIR codegen usually goes wrong;
it is deliberately not parallelized.

**Gate:** US Core Patient must resolve to concrete types with `name.array === true`
and zero `z.unknown()`.

### Phase 3 — Mapper correctness (parallelizable)
Fix defects 1/2/3 and implement choice types, cardinality, slicing. Read
`@solarahealth/fhir-r4`'s generated output first.

Slicing maps to Zod as:
- `value`-type discriminator on a literal field → `z.discriminatedUnion`
- `pattern`-type discriminator (e.g. blood pressure `code`) → `z.union` +
  `.superRefine`, since there is no single literal key
- **extension slicing** (match by URL, `match: {}` in output) → its own path.
  This is the most common case in US Core and must not go through the generic
  discriminator path.

ValueSet expansion for `required` bindings reads `ValueSet-*.json` and
`CodeSystem-*.json` from the package. Where a ValueSet cannot be expanded
locally, emit `z.string()` and warn — never a partial enum, which would reject
conformant data.

### Phase 4 — IG package pipeline (independent of Phase 3)
`resolve/` implementation. CLI accepts `hl7.fhir.us.core#6.1.0`.

Registry facts (verified):
- `GET https://packages2.fhir.org/packages/{id}/{version}` → 302 → tarball
- `GET https://packages.fhir.org/{id}/{version}` → **404**, do not use
- Tarball layout: `package/StructureDefinition-*.json`, `package/.index.json`
  (use the index rather than scanning every file)

Prefer `fhir-package-installer` over hand-rolled registry HTTP.

---

## 5. Testing strategy

- **Fixture-based, offline, fast.** Every mapping rule is tested against committed
  real converted output. No network in the test suite.
- **Regression gate:** generated output for all three fixtures must compile under
  `tsc --noEmit`. A schema that does not compile is a failed test, not a warning.
- **Semantic gate:** generated `USCorePatient` must *reject* a Patient missing
  `name`, and *accept* a conformant US Core Patient example from the package's
  own `example/` directory. This is the test that would have caught every defect
  above.
- Any mapping-rule change ships with a test alongside it.

---

## 6. Conventions

- ESM, `moduleResolution: NodeNext` — relative imports carry `.js` extensions.
- `strict: true`, no `any` in `merge/` or `emit/`.
- Generated output is meant to be **read** — readability of emitted source is a
  requirement, not a nicety.
- Agents: worktree isolation, branch + PR per phase, incremental commits, plain
  commit messages with no `Co-Authored-By` trailer.
