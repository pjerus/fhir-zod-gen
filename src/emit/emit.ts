/**
 * Emit TypeScript source (a Zod schema + its inferred type) from a
 * ResolvedSchema. Pure: `(ResolvedSchema) => string`, no I/O, no lookups
 * beyond what ResolvedSchema already carries — this is "the adoptable part"
 * per docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md section 3.
 *
 * This replaces the pre-Phase-2 mapper.ts, which mapped a raw
 * FhirSchemaDocument (the *imagined* FHIR Schema format) straight to Zod
 * source with no base resolution. That produced defects 1/3/4/6 documented
 * in the design doc's section 1 — every one of them was "the emitter is
 * reading a field that either doesn't exist on real output, or exists but
 * means something different than assumed." Consuming ResolvedSchema instead
 * of FhirSchemaDocument fixes that at the type level: every ResolvedElement
 * already carries a concrete type/array/min/max and a correctly-derived
 * `required` (design doc defect 6 — from the PARENT's required list, never
 * the element's own), so this module's only job is turning already-correct
 * data into readable source text.
 *
 * Phase 3b update: defect 2 (ValueSet expansion -> z.enum) is now handled
 * here, via an optional injected terminology/TerminologySource (see
 * EmitOptions). A required-strength binding whose ValueSet successfully
 * expands emits z.enum([...]); everything else (no source configured,
 * extensible/preferred/example strength, expansion failure) stays
 * primitiveToZod(el.type) with a loud TODO marker — see elementToZod's
 * binding branch.
 *
 * Issue #6 update: complex-typed fields (ResolvedElement.isNamedType) are no
 * longer inlined. A field whose type is a reusable named datatype
 * (HumanName, Identifier, Reference, ...) emits a plain cross-file reference
 * — `IdentifierSchema`, imported from `./Identifier.js` — and that type gets
 * its own emitted file (strategy B from the PR description: one file per
 * complex datatype, over strategy A's "inline + local z.lazy per cycle").
 * BackboneElement structure (always profile-local, never a reusable type)
 * stays inlined exactly as before. A field the SchemaSource has no entry
 * for (e.g. "Extension" — see resolve.ts's module comment) still falls back
 * to z.unknown() with a loud TODO — that half of defect 5 (no SchemaSource
 * entry at all) is a different problem than this issue closes (a *known*
 * type with no real cross-file wiring).
 *
 * z.lazy() is reserved for genuine cycles — see collectNamedTypeRefs/
 * computeReachability/isCyclicEdge below. A field's own `ResolvedElement.
 * isCyclic` (set by merge/'s single-path cycle cut) is NOT used directly to
 * decide lazy-vs-plain here: a real mutual cycle between two files (e.g.
 * Identifier <-> Reference) needs *both* directions wrapped in z.lazy(), not
 * just the specific occurrence merge/ happened to cut, or a plain eager
 * cross-file reference on the other side can throw
 * "Cannot access 'XSchema' before initialization" at module load time
 * depending on which of the two circularly-importing files loads first —
 * confirmed empirically against Node's ESM loader before writing this.
 * `isCyclicEdge` recomputes cycle membership from the whole reference graph
 * so both directions of every genuine cycle agree, regardless of which side
 * merge/'s resolution order happened to cut.
 *
 * Choice types (`value[x]`, phase 3c): a group marker element
 * (ResolvedElement.choices set, e.g. "value" naming
 * ["valueQuantity","valueString",...]) is never emitted as its own key —
 * real FHIR JSON never serializes a literal "value" property, only its
 * variants. Each variant (choiceOf === markerName) is flattened as an
 * ordinary optional field with its own real resolved type, and the
 * containing object gets one `.superRefine()` enforcing FHIR's actual rule:
 * a choice type is 0..1 (or, when the group itself is required, exactly 1)
 * of the WHOLE group, not each variant independently. Design doc section 7,
 * "REJECT/DO BETTER #1" — the closest prior art (@solarahealth/fhir-r4)
 * flattens the same way but omits this check, so a payload setting BOTH
 * valueString and valueQuantity passes their validation. See
 * superRefineForChoiceGroups below.
 *
 * Explicitly NOT this module's job (see the design doc's Phase 3 sub-phases
 * and this PR's description for the split):
 *   - slicing (3d) — a sliced element with no further resolved structure
 *     falls through the same "unresolved complex type" path as extension
 *     elements, below.
 */

