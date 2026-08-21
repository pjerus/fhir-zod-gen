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
 * Explicitly NOT this module's job (see the design doc's Phase 3 sub-phases
 * and this PR's description for the split):
 *   - choice types (value[x] flattening + mutual-exclusivity refine, 3c) —
 *     a choice-type group marker (ResolvedElement.choices set, no concrete
 *     type of its own) emits z.unknown() with a TODO; its variant elements
 *     (choiceOf set) are skipped entirely, same as pre-Phase-2.
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
}

function elementToZod(name: string, el: ResolvedElement, ctx: EmitContext, indent: string): string {
  let expr: string;
  let bindingTodo: string | undefined;

  if (el.isNamedType) {
    // A reusable named complex type (HumanName, Identifier, Reference, ...)
    // resolved via SchemaSource — issue #6. Cross-file reference, never
    // inlined; see this file's module comment for why lazy-vs-plain is
    // decided from the whole reference graph rather than el.isCyclic alone.
    const typeIdent = toIdentifier(el.type);
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
  } else if (el.choices) {
    // A choice-type group marker (e.g. "deceased" naming
    // ["deceasedBoolean","deceasedDateTime"]) — FHIR Schema gives the group
    // marker itself no concrete type of its own. Flattening + a
    // mutual-exclusivity .superRefine() is phase 3c's job.
    ctx.warnings.push(`Element "${name}" is a choice-type group (${el.choices.join(", ")}) — flattening not implemented yet (phase 3c).`);
    expr = "z.unknown() /* TODO(phase 3c): choice type (value[x]) flattening not implemented yet */";
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

function objectSchemaBody(elements: Record<string, ResolvedElement>, ctx: EmitContext, indent: string): string {
  const lines: string[] = [];
  const closeIndent = indent.slice(0, -2);

  for (const [name, el] of Object.entries(elements)) {
    // Choice-type variants (deceasedBoolean, deceasedDateTime, ...) are
    // handled at their group marker (choices), not flattened individually
    // here — see elementToZod's choices branch. Emitting them as their own
    // keys too would duplicate data the group marker already covers.
    if (el.choiceOf) continue;
    lines.push(`${indent}${JSON.stringify(name)}: ${elementToZod(name, el, ctx, indent)},`);
  }

  return `z.object({\n${lines.join("\n")}\n${closeIndent}})`;
}

/**
 * Walks `elements` looking for cross-file references
 * (ResolvedElement.isNamedType), collecting the referenced type names into
 * `targets`. Recurses into inline BackboneElement structure (same file:
 * `elements` populated but `isNamedType` unset) but stops at a named-type
 * boundary — that type's own further references are collected separately,
 * from its own registry entry (see discoverNamedTypes), not by recursing
 * through this particular occurrence of it.
 */
function collectNamedTypeRefs(elements: Record<string, ResolvedElement>, targets: Set<string>): void {
  for (const el of Object.values(elements)) {
    if (el.choiceOf) continue;
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
      if (el.choiceOf) continue;
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
 * The *file* name deliberately keeps the original: `observation-bodyheight.ts`
 * is a perfectly good filename, and generate.ts's barrel index re-exports by
 * path, not by identifier.
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

interface FileMeta {
  url?: string;
  kind?: string;
  base?: string;
  derivation?: string;
  /** True for a shared complex-datatype file (registry entry); false for a resource/profile document. */
  isDatatype: boolean;
}

/** Emits one .ts file's full source (header, imports, schema const, inferred type) for either a document or a registered datatype. */
function emitOneFile(
  name: string,
  elements: Record<string, ResolvedElement>,
  meta: FileMeta,
  isCyclicEdge: (from: string, to: string) => boolean,
  options: EmitOptions
): EmitResult {
  const imports = new Set<string>();
  const ctx: EmitContext = { warnings: [], terminology: options.terminology, currentType: name, imports, isCyclicEdge };
  const typeName = toIdentifier(name);
  const constName = `${typeName}Schema`;

  const body = objectSchemaBody(elements, ctx, "  ");

  const importLines = [...imports]
    .sort()
    .map((typeRef) => `import { ${toIdentifier(typeRef)}Schema } from "./${typeRef}.js";`);

  const header = [
    "// AUTO-GENERATED by fhir-zod-gen — do not edit by hand.",
    meta.isDatatype
      ? `// Complex datatype: ${name} — shared, referenced by one or more resources/profiles/other datatypes in this package.`
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

  const source = `${header}export const ${constName} = ${body};\n\nexport type ${typeName} = z.infer<typeof ${constName}>;\n`;

  return {
    fileName: `${name}.ts`,
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
  return emitOneFile(
    schema.name,
    schema.elements,
    { url: schema.url, kind: schema.kind, base: schema.base, derivation: schema.derivation, isDatatype: false },
    isCyclicEdge,
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

  const results: EmitResult[] = [];
  for (const schema of schemas) {
    results.push(
      emitOneFile(
        schema.name,
        schema.elements,
        { url: schema.url, kind: schema.kind, base: schema.base, derivation: schema.derivation, isDatatype: false },
        isCyclicEdge,
        options
      )
    );
  }
  for (const [typeName, elements] of registry) {
    results.push(emitOneFile(typeName, elements, { isDatatype: true }, isCyclicEdge, options));
  }
  return results;
}
