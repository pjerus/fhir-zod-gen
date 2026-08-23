# fhir-zod-gen and `pa-fhir-poc` — an FAQ

> **Status: forward-looking.** `pa-fhir-poc` does not use this tool today —
> it has no `zod` dependency at all and types FHIR through `@types/fhir`.
> This document answers "what would it look like if it did", and is written
> so the answers stay useful whether or not that integration ever happens.
> Nothing here should be read as describing a shipped integration.

`pa-fhir-poc` is a Da Vinci prior-authorization proof of concept: a Medicare
Local Coverage Determination (LCD) PDF goes in, an LLM extracts structured
criteria into a snapshot, a Temporal workflow blocks on human review, and the
approved graph is projected into FHIR artifacts — a CRD CDS Hooks card, a DTR
Questionnaire, and a PlanDefinition.

The question this FAQ exists to answer: **what does it take for those
projected artifacts to be validated by generated Zod schemas, and what would
still not be covered?**

---

## Do we need to author an Implementation Guide first?

**No.** That is the most common misconception about this tool, and the answer
is genuinely "you already have everything you need."

The Da Vinci IGs are already published by HL7 as npm-style FHIR packages. You
name one, and the CLI does the rest:

```bash
fhir-zod-gen hl7.fhir.us.davinci-dtr#2.0.1 -o ./src/generated/dtr
```

You would only author StructureDefinitions if the POC invented its *own*
profiles — say, an "LCD-derived Questionnaire" profile with constraints no
published IG states. It doesn't appear to today: it projects artifacts that
conform to published Da Vinci and SDC profiles, which is exactly the case
this tool is built for.

## How does a published profile actually become a Zod schema?

Four stages, only the outer two of which touch the outside world:

```
HL7 publishes davinci-dtr#2.0.1              StructureDefinitions, packaged
        │
        ▼  resolve/   (I/O)
download the package + its declared dependency closure → ~/.fhir/packages
        │
        ▼  translate()   (@atomic-ehr/fhirschema)
StructureDefinition → FHIR Schema            a simplified JSON form built for codegen
        │
        ▼  merge/   (pure)
resolve each profile over its base chain, narrowing cardinality
DTRStdQuestionnaire → Questionnaire → DomainResource → Resource
        │
        ▼  emit/   (pure)
one .ts per resource profile + one per shared datatype + a barrel index.ts
```

Two stages do more work than their names suggest.

**The dependency closure.** `davinci-dtr` states almost nothing on its own —
it says "a `Questionnaire`, but with these constraints." The base
`Questionnaire` lives in `hl7.fhir.r4.core`, so that has to come along or
nothing resolves. DTR 2.0.1 declares seven dependencies, including US Core
3.1.1 and SDC 3.0.0.

**The base chain.** Each layer states only its own *differential*. `merge/`
walks the chain and folds the layers together, so what reaches the emitter
has a concrete type, cardinality and requiredness on every field. A profile
can only tighten a base's cardinality, never silently widen it.

## What files would we actually get?

All three Da Vinci packages generate and compile as a set (verified
2026-08-23):

| package | files | the profiles you'd care about |
|---|---|---|
| `hl7.fhir.us.davinci-dtr#2.0.1` | 45 | `DTRStdQuestionnaire`, `DTRQuestionnaireResponse`, `DTRQuestionnairePackageBundle`, `DTRQuestionnaireAdapt`, plus the operation `Parameters` profiles |
| `hl7.fhir.us.davinci-crd#2.0.1` | 51 | `Coverage`, `DeviceRequest`, `ServiceRequest`, `MedicationRequest`, `Encounter`, `TaskQuestionnaire`, … |
| `hl7.fhir.us.davinci-pas#2.2.1` | 64 | `PASClaim`, `PASClaimResponse`, `PASRequestBundle`, `PASCoverage`, `PASBeneficiary`, … |

Each output directory is self-contained: one file per resource profile, one
per shared datatype (`CodeableConcept.ts`, `Reference.ts`, …), and a barrel
`index.ts` re-exporting everything.

### Name every package in one run

```bash
fhir-zod-gen hl7.fhir.us.davinci-dtr#2.0.1 \
             hl7.fhir.us.davinci-crd#2.0.1 \
             hl7.fhir.r4.core#4.0.1 \
             -o ./src/generated
```

One batch, one barrel: shared datatypes are reconciled across all three and
emitted once, so every profile references the same `CodeableConcept.ts`.
Verified — DTR + CRD together produce 60 files whose `index.ts` exports all 9
DTR profiles *and* CRD's, and the set compiles under `tsc --strict`.