import type { ResolvedElement, ResolvedSchema } from "../merge/index.js";
import { FHIR_PRIMITIVE_TYPES } from "../fhir-schema-types.js";
import { expandValueSet, type TerminologySource } from "../terminology/index.js";

const PRIMITIVE_TYPES = new Set<string>(FHIR_PRIMITIVE_TYPES);

/**
 * Maps a FHIR primitive type to a Zod expression (as source text, since
 * we're generating a .ts file rather than building schemas at runtime).
 *
 * Deliberately conservative: FHIR's regex constraints on primitives (e.g.
 * `code` disallowing leading/trailing whitespace, `id` being
 * [A-Za-z0-9\-\.]{1,64}) are NOT enforced here — that's real structural
 * signal left on the table for a later pass, same as pre-Phase-2.
 *
 * `uri`/`url`/`canonical` deliberately stay z.string(), NOT z.string().url()
 * — FHIR's uri grammar is broader than WHATWG URL (design doc section 7,
 * "REJECT / DO BETTER #3": @solarahealth/fhir-r4 gets this wrong).
 */
function primitiveToZod(type: string): string {
  switch (type) {
    case "boolean":
      return "z.boolean()";
    case "integer":
    case "unsignedInt":
    case "positiveInt":
      return "z.number().int()";
    case "integer64":
      return "z.bigint()";
    case "decimal":
      return "z.number()";
    case "string":
    case "code":
    case "id":
    case "oid":
    case "uuid":
    case "markdown":
    case "xhtml":
      return "z.string()";
    case "uri":
    case "url":
    case "canonical":
      return "z.string()"; // NOT z.string().url() — FHIR uris are broader than WHATWG URLs
    case "base64Binary":
      return "z.string().base64()";
    case "instant":
    case "dateTime":
    case "date":
    case "time":
      return "z.string()"; // TODO(v0.2): validate against FHIR's date/time regexes
    default:
      // Not a FHIR primitive. Callers only reach this for types actually in
      // FHIR_PRIMITIVE_TYPES, so this is unreachable in practice; kept as an
      // honest fallback rather than a thrown error.
      return "z.string()";
  }
}

