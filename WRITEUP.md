# fhir-zod-gen: bringing FHIR's validation story to TypeScript

## The problem, for people who don't live in healthcare IT

Healthcare software exchanges data using a standard called **FHIR**
(pronounced "fire" — Fast Healthcare Interoperability Resources). It defines
things like what a `Patient` record or a `MedicationRequest` looks like as
JSON, so that a hospital's system, an insurer's system, and a patient's
app can all understand the same data without custom one-off integrations
between every pair of systems.

But "what a Patient record looks like" isn't fixed — FHIR is a base
specification that gets *narrowed* for specific purposes via documents
called **Implementation Guides (IGs)**. US Core defines what a Patient
record has to contain to be usable in the US. A specific insurer's prior
authorization IG might additionally require a procedure code and a
diagnosis on certain requests. Each IG is, in effect, a stricter contract
layered on top of the base standard.

Enforcing that contract in code is the unglamorous, essential part of any
FHIR integration: reject the malformed request before it reaches a
clinician, a claims system, or a database — not after.

## How this is solved in Java today

The Java ecosystem has a genuinely nice answer to this: the official [HL7
FHIR Validator](https://github.com/hapifhir/org.hl7.fhir.core) can be handed
any IG's package and will validate a resource against it — cardinality,
required fields, coded-value constraints, cross-field rules — without you
writing or generating any custom code for that IG. Point it at the package,
point it at your data, get a pass/fail plus a detailed error report. This is
the reference implementation FHIR test suites and CI pipelines lean on
worldwide.

TypeScript and JavaScript — despite running an enormous share of the web
apps, backend services, and (increasingly) AI agents that touch healthcare
data — don't have a direct equivalent. There are generated TypeScript
*types* for FHIR (compile-time only, gone at runtime), and a couple of
runtime validation libraries for the base spec, but nothing that takes an
arbitrary IG and produces both a runtime validator and TypeScript types
together, the way the Java tooling does for validation alone.

## What this project does

`fhir-zod-gen` generates [Zod](https://zod.dev) schemas from FHIR
Implementation Guides. Zod is a popular TypeScript validation library with a
property that makes it a particularly good fit here: **one Zod schema is
simultaneously a runtime validator and the source of a static TypeScript
type.** You don't maintain a type and a validator separately and hope they
don't drift — there's one declaration.

So for a given IG profile, this tool produces a file like:

```ts
export const PatientSchema = z.object({
  active: z.boolean().optional(),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  name: z.array(z.object({
    family: z.string().optional(),
    given: z.array(z.string()).optional(),
  })).optional(),
  // ...
});

export type Patient = z.infer<typeof PatientSchema>;
```

`PatientSchema.safeParse(someJson)` tells you, at runtime, whether a payload
actually conforms — including giving you a precise error if, say, `gender`
contains a value outside FHIR's fixed code list. And `Patient` is a real
TypeScript type your editor understands, generated from the exact same
source, for free.

Rather than parsing FHIR's raw specification format directly (which is
technically complete but a genuinely difficult tree to walk correctly — it
mixes cardinality, typing, and slicing across a flat list keyed by
dotted paths), this tool builds on **FHIR Schema**, a simplified
intermediate format an existing community project maintains specifically to
make this kind of cross-language codegen easier. That project already
ships a Python equivalent (StructureDefinitions → Pydantic models); this is
the TypeScript branch of the same idea.

## Why this matters more than usual right now: AI agents

A lot of AI agent tooling is written in TypeScript — Vercel's AI SDK,
LangChain.js, most Model Context Protocol (MCP) servers, and a large
fraction of the agent frameworks built on top of LLM tool-calling all live
in the Node/TS ecosystem. And Zod specifically has become something close
to a *lingua franca* for describing tool inputs and outputs to an LLM: many
of these frameworks accept a Zod schema directly as the definition of a
tool's parameters, and convert it under the hood into the JSON Schema that
the model actually sees when deciding how to call the tool.

That creates a direct, practical use for this project: if an agent has a
tool like "create a FHIR encounter" or "submit a prior authorization
request," the *same* generated Zod schema can do double duty —

- as the **tool-calling schema** the LLM is constrained against when it
  decides what arguments to produce, and
- as the **runtime guardrail** that validates whatever the model actually
  produces before it's sent anywhere real.

That second point matters more than it might sound like. LLMs are good at
producing JSON that *looks* like a FHIR resource — plausible field names,
sensible-looking values — without it necessarily being valid against the
specific profile a downstream system requires. A model might use `"M"`
instead of `"male"`, omit a field a specific IG has made mandatory even
though base FHIR makes it optional, or invent a coding system URI that
isn't quite right. Structural validation at the boundary — reject and
retry, rather than let malformed clinical data reach a real system — is a
completely ordinary safety practice, and generated-from-spec Zod schemas
make it close to free to apply.

None of this makes an agent *understand* FHIR or clinical medicine — that's
a separate, harder problem. What it does is make sure that when an agent
tries to speak FHIR, the sentences it constructs are at least
grammatically valid before anyone downstream has to deal with them.

## Current state and what's missing

This is a first pass, not a finished validator, and it's worth being
specific about the gap between what it does and what full FHIR conformance
checking requires:

- **Structural validation** (field presence, cardinality, nesting, fixed
  code lists on required-strength bindings) — implemented and tested.
- **FHIRPath invariants** (cross-field business rules — e.g. "if X is
  present, Y must also be present") — not evaluated yet. The generated
  code marks where they exist so nothing is silently dropped, but doesn't
  enforce them.
- **Terminology-server-backed bindings** (checking a code against a live,
  possibly large value set rather than a small closed list) — out of
  scope for a generated static schema; this needs a real terminology
  service regardless of language.
- **Slicing** (FHIR's mechanism for saying "this array has an item that
  must look like A and another that must look like B") — not implemented;
  Zod's discriminated unions are a promising fit, tracked as a roadmap item.

The honest framing: this covers the same "does the shape match the spec"
layer the Java validator's structural checks cover, in a form that's
native to the TypeScript ecosystem — not a full port of everything the
reference validator does.

## Get involved

The repository includes a working example (a simplified `Patient` profile,
generated and tested end-to-end) and a roadmap of the next pieces —
IG-package auto-fetching, FHIRPath invariant support, and slicing are the
top three. Issues and PRs welcome.
