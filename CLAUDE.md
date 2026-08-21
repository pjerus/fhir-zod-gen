# CLAUDE.md

## What this is

`fhir-zod-gen` — a CLI + library that reads [FHIR Schema](https://github.com/fhir-schema/fhir-schema)
JSON and emits `.ts` files containing a Zod schema plus its type, one file per
profile plus a barrel `index.ts`.

It does **not** parse raw FHIR `StructureDefinition` snapshots. FHIR Schema is the
deliberate intermediate format; that decision is load-bearing.

**Read `docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md` before changing
anything.** It is the contract: the verified defect table, the architecture, and
the per-phase decisions with their evidence.

Repo: `github.com/pjerus/fhir-zod-gen` (private). Work happens on branches with
PRs, never directly on `main`.

## Commands

```bash
npm install
npm run lint         # eslint 9 flat config
npm run build        # tsc -> dist/
npm test             # vitest run
npm run dev -- ./fixtures/uscore-patient.fhirschema.json -o ./generated
npx tsx scripts/build-fixtures.ts    # regenerate fixtures from real IG packages
```

CI runs lint + build + test on Node 20.

## Architecture

Four layers. **Only the outer two touch the outside world.**

```
resolve/  (I/O)   fetch IG package, translate() StructureDefinitions
   ↓              → FhirSchemaDocument[]
merge/   (pure)   profile-over-base resolution, cycle detection
   ↓              → ResolvedSchema (concrete type/array/min/max everywhere)
emit/    (pure)   → TypeScript source text   ← THE ADOPTABLE PART
   ↓
write/   (I/O)    files, barrel index
```

`emit/` must stay a pure `(ResolvedSchema) => string` with no I/O. The project's
positioning goal is that another codegen project (notably `@atomic-ehr/codegen`,
which emits TS but deliberately ships no runtime validation) can adopt the
emitter without inheriting our CLI, registry client, or file layout. Keep the
seam clean.

`src/mapper.ts` is now a thin backward-compat shim over `merge/` + `emit/`. New
work goes in `emit/`.

## The history that matters

v0.1 was written against an **imagined** FHIR Schema format. Its tests passed
because a hand-written mapper was asserted against a hand-authored fixture
sharing the same wrong assumptions — a closed loop that validated nothing. Run
against real converted US Core Patient, it produced 25 fields, 23 of them
`.optional()`, and output that didn't compile.

Six defects came out of that (spec section 1). Consequences for how you work here:

- **`fixtures/` is ground truth** — real `@atomic-ehr/fhirschema` `translate()`
  output, reproducible via `scripts/build-fixtures.ts`. Never hand-edit a
  fixture. If you need a field the fixtures don't exercise, add a fixture rather
  than trusting the docs.
- **Where the FHIR Schema docs and the converter disagree, the converter wins.**
  Known case: docs say `constraints`, the converter emits `constraint` as an
  id-keyed object.
- **Never test the generator against a hand-authored input you also designed the
  types from.** That is precisely how v0.1 stayed green while being wrong.

## `defects.test.ts` and the `it.fails()` ratchet

Each verified defect has a test asserting the **correct** behavior, wrapped in
vitest's `it.fails()` while still broken. When a phase fixes a defect, it flips
that test to a plain `it()`.

If `it.fails()` ever starts passing without being flipped, vitest reports that as
a failure — which is the point. Don't delete or weaken an assertion to make a
flip work; if the assertion has become the wrong question (it happened once, for
defect 5), say so explicitly rather than quietly narrowing it.

## Conformance rules that look like bugs but aren't

Read the comment before "fixing" any of these:

- **Only `binding.strength === "required"` becomes `z.enum`.** Extensible,
  preferred, and example bindings stay `z.string()` — FHIR permits values outside
  the value set at those strengths, so an enum rejects conformant data.
- **A required binding that can't be fully expanded degrades to `z.string()` +
  a warning.** Never a partial enum: it rejects valid codes, which is worse than
  not narrowing.
- **`uri`/`url`/`canonical` are plain `z.string()`, never `.url()`.** FHIR's uri
  grammar is broader than WHATWG URL. (`@solarahealth/fhir-r4` ships this bug.)
- **Requiredness comes from the PARENT's `required` array**, never an element's
  own — its own array lists its *children*. Conflating the two is defect 6.
- **FHIRPath invariants are emitted as `/* TODO(invariant …) */` comments**, not
  evaluated. Evaluating needs fhirpath.js at runtime.
- **Unresolvable types degrade to `z.unknown()` with a visible TODO marker**, not
  a dangling `XSchema` reference. A loud gap beats a silent one.

## Emitted-output conventions

- **Zod 3/4 agnostic.** Only APIs identical in both. No `z.strictObject`
  (v4-only). Consumers shouldn't have to pick a Zod major to use our output.
- **Not strict objects** — FHIR permits extensions.
- **Deterministic** — identical input must produce byte-identical output.
- **Readability is a requirement.** The generated file is meant to be read in a
  repo and in autocomplete, not just executed.

## Source conventions

- ESM, `moduleResolution: NodeNext` — relative imports carry `.js` extensions,
  including in `.ts` source.
- `strict: true`. No `any` in `merge/` or `emit/`.
- Tests colocated as `*.test.ts`, offline and fast. No network in the suite.
- `vitest.config.ts` excludes `.claude/**` — agent worktrees nest a full copy of
  `src/` inside this directory and would otherwise be collected.

## Working with agents here

- **Never run concurrent agents in the primary checkout
  (`/Users/pat/ai-dev/fhir-zod`).** Give every concurrent agent its own worktree
  *outside* this directory. This caused two real incidents: a commit intended for
  `main` landed on an agent's branch (the branch had been checked out underneath
  it), and separately an agent's commit landed on `main` when something else
  checked `main` out mid-task. Both were silent. One agent then reset `main` to
  recover, losing its own commit as collateral.