/** Escapes a constraint's human text so it can't prematurely close the `/* ... *\/` comment it's embedded in. */
function escapeForBlockComment(text: string): string {
  return text.replace(/\*\//g, "*-/");
}

interface EmitContext {
  warnings: string[];
  terminology?: TerminologySource;
  /** The type/document name of the file currently being built — the "from" side of an isCyclicEdge(from, to) check. */
  currentType: string;
  /** Named types this file references directly (top-level or via inline BackboneElement nesting) — becomes its import block. */
  imports: Set<string>;
  /** True iff a reference from `from`'s file to `to`'s file is part of a genuine cycle and must be z.lazy()-wrapped. */
  isCyclicEdge: (from: string, to: string) => boolean;
  /** Raw FHIR type name -> the collision-free identifier that type's own file/const/type actually uses (issue #14). */
  resolveTypeIdentifier: (rawTypeName: string) => string;
}

function elementToZod(name: string, el: ResolvedElement, ctx: EmitContext, indent: string): string {
  let expr: string;
  let bindingTodo: string | undefined;

  if (el.isNamedType) {
    // A reusable named complex type (HumanName, Identifier, Reference, ...)
    // resolved via SchemaSource — issue #6. Cross-file reference, never
    // inlined; see this file's module comment for why lazy-vs-plain is
    // decided from the whole reference graph rather than el.isCyclic alone.
    // resolveTypeIdentifier (not a bare toIdentifier(el.type)) so this
    // reference agrees with the target file's own name even when a
    // same-batch collision forced it to carry a disambiguating suffix
    // (issue #14).
    const typeIdent = ctx.resolveTypeIdentifier(el.type);
    ctx.imports.add(el.type);
    expr = ctx.isCyclicEdge(ctx.currentType, el.type)
      ? `z.lazy((): z.ZodTypeAny => ${typeIdent}Schema)`
      : `${typeIdent}Schema`;
  } else if (el.binding?.strength === "required" && el.binding.valueSet && PRIMITIVE_TYPES.has(el.type)) {
    // Defect 2. ONLY strength:"required" reaches here — see this function's
    // caller comment and the design doc's conformance rule: extensible/
    // preferred/example bindings permit out-of-valueset values, so an enum
    // would reject conformant data. Restricted to primitive-typed elements
    // (e.g. "code") — a required binding on a complex type like
    // CodeableConcept isn't a single string value and doesn't belong here.
    const expansion = ctx.terminology
      ? expandValueSet(el.binding.valueSet, ctx.terminology)
      : { ok: false as const, reason: "no terminology source configured" };

    if (expansion.ok) {
      expr = `z.enum([${expansion.codes.map((code) => JSON.stringify(code)).join(", ")}])`;
    } else {
      // Never a partial enum (design doc section 7, "REJECT/DO BETTER #4") —
      // fall back to the plain primitive mapping, with a loud marker instead
      // of a silent gap.
      ctx.warnings.push(
        `Element "${name}" has a required binding to "${el.binding.valueSet}" that could not be expanded (${expansion.reason}) — falling back to ${primitiveToZod(el.type)}.`
      );
      expr = primitiveToZod(el.type);
      bindingTodo = `/* TODO(defect 2): required binding "${el.binding.valueSet}" could not be expanded — ${escapeForBlockComment(expansion.reason)} */`;
    }
  } else if (el.elements && Object.keys(el.elements).length > 0) {
    // Inline structure — a BackboneElement (profile-local, never a reusable
    // named type; isNamedType is unset). Genuine named types were already
    // handled above and never reach this branch even though they too carry
    // `elements`.
    expr = objectSchemaBody(el.elements, ctx, indent + "  ");
  } else if (PRIMITIVE_TYPES.has(el.type)) {
    expr = primitiveToZod(el.type);
  } else {
    // A named complex type merge/ couldn't expand at all — SchemaSource has
    // no entry for it (e.g. "Extension", deliberately excluded from the
    // fixture-backed source, see merge/resolve.ts's module comment), or
    // it's mid-slicing (phase 3d). There's nowhere to import a schema from,
    // so z.unknown() is the honest fallback, with a loud TODO rather than a
    // silent gap.
    ctx.warnings.push(`Element "${name}" has type "${el.type}" with no resolved structure — defaulting to z.unknown().`);
    expr = `z.unknown() /* TODO: "${el.type}" has no resolved structure in the configured SchemaSource — falling back to z.unknown() */`;
  }

  if (el.array) {
    expr = `z.array(${expr})`;
    if (typeof el.min === "number" && el.min > 0) {
      expr += `.min(${el.min})`;
    }
    if (typeof el.max === "number") {
      expr += `.max(${el.max})`;
    }
    // el.max === "*" (unbounded) or undefined: no .max() call, same as an
    // ordinary unbounded array.
  }

  // `required` is already correctly derived by merge/ from the PARENT's
  // required list (design doc defect 6) — nothing to re-derive here.
  if (!el.required) {
    expr += ".optional()";
  }

  if (el.constraint) {
    for (const [id, detail] of Object.entries(el.constraint)) {
      // We don't evaluate FHIRPath here — that needs fhirpath.js at
      // runtime. Emit a comment marker so consumers know an invariant
      // exists and can wire it up with .refine() themselves.
      expr += ` /* TODO(invariant ${id}): ${escapeForBlockComment(detail.human)} */`;
    }
  }

  if (bindingTodo) {
    expr += ` ${bindingTodo}`;
  }

  return expr;
}

/** One `value[x]`-style choice group at a single object level, ready to emit as a `.superRefine()` check. */
interface ChoiceGroup {
  /** The FHIR base name, e.g. "value" for value[x] — never a real JSON key itself, only used in messages/paths. */
  markerName: string;
  /** The variant keys actually present in this object (e.g. ["valueString", "valueQuantity", ...]), in stable declaration order. */
  variantNames: string[];
  /** True when the group marker's own `required` (derived from the PARENT's required list, same as any element) is set — see superRefineForChoiceGroups. */
  required: boolean;
}

function objectSchemaBody(elements: Record<string, ResolvedElement>, ctx: EmitContext, indent: string): string {
  const lines: string[] = [];
  const closeIndent = indent.slice(0, -2);
  const choiceGroups: ChoiceGroup[] = [];

  for (const [name, el] of Object.entries(elements)) {
    if (el.choices) {
      // A choice-type group marker (e.g. "value" naming
      // ["valueQuantity","valueString",...]) — never a real JSON key (see
      // this file's module comment). Its variants are flattened as their
      // own ordinary fields below (they no longer hit this branch, since
      // only the marker itself carries `choices`); recorded here so a
      // .superRefine() enforcing FHIR's mutual-exclusivity rule can be
      // appended once the object literal closes.
      //
      // variantNames comes from scanning `elements` for choiceOf === name,
      // not from el.choices directly — that keeps this in sync with
      // whatever variant keys this object actually emits, rather than
      // trusting a list that could in principle name a variant merge/
      // didn't carry through.
      const variantNames = Object.entries(elements)
        .filter(([, variantEl]) => variantEl.choiceOf === name)
        .map(([variantName]) => variantName);
      if (variantNames.length > 0) {
        choiceGroups.push({ markerName: name, variantNames, required: el.required });
      }
      continue;
    }
    lines.push(`${indent}${JSON.stringify(name)}: ${elementToZod(name, el, ctx, indent)},`);
  }

  const objectExpr = `z.object({\n${lines.join("\n")}\n${closeIndent}})`;
  return choiceGroups.length > 0 ? `${objectExpr}${superRefineForChoiceGroups(choiceGroups, closeIndent)}` : objectExpr;
}

/**
 * Emits one `.superRefine()` — covering every choice group at this object
 * level, not one call per group — enforcing FHIR's actual choice-type rule:
 * a `value[x]`-style group is 0..1 of the WHOLE group (or exactly 1 when
 * the group itself is required), never each variant independently. Design
 * doc section 7, "REJECT/DO BETTER #1": the closest prior art
 * (@solarahealth/fhir-r4) flattens value[x] into N independent optional
 * keys with no refine at all, so a payload setting BOTH valueString and
 * valueQuantity passes their validation.
 *
 * A group whose marker is itself required gets "exactly one"; every other
 * group gets "at most one". Getting this backwards — "exactly one" on an
 * optional group — would reject conformant data that legitimately omits
 * the whole choice, which this project treats as worse than under-
 * validating (see CLAUDE.md's conformance rules and this module's z.enum
 * handling for the same principle applied to bindings).
 *
 * `(["a", "b"] as const)` (not a bare array literal) is load-bearing, not
 * stylistic: without `as const` the array infers as `string[]`, and
 * `data[key]` with a plain `string` key fails to compile under `tsc
 * --strict` against an object type with specific known keys (confirmed
 * against a standalone repro before writing this) — `as const` narrows
 * `key` to the literal union of this group's actual variant names, which
 * are the object's own keys.
 */
function superRefineForChoiceGroups(groups: ChoiceGroup[], baseIndent: string): string {
  const checkIndent = `${baseIndent}  `;
  const checks = groups
    .map((group) => {
      const keysExpr = `[${group.variantNames.map((n) => JSON.stringify(n)).join(", ")}] as const`;
      const groupLabel = `${group.markerName}[x]`;
      const variantList = group.variantNames.join(", ");

      const message = group.required
        ? [
            `${checkIndent}      message:`,
            `${checkIndent}        present.length === 0`,
            `${checkIndent}          ? \`Exactly one of ${variantList} is required (choice type "${groupLabel}"), but none were provided.\``,
            `${checkIndent}          : \`Exactly one of ${variantList} is required (choice type "${groupLabel}"), but multiple were provided: \${present.join(", ")}.\`,`,
          ].join("\n")
        : `${checkIndent}      message: \`At most one of ${variantList} may be set (choice type "${groupLabel}"), but multiple were provided: \${present.join(", ")}.\`,`;

      const path = group.required
        ? `present.length === 0 ? [${JSON.stringify(group.markerName)}] : present`
        : "present";

      return [
        `${checkIndent}{`,
        `${checkIndent}  const present = (${keysExpr}).filter((key) => data[key] !== undefined);`,
        `${checkIndent}  if (${group.required ? "present.length !== 1" : "present.length > 1"}) {`,
        `${checkIndent}    ctx.addIssue({`,
        `${checkIndent}      code: "custom",`,
        message,
        `${checkIndent}      path: ${path},`,
        `${checkIndent}    });`,
        `${checkIndent}  }`,
        `${checkIndent}}`,
      ].join("\n");
    })
    .join("\n");

  return `.superRefine((data, ctx) => {\n${checks}\n${baseIndent}})`;
}

/**
 * Walks `elements` looking for cross-file references
 * (ResolvedElement.isNamedType), collecting the referenced type names into
 * `targets`. Recurses into inline BackboneElement structure (same file:
 * `elements` populated but `isNamedType` unset) but stops at a named-type
 * boundary — that type's own further references are collected separately,
 * from its own registry entry (see discoverNamedTypes), not by recursing
 * through this particular occurrence of it.
 *
 * Choice-type variants (choiceOf set) are walked like any other element,
 * not skipped: since they're flattened as real fields (choice types, phase
 * 3c), a complex-typed variant (e.g. Observation.valueQuantity ->
 * Quantity) needs its target type discovered and its own file emitted the
 * same as a non-choice field would. The group marker itself (choices set,
 * no concrete type) never reaches this function — objectSchemaBody handles
 * it separately and never recurses into a marker's own (nonexistent)
 * `elements`.
 */
function collectNamedTypeRefs(elements: Record<string, ResolvedElement>, targets: Set<string>): void {
  for (const el of Object.values(elements)) {
    if (el.isNamedType) {
      targets.add(el.type);
    } else if (el.elements) {
      collectNamedTypeRefs(el.elements, targets);
    }
  }
}

/**
 * Discovers every named complex type reachable from `roots` (the element
 * maps of one or more documents/types), returning a type-name -> elements
 * registry. Each entry becomes its own emitted file (issue #6, strategy B —
 * one file per complex datatype, over strategy A's "inline + local z.lazy
 * per cycle"; see the PR description for why).
 *
 * A type is registered the first time a *non-cyclic* occurrence supplies its
 * elements. That's guaranteed to happen somewhere in the walk for every type
 * genuinely referenced: within any single top-down resolution, the first
 * time a type is encountered it is always expanded in full — merge/'s
 * "creating"/"created" cache can only report a cycle for a *re-entrant*
 * visit, never a first one (see resolve.ts's resolveTypeElements) — so a
 * cyclic occurrence elsewhere in the graph never leaves a type
 * unregistered, it just means that occurrence's own `elements` is skipped
 * here in favor of the one that already populated the registry.
 */
function discoverNamedTypes(roots: Record<string, ResolvedElement>[]): Map<string, Record<string, ResolvedElement>> {
  const registry = new Map<string, Record<string, ResolvedElement>>();
  const queue: Record<string, ResolvedElement>[] = [...roots];

  while (queue.length > 0) {
    const elements = queue.shift()!;
    for (const el of Object.values(elements)) {
      // Choice variants aren't skipped here either — see
      // collectNamedTypeRefs's doc comment above for why.
      if (el.isNamedType) {
        if (el.elements && !registry.has(el.type)) {
          registry.set(el.type, el.elements);
          queue.push(el.elements);
        }
      } else if (el.elements) {
        queue.push(el.elements);
      }
    }
  }

  return registry;
}

/** type name -> the set of other type names it references directly. */
function buildTypeEdges(registry: Map<string, Record<string, ResolvedElement>>): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const [typeName, elements] of registry) {
    const targets = new Set<string>();
    collectNamedTypeRefs(elements, targets);
    edges.set(typeName, targets);
  }
  return edges;
}