**Running the tool once per package into the same directory is a different
thing, and is now refused.** The second run rewrites `index.ts` from its own
results, so the first run's files stay on disk while dropping out of the
barrel — anything importing from `index.ts` silently loses them. That used to
happen quietly (issue #50); it now fails with a message naming the orphaned
files, and exits non-zero.

Separate `-o` directories per package still work if you prefer them. The cost
is a duplicated copy of each shared datatype per directory, which is harmless
— they're independent modules — but you lose cross-package datatype
reconciliation, so prefer one run where you can.

Where two inputs disagree about the same canonical, the **leftmost wins**, so
the outcome is predictable from the command you ran rather than from
iteration order.

**`PlanDefinition` is not in CRD's output**, because CRD doesn't profile it.
The POC projects a plain R4 `PlanDefinition`, so that schema comes from
`hl7.fhir.r4.core#4.0.1` — which also supplies `Questionnaire`, `Library` and
`Bundle`. If the POC later conforms its PlanDefinition to CPG or CRMI, you'd
generate that IG instead and get the narrowed version.

## Where would the validation actually go?

The natural seam is the **FHIR projection stage** — the pure function from
reviewed graph to artifacts. Today its output goes to the HL7 validator; a
`safeParse` puts the same class of check in-process, milliseconds after the
object is built:

```ts
import { DTRStdQuestionnaireSchema } from "./generated/dtr/index.js";

const result = DTRStdQuestionnaireSchema.safeParse(projected);
if (!result.success) {
  // fails inside the projection activity, with a path to the offending field
  throw new Error(`Questionnaire projection is not conformant: ${JSON.stringify(result.error.issues)}`);
}
```

This does not replace the HL7 validator — it catches a large share of what
that validator would catch, without the round trip, and it fails at the point
where the bug was introduced rather than at the end of the pipeline. Keep
both: the validator remains the authority.

A second use is the *input* side. The LLM extraction stage is the only
non-deterministic thing in the pipeline, and its output is quarantined behind
a snapshot. A Zod schema is a natural gate on that boundary too — though for
the extraction shape you'd hand-write it, since that's your own structure and
not FHIR.

## What would this NOT cover?

Worth being blunt about, since it's the difference between "validated" and
"feels validated."

**1. A CDS Hooks card is not a FHIR resource.** The CRD card envelope —
`cards[].summary`, `indicator`, `suggestions[].actions[]` — is defined by the
CDS Hooks specification, not by a StructureDefinition, so no schema for it
comes out of this tool. The *resources inside* a suggestion's actions are
FHIR and are covered. If you want the envelope checked, that's a hand-written
Zod schema, and a small one — maybe 30 lines.

**2. Extension internals.** Only `kind: "resource"` documents become files;
extension definitions don't. Generated objects also aren't strict (FHIR
permits extensions everywhere), so an unmodelled extension is *accepted*
rather than rejected. This matters more for DTR than the others, since DTR
leans on SDC and CQF extensions heavily. You'd get "this Questionnaire is
structurally sound", not "this `sdc-questionnaire-launchContext` is
well-formed."

**3. Most FHIRPath invariants.** The `A.exists() or B.exists()` shape is
enforced; anything needing `resolve()`, `%resource` or type tests stays a
`/* TODO(invariant …) */` comment. See the README's
[What's enforced, and what isn't](../README.md#whats-enforced-and-what-isnt).

**4. Terminology-server-backed bindings.** A required binding whose ValueSet
expands becomes a `z.enum`. One that can't expand degrades to `z.string()`
with a warning — deliberately, since a partial enum would reject valid codes.
Checking a code against a live, large value set needs a terminology service
in any language.

The whole tool errs in one direction on purpose: **it may accept data a
profile would reject, and is designed never to reject data a profile
permits.** For a pipeline with a human approval gate in the middle, that's
the right failure mode — a false rejection would block a reviewed,
legitimately-approved artifact from being published.

## Why does `davinci-dtr` warn about `hl7.fhir.us.davinci-crd#current`?

Generating DTR prints this:

```
Skipping dependency hl7.fhir.us.davinci-crd#current: could not be downloaded
(… status 404 …). Required bindings and types that depend on it degrade …
```

It is not a bug in DTR, and not a bug here. DTR 2.0.1's own `package.json`
literally declares:

```json
"dependencies": { …, "hl7.fhir.us.davinci-crd": "current" }
```

`current` is not a version number. Per Grahame Grieve on the FHIR chat,
["the version 'current' is a reference to the version as published on
build.fhir.org"](https://chat-archive.fhir.org/stream/179252-IG-creation/topic/Dependency.20check.20and.20Publishing.html)
— that is, the latest continuous-integration build of the IG's main branch,
not a release. HL7's own IG-authoring guidance flags the term as ambiguous,
noting that ["current refers to either the last milestone or the ci-build, and
so it is ambiguous"](https://build.fhir.org/ig/FHIR/ig-guidance/versions.html).

The consequence is mechanical:

- The **release registry** (`packages.fhir.org`) serves published versions
  only. It has eleven versions of `davinci-crd` — `0.1.0` through `2.2.1` —
  and none of them is named `current`. Hence the 404.
- The **CI build server** does serve it, at
  `https://build.fhir.org/ig/HL7/davinci-crd/package.tgz`. As of 2026-08-23
  that build's manifest self-identifies as version **2.2.1** — a version the
  release registry does have.

So the artifact exists; it just lives on a different host with a different
URL scheme than the registry our installer knows about.

This is a known rough edge in the wider ecosystem, not something unique to
us. HL7's own `fhir-package-loader` shipped a fix in **2.1.2** described as
["downgrade the severity from error to warning when a `#current` dependency
can't be downloaded from the build server but already exists in the
cache"](https://github.com/FHIR/fhir-package-loader/releases) — i.e. the
reference tooling also concluded that a missing `#current` dependency should
degrade rather than abort. That is exactly what this tool does now.

**What it costs you in practice: measurably nothing, for DTR.** That is worth
stating precisely, because the obvious guess — "some bindings won't expand
and some types fall back to `z.unknown()`" — is wrong here, and was checked
rather than assumed:

- **No file in DTR's 45 references a CRD canonical at all.** DTR names CRD as
  a dependency but doesn't actually resolve anything through it.
- The four binding warnings DTR emits are `urn:ietf:bcp:13` (mime types) and
  `urn:iso:std:iso:4217` (ISO currencies), on `Attachment.contentType`,
  `Signature.sigFormat`/`targetFormat` and `Money.currency`. Those code
  systems have no enumerable content and fall back to `z.string()` in **every**
  package — nothing to do with CRD.
- The 11 `z.unknown()` markers are `Questionnaire.item` and its `value[x]` —
  the recursive item structure. The identical markers appear in US Core's
  `QuestionnaireResponse`, whose closure is complete.

Two further facts, both verified: `davinci-crd` **2.0.1 and 2.2.1 sitting in
the package cache does not satisfy the dependency**, because it is keyed
`#current` and neither is; and generating `davinci-crd` separately does not
change DTR's output, because DTR's resolution never reached for it.

So there is no workaround to apply, because there is nothing to work around.
If a future package genuinely needs a `#current` dependency's content, the
fix is a version-pinning flag — tracked in
[#48](https://github.com/pjerus/fhir-zod-gen/issues/48), which also records
why fetching CI builds directly is the wrong answer for a codegen tool whose
output gets committed.

The warning now says which kind of failure this is. It reports the dependency
before the download (marked `ci-build only` in the closure table), then
explains that a `#current` version cannot be resolved — rather than implying a
transient fetch failure — and that a cached copy of some other version won't
satisfy it either. Fixed in [#48](https://github.com/pjerus/fhir-zod-gen/issues/48).

If a future package genuinely needs a `#current` dependency's content, name a
published version as an extra input; since [#50](https://github.com/pjerus/fhir-zod-gen/issues/50)
both are generated as one batch and resolve against each other.

*Note: this behaviour is recent. Before the fix in issue #42, one unfetchable
dependency aborted the entire run — `davinci-pas` produced zero files for
exactly this reason, with a different package.*

## Does it need network access at runtime?

No. Generation is a build-time step; the generated `.ts` files are ordinary
source you commit. The only network access is the initial package download,
into the shared FHIR package cache (`~/.fhir/packages`, the same cache sushi,
the IG publisher and HAPI use). After that, runs are offline.

Output is deterministic — identical input produces byte-identical output — so
the generated directory can be committed and diffed in review, and CI can
assert it's up to date by regenerating and checking for a clean tree.

## What would we need to decide before doing this?

1. **Commit generated code, or generate in CI?** Committing makes diffs
   reviewable and removes a build dependency; generating keeps the repo small.
   The determinism guarantee makes either safe.
2. **Which packages.** DTR alone covers the Questionnaire artifacts; add
   `davinci-crd#2.0.1` if you want the CRD-side bindings to expand, and
   `r4.core` for the plain `PlanDefinition`.
3. **Whether to hand-write the CDS Hooks card envelope schema.** Small, and
   it closes the one gap that sits squarely in the POC's output path.
4. **Where failures surface.** Inside the projection activity is the obvious
   place — but note a Temporal activity that throws will retry, so a
   conformance failure should be a non-retryable failure, not a transient one.
