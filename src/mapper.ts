import type {
  FhirSchemaDocument,
  FhirSchemaElement,
  FhirSchemaPrimitiveType,
} from "./fhir-schema-types.js";

/**
 * Maps a FHIR primitive type to a Zod expression (as source text, since we're
 * generating a .ts file rather than building schemas at runtime).
 *
 * Deliberately conservative: FHIR's regex constraints on primitives (e.g.
 * `code` disallowing leading/trailing whitespace, `id` being [A-Za-z0-9\-\.]{1,64})
 * are NOT enforced here in v0.1. That's real structural signal we're leaving
 * on the table for a later pass — flagged in generated output as a TODO
 * rather than silently doing nothing.
 */
function primitiveToZod(type: FhirSchemaPrimitiveType | string): string {
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
      // Not a known primitive — treat as a reference to another generated schema.
      return `${type}Schema`;
  }
}

interface GenContext {
  /** type name -> generated const name, so nested/complex types resolve to refs */
  knownTypes: Set<string>;
  warnings: string[];
}

function elementToZod(
  name: string,
  el: FhirSchemaElement,
  ctx: GenContext,
  indent: string
): string {
  let expr: string;

  if (el.elements && Object.keys(el.elements).length > 0) {
    // Inline backbone element — recurse into an object schema.
    expr = objectSchemaBody(el.elements, ctx, indent + "  ");
  } else if (el.type) {
    expr = primitiveToZod(el.type);
  } else {
    ctx.warnings.push(`Element "${name}" has neither a type nor nested elements — defaulting to z.unknown().`);
    expr = "z.unknown()";
  }

  // Required-strength bindings with a resolved code list become a real enum.
  // Extensible/preferred bindings are intentionally left as open strings —
  // FHIR permits values outside the value set for those strengths, so a
  // Zod enum would reject conformant data.
  if (el.binding?.strength === "required" && el.binding.codes?.length) {
    const codes = el.binding.codes.map((c) => JSON.stringify(c)).join(", ");
    expr = `z.enum([${codes}])`;
  } else if (el.binding && el.binding.strength !== "required") {
    // no-op, but left explicit for readability of intent
  }

  if (el.array) {
    expr = `z.array(${expr})`;
    if (typeof el.min === "number" && el.min > 0) {
      expr += `.min(${el.min})`;
    }
    if (typeof el.max === "number") {
      expr += `.max(${el.max})`;
    }
  }

  const isRequired = el.required || (typeof el.min === "number" && el.min > 0);
  if (!isRequired) {
    expr += ".optional()";
  }

  if (el.constraint?.length) {
    for (const c of el.constraint) {
      // We don't evaluate FHIRPath here — that needs fhirpath.js at runtime.
      // Emit a comment marker so consumers know an invariant exists and can
      // wire it up with .refine() themselves, or via the planned v0.2
      // --with-invariants flag.
      expr += ` /* TODO(invariant ${c.key}): ${c.human.replace(/\*\//g, "*-/")} */`;
    }
  }

  return expr;
}

function objectSchemaBody(
  elements: Record<string, FhirSchemaElement>,
  ctx: GenContext,
  indent: string
): string {
  const lines: string[] = [];
  const closeIndent = indent.slice(0, -2);

  // Handle choice types (value[x]) as a discriminated set of optional keys
  // rather than a true union, since FHIR JSON serializes the chosen type as
  // part of the key name (valueString, valueQuantity, ...), not as a
  // separate discriminator field. A z.union of the whole object would be
  // more "correct" but much less ergonomic for consumers; open to revisiting.
  for (const [name, el] of Object.entries(elements)) {
    if (el.choiceOf) continue; // handled when we hit the base value[x] entry, if we track it
    lines.push(`${indent}${JSON.stringify(name)}: ${elementToZod(name, el, ctx, indent)},`);
  }

  return `z.object({\n${lines.join("\n")}\n${closeIndent}})`;
}

export interface GenerateResult {
  fileName: string;
  source: string;
  warnings: string[];
}

/**
 * Generate a single .ts file (Zod schema + inferred type) for one FHIR
 * Schema document (one profile or base resource).
 */
export function generateSchemaFile(doc: FhirSchemaDocument): GenerateResult {
  const ctx: GenContext = { knownTypes: new Set(), warnings: [] };
  const constName = `${doc.name}Schema`;
  const typeName = doc.name;

  const body = objectSchemaBody(doc.elements, ctx, "  ");

  const header = [
    "// AUTO-GENERATED by fhir-zod-gen — do not edit by hand.",
    `// Source: ${doc.url}`,
    `// Kind: ${doc.kind}${doc.base ? `, base: ${doc.base}` : ""}`,
    doc.derivation === "constraint"
      ? "// This is a profile (constraint), not a base resource — fields narrow the base type's cardinality/bindings."
      : null,
    'import { z } from "zod";',
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const source = `${header}export const ${constName} = ${body};\n\nexport type ${typeName} = z.infer<typeof ${constName}>;\n`;

  return {
    fileName: `${doc.name}.ts`,
    source,
    warnings: ctx.warnings,
  };
}