/** type name -> every type name transitively reachable from it via `edges`. */
function computeReachability(edges: Map<string, Set<string>>): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const n of edges.get(next) ?? []) stack.push(n);
    }
    reach.set(start, seen);
  }
  return reach;
}

/**
 * Builds the isCyclicEdge(from, to) decision elementToZod uses to choose
 * z.lazy() vs a plain reference. An edge is a genuine cycle — and must be
 * z.lazy()-wrapped on *both* ends, not just one — iff `to` can reach back to
 * `from`.
 *
 * Deliberately NOT driven by the referencing ResolvedElement's own
 * `isCyclic` flag: that flag marks the *single* occurrence merge/'s
 * single-path walk happened to cut a re-entrant expansion at, which for a
 * real two-file cycle (e.g. Identifier <-> Reference) is only ever one of
 * the two directions — which one depends on resolution order (which type
 * was reached first), not on anything meaningful to emit/. Wrapping only
 * that one occurrence and leaving the other as a plain eager
 * `import { XSchema } from "./X.js"; ...XSchema...` reference is unsafe: in
 * a genuine circular ES module import, whichever of the two files a
 * consumer's module graph happens to load first will, at its own top-level
 * `z.object({...})` construction, dereference the *other* file's still-
 * uninitialized export and throw "Cannot access 'XSchema' before
 * initialization" — confirmed empirically against Node's ESM loader while
 * building this. Recomputing cycle membership from the whole reference
 * graph (rather than trusting the single flagged occurrence) guarantees
 * both directions agree, so neither file's top-level code ever needs the
 * other's value before it's had a chance to exist.
 */
