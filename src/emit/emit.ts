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
 * Explicitly NOT this module's job (see the design doc's Phase 3 sub-phases
 * and this PR's description for the split):
 *   - choice types (value[x] flattening + mutual-exclusivity refine, 3c) —
 *     a choice-type group marker (ResolvedElement.choices set, no concrete
 *     type of its own) emits z.unknown() with a TODO; its variant elements
 *     (choiceOf set) are skipped entirely, same as pre-Phase-2.
 *   - slicing (3d) — a sliced element with no further resolved structure
 *     falls through the same "unresolved complex type" path as extension/
 *     cyclic elements, below.
 *   - defect 5's full half (real cross-file imports + z.lazy() for cycles)
 *     — see the "unresolved complex type" branch in elementToZod for the
 *     minimal compiling story this module uses instead.
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
}

function elementToZod(name: string, el: ResolvedElement, ctx: EmitContext, indent: string): string {
  let expr: string;
  let bindingTodo: string | undefined;

  if (el.isCyclic) {
    // Cut short by merge/'s cycle guard (e.g. Identifier -> Reference ->
    // Identifier). The two-tier z.lazy() recursion strategy that would give
    // this a real schema is design doc section 7's "STEAL #1" — bundled
    // into defect 5, not this phase. z.unknown() is the honest fallback
    // (design doc section 7, "REJECT/DO BETTER #4": say so loudly, don't
    // silently under-validate).
    ctx.warnings.push(`Element "${name}" is a cyclic reference (type "${el.type}") — z.lazy() cycle support not implemented yet.`);
    expr = "z.unknown() /* TODO(defect 5): cyclic reference — z.lazy() cycle emission not implemented yet */";
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
    // Resolved structure — a BackboneElement, or a complex type merge/
    // expanded via SchemaSource (e.g. HumanName, Identifier). Works
    // uniformly for both; ResolvedElement doesn't need to distinguish them.
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
    // A named complex type merge/ couldn't expand further — either
    // SchemaSource has no entry for it (e.g. "Extension", deliberately
    // excluded from the fixture-backed source, see merge/resolve.ts's
    // module comment) or it's mid-slicing (phase 3d). Either way there's no
    // resolved structure and no real cross-file import wiring yet (that's
    // defect 5's other half) — z.unknown() is the simplest thing that
    // compiles, with a loud TODO rather than a silent gap.
    ctx.warnings.push(`Element "${name}" has type "${el.type}" with no resolved structure — defaulting to z.unknown().`);
    expr = `z.unknown() /* TODO(defect 5): "${el.type}" has no resolved structure — cross-file schema resolution not implemented yet */`;
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
 * Emit a single .ts file (Zod schema + inferred type) for one resolved FHIR
 * Schema document (one profile or base resource, already merged with its
 * base — see src/merge/).
 */
export function emitDocument(schema: ResolvedSchema, options: EmitOptions = {}): EmitResult {
  const ctx: EmitContext = { warnings: [], terminology: options.terminology };
  const constName = `${schema.name}Schema`;
  const typeName = schema.name;

  const body = objectSchemaBody(schema.elements, ctx, "  ");

  const header = [
    "// AUTO-GENERATED by fhir-zod-gen — do not edit by hand.",
    `// Source: ${schema.url}`,
    `// Kind: ${schema.kind}${schema.base ? `, base: ${schema.base}` : ""}`,
    schema.derivation === "constraint"
      ? "// This is a profile (constraint), not a base resource — fields narrow the base type's cardinality/bindings."
      : null,
    'import { z } from "zod";',
    "",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const source = `${header}export const ${constName} = ${body};\n\nexport type ${typeName} = z.infer<typeof ${constName}>;\n`;

  return {
    fileName: `${schema.name}.ts`,
    source,
    warnings: ctx.warnings,
  };
}