- **A `git push` is not proof.** `git push origin main` while HEAD is on another
  branch pushes an unchanged `main` and exits 0. Verify with
  `git log origin/<branch>` or `git branch -r --contains <sha>` before claiming
  anything landed. An `echo pushed` after `git push -q` proves nothing.
- Never `git add -A` while a worktree exists under `.claude/` — it commits the
  worktree as an embedded repo. Use explicit paths.
- Dispatched agents get explicit file ownership when running in parallel, push a
  branch, and open a PR immediately (the PR is a hard reference that keeps later
  commits scoped). Plain commit messages, no `Co-Authored-By` trailer.
- Verify agent claims rather than trusting them. What this has actually caught:
  fixtures confirmed byte-identical to an independent conversion; `it.fails()`
  tests confirmed non-vacuous by unwrapping them; a terminology wiring fix
  confirmed by severing the wire and watching the test fail; and slicing
  statistics that were right for the pipeline but wrong for the reason given.
- **Run the real CLI against a real package before believing a change works.**
  `node dist/cli.js hl7.fhir.r4.core#4.0.1 -o /tmp/out` (cached, offline, fast),
  then compile the whole output directory *together* — cross-file imports mean
  per-file compilation proves nothing. This end-to-end check has caught bugs the
  unit suite missed every single time it was run: invalid identifiers, silent
  filename collisions, and circular-import initialization order.

## Open gaps

Tracked as GitHub issues. The big ones:

- **#5 — multi-level profile chains.** `merge/` throws when a profile's base is
  itself a profile. `us-core-blood-pressure → us-core-vital-signs → vitalsigns →
  Observation` is four levels, so that fixture can't be processed at all. Common
  in real IGs; highest-priority correctness gap.
- **#6 — cross-file imports + `z.lazy()` for cycles.** Complex-typed fields
  currently accept anything.
- **#3 — cardinality narrowing** isn't enforced on merge.

Choice-type mutual exclusivity and slicing are also unimplemented; see the spec's
Phase 3 section.