function buildCyclicEdgeChecker(
  registry: Map<string, Record<string, ResolvedElement>>
): (from: string, to: string) => boolean {
  const edges = buildTypeEdges(registry);
  const reach = computeReachability(edges);
  return (from, to) => from === to || (reach.get(to)?.has(from) ?? false);
}

export interface EmitResult {
  fileName: string;
  source: string;
  warnings: string[];
}

export interface EmitOptions {
  /**
   * Optional ValueSet/CodeSystem lookup for expanding required-strength
   * bindings into z.enum(...) (defect 2). Omitting it is a valid, fully
   * supported configuration — every required binding then degrades to its
   * plain primitive mapping with a TODO(defect 2) marker, same as if
   * expansion had failed. emit/ still does no I/O itself; the caller (e.g.
   * defects.test.ts, generate.ts) constructs the source, typically via
   * terminology/fixture-terminology-source.ts today or a package-backed one
   * in Phase 4.
   */
  terminology?: TerminologySource;
}

/**
 * A FHIR Schema `name` is not guaranteed to be a valid TypeScript identifier.
 * Base R4 alone ships `observation-bodyheight`, `CQF-Questionnaire`, and
 * `DiagnosticReport-Genetics`; interpolating those straight into
 * `export const <name>Schema` emits a file that does not parse.
 *
 * Names that are already valid identifiers pass through untouched, so the
 * common case (`Patient`, `USCorePatientProfile`) is unaffected. Anything else
 * is PascalCased across non-identifier boundaries:
 * `observation-bodyheight` -> `ObservationBodyheight`.
 *
 * Issue #14: the *file* name is now derived from this same identifier too
 * (`ObservationBodyheight.ts`, not `observation-bodyheight.ts`) — see
 * resolveFileIdentifiers below for why a bare toIdentifier() call isn't the
 * whole story once two different raw names can sanitize to the same
 * identifier, or two different documents share the same raw name outright.
 */
export function toIdentifier(name: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
  const joined = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  if (joined === "") return "_";
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

/**
 * Small, deterministic, dependency-free string hash (FNV-1a, 32-bit,
 * base36) — not cryptographic, just stable across runs and platforms.
 * Used only to derive a short disambiguating suffix for a colliding file
 * name (issue #14); node:crypto would work too but pulls in a Node-specific
 * API this module otherwise avoids, since emit/ is meant to be adoptable by
 * non-Node consumers of the same source text (design doc section 2).
 */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** One document or complex datatype that needs a file/const identifier. */
interface NamingUnit {
  /** Stable and unique across the whole batch: a document's canonical `url`, or a datatype's own type name (already unique — it's the registry's Map key). */
  uniqueKey: string;
  /** The raw FHIR Schema name/type name before sanitization — what toIdentifier() is applied to. */
  rawName: string;
}

/**
 * Resolves every naming unit to a collision-free, TS-identifier-safe file
 * identifier (issue #14). `toIdentifier(rawName)` is the base; FHIR Schema
 * names are not unique (r4.core ships five distinct StructureDefinitions
 * all named "Example Lipid Profile"), and sanitization itself can also
 * collapse two different raw names onto the same identifier. Either way,
 * every member of a colliding group gets a short deterministic suffix
 * derived from its own `uniqueKey` — not just the 2nd/3rd/... member, so
 * which one (if any) keeps the bare name never depends on input order or on
 * an arbitrary "first" pick.
 *
 * Deterministic: identical input produces identical output. Grouping is by
 * content (the sanitized base name), not insertion order, and the suffix is
 * a pure hash of each unit's own uniqueKey.
 *
 * Never silently overwrites: if two *different* uniqueKeys somehow still
 * resolve to the same final name (a same-length hash collision, or a caller
 * handing this the same uniqueKey twice under different raw names), this
 * throws rather than letting the second one's file quietly clobber the
 * first's on disk.
 */
function resolveFileIdentifiers(units: NamingUnit[]): Map<string, string> {
  const groups = new Map<string, NamingUnit[]>();
  for (const unit of units) {
    const base = toIdentifier(unit.rawName);
    const group = groups.get(base);
    if (group) group.push(unit);
    else groups.set(base, [unit]);
  }

  const resolved = new Map<string, string>();
  const ownerOfFinalName = new Map<string, string>();

  const assign = (uniqueKey: string, finalName: string): void => {
    const existingOwner = ownerOfFinalName.get(finalName);
    if (existingOwner !== undefined && existingOwner !== uniqueKey) {
      throw new Error(
        `emit/: cannot produce a unique file name for both "${existingOwner}" and "${uniqueKey}" — both resolve to ` +
          `"${finalName}.ts". Refusing to let one silently overwrite the other on disk (issue #14).`
      );
    }
    ownerOfFinalName.set(finalName, uniqueKey);
    resolved.set(uniqueKey, finalName);
  };

  for (const [base, group] of groups) {
    if (group.length === 1) {
      assign(group[0].uniqueKey, base);
      continue;
    }
    // A genuine collision: every member gets a suffix, including whichever
    // would otherwise have "won" the bare name — see this function's doc
    // comment on why no member is special-cased.
    for (const unit of group) {
      assign(unit.uniqueKey, `${base}_${shortHash(unit.uniqueKey)}`);
    }
  }

  return resolved;
}

/**
 * Builds the two lookups emitOneFile/elementToZod need to turn a raw
 * document or datatype name into its actual, collision-free identifier
 * (issue #14): `resolveTypeIdentifier` for cross-file references (keyed by
 * the raw FHIR type name, which doubles as a datatype's uniqueKey), and
 * `identifierFor` for a document's own file (keyed by its `url`).
 *
 * Shared by emitDocument and emitPackage so both apply the exact same
 * disambiguation rule — emitDocument scoped to just its own document plus
 * the datatypes it locally discovers, emitPackage across the whole batch.
 */
function buildIdentifierResolvers(
  schemas: ResolvedSchema[],
  registry: Map<string, Record<string, ResolvedElement>>
): { identifierFor: (documentUrl: string) => string; resolveTypeIdentifier: (rawTypeName: string) => string } {
  // Two schemas sharing a url isn't a "name collision" resolveFileIdentifiers
  // can disambiguate — it's a different document/url pair using `url` as its
  // uniqueKey twice, so the *later* one would silently clobber the earlier
  // one's identifierFor(...) result no matter what name each carries. `url`
  // is supposed to be a StructureDefinition's canonical identity; two
  // ResolvedSchemas sharing one is a caller bug (e.g. the same document
  // resolved and passed in twice), not something #14 asks this module to
  // paper over.
  const seenUrls = new Set<string>();
  for (const s of schemas) {
    if (seenUrls.has(s.url)) {
      throw new Error(`emit/: two documents share the same url "${s.url}" — each document's url must be unique within a batch.`);
    }
    seenUrls.add(s.url);
  }

  const units: NamingUnit[] = [
    ...schemas.map((s) => ({ uniqueKey: s.url, rawName: s.name })),
    ...[...registry.keys()].map((typeName) => ({ uniqueKey: typeName, rawName: typeName })),
  ];
  const resolved = resolveFileIdentifiers(units);

  // Every uniqueKey passed in above got an entry, so these fallbacks are
  // unreachable in practice — kept as an honest default over a thrown
  // assertion, consistent with this module's style elsewhere.
  return {
    identifierFor: (documentUrl) => resolved.get(documentUrl) ?? toIdentifier(documentUrl),
    resolveTypeIdentifier: (rawTypeName) => resolved.get(rawTypeName) ?? toIdentifier(rawTypeName),
  };
}

interface FileMeta {
  /** The raw FHIR Schema name/type name, shown in the header comment even when the identifier below carries a disambiguating suffix. */
  rawName: string;
  url?: string;
  kind?: string;
  base?: string;
  derivation?: string;
  /** True for a shared complex-datatype file (registry entry); false for a resource/profile document. */
  isDatatype: boolean;
}

/** Emits one .ts file's full source (header, imports, schema const, inferred type) for either a document or a registered datatype. */
function emitOneFile(
  identifier: string,
  elements: Record<string, ResolvedElement>,
  meta: FileMeta,
  isCyclicEdge: (from: string, to: string) => boolean,
  resolveTypeIdentifier: (rawTypeName: string) => string,
  options: EmitOptions
): EmitResult {
  const imports = new Set<string>();
  const ctx: EmitContext = {
    warnings: [],
    terminology: options.terminology,
    currentType: meta.rawName,
    imports,
    isCyclicEdge,
    resolveTypeIdentifier,
  };
  const constName = `${identifier}Schema`;

  const body = objectSchemaBody(elements, ctx, "  ");

  const importLines = [...imports]
    .sort()
    .map((rawTypeRef) => {
      const importIdent = resolveTypeIdentifier(rawTypeRef);
      return `import { ${importIdent}Schema } from "./${importIdent}.js";`;
    });

  const header = [
    "// AUTO-GENERATED by fhir-zod-gen — do not edit by hand.",
    meta.isDatatype
      ? `// Complex datatype: ${meta.rawName} — shared, referenced by one or more resources/profiles/other datatypes in this package.`
      : `// Source: ${meta.url}`,
    !meta.isDatatype ? `// Kind: ${meta.kind}${meta.base ? `, base: ${meta.base}` : ""}` : null,
    !meta.isDatatype && meta.derivation === "constraint"
      ? "// This is a profile (constraint), not a base resource — fields narrow the base type's cardinality/bindings."
      : null,
    'import { z } from "zod";',
    ...importLines,
    "",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const source = `${header}export const ${constName} = ${body};\n\nexport type ${identifier} = z.infer<typeof ${constName}>;\n`;

  return {
    fileName: `${identifier}.ts`,
    source,
    warnings: ctx.warnings,
  };
}

/**
 * Emit a single .ts file (Zod schema + inferred type) for one resolved FHIR
 * Schema document (one profile or base resource, already merged with its
 * base — see src/merge/).
 *
 * Scoped to just this document: any complex datatype it references
 * (ResolvedElement.isNamedType) is emitted as a cross-file
 * `import { XSchema } from "./X.js"`, but that referenced type's own file is
 * NOT part of this call's return value — only emitPackage's is. Cycle
 * detection is still correct even so: it only needs this document's own
 * already-fully-merged element tree (see discoverNamedTypes's doc comment
 * on why a full, non-cyclic expansion of every referenced type is always
 * reachable from a single top-down walk).
 */
export function emitDocument(schema: ResolvedSchema, options: EmitOptions = {}): EmitResult {
  const registry = discoverNamedTypes([schema.elements]);
  const isCyclicEdge = buildCyclicEdgeChecker(registry);
  const { identifierFor, resolveTypeIdentifier } = buildIdentifierResolvers([schema], registry);
  return emitOneFile(
    identifierFor(schema.url),
    schema.elements,
    { rawName: schema.name, url: schema.url, kind: schema.kind, base: schema.base, derivation: schema.derivation, isDatatype: false },
    isCyclicEdge,
    resolveTypeIdentifier,
    options
  );
}

/**
 * Emit a whole package: one file per document in `schemas`, plus one file
 * per complex datatype any of them reference directly or transitively — the
 * counterpart emitDocument alone can't produce, since a document's
 * complex-typed fields are cross-file references (issue #6, strategy B).
 * Types are deduplicated by name across the whole batch: Identifier is
 * emitted exactly once even though both Patient and Observation reference
 * it, and Identifier <-> Reference's genuine cycle is resolved consistently
 * across every file that touches either type (see buildCyclicEdgeChecker).
 *
 * This is what generate.ts's generatePackage should call once, over every
 * successfully-resolved document, rather than looping emitDocument per
 * document — a per-document loop would either duplicate every referenced
 * datatype's file once per referencing document, or (worse) never emit them
 * at all, per emitDocument's own doc comment above.
 */
export function emitPackage(schemas: ResolvedSchema[], options: EmitOptions = {}): EmitResult[] {
  const registry = discoverNamedTypes(schemas.map((s) => s.elements));
  const isCyclicEdge = buildCyclicEdgeChecker(registry);
  const { identifierFor, resolveTypeIdentifier } = buildIdentifierResolvers(schemas, registry);

  const results: EmitResult[] = [];
  for (const schema of schemas) {
    results.push(
      emitOneFile(
        identifierFor(schema.url),
        schema.elements,
        { rawName: schema.name, url: schema.url, kind: schema.kind, base: schema.base, derivation: schema.derivation, isDatatype: false },
        isCyclicEdge,
        resolveTypeIdentifier,
        options
      )
    );
  }
  for (const [typeName, elements] of registry) {
    results.push(
      emitOneFile(resolveTypeIdentifier(typeName), elements, { rawName: typeName, isDatatype: true }, isCyclicEdge, resolveTypeIdentifier, options)
    );
  }
  return results;
}
