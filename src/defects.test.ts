/**
 * One test per verified defect from
 * docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md section 1,
 * asserted against the real committed fixtures under fixtures/ (not
 * hand-authored stand-ins — see mapper.test.ts's history for why that
 * approach validated nothing).
 *
 * Convention: every test here uses vitest's `it.fails()`. The assertion
 * inside states the CORRECT behavior a fixed generator must have; that
 * assertion does not hold against current mapper.ts, so the test currently
 * reports as an *expected* failure (green suite, the defect visible right
 * in the test name). When a later phase actually fixes the underlying
 * defect, flip that test's `it.fails` to a plain `it` — it should then pass
 * for real. Do not delete or rewrite the assertion when a fix lands;
 * flipping it in place is what proves the fix closed the exact gap this
 * test documents. If `it.fails` ever starts passing without anyone flipping
 * it, that is itself a bug in this file — vitest reports that as a failure.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateSchemaFile } from "./mapper.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): FhirSchemaDocument {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as FhirSchemaDocument;
}

/**
 * Pulls the source text of one `"<name>": <expr>,` property value out of
 * generated output, balancing brackets so multi-line nested object
 * expressions (e.g. a backbone element's z.object({...})) come back whole
 * rather than truncated at the first inner comma.
 */
function extractField(source: string, name: string): string {
  const marker = `"${name}": `;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`field "${name}" not found in generated source:\n${source}`);
  }
  let i = start + marker.length;
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) break;
  }
  return source.slice(start + marker.length, i);
}

describe("verified defects (design doc section 1)", () => {
  it.fails(
    'defect 1: doc-level `required` (string[] of child element names) is never consulted — ' +
      'uscore-patient.fhirschema.json has required:["gender","identifier","name"], but generated ' +
      '"gender" still emits .optional()',
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.required).toContain("gender"); // ground truth, not a mapper claim
      const { source } = generateSchemaFile(doc);
      expect(extractField(source, "gender")).not.toMatch(/\.optional\(\)$/);
    }
  );

  it.fails(
    "defect 2: `binding.codes` never exists on real bindings (only {strength, valueSet, bindingName}) — " +
      "required-strength gender never becomes a z.enum, even though the ValueSet it references is " +
      "committed and expandable at fixtures/valuesets/ValueSet-administrative-gender.json",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.gender?.binding).not.toHaveProperty("codes"); // ground truth
      const { source } = generateSchemaFile(doc);
      expect(extractField(source, "gender")).toMatch(/^z\.enum\(/);
    }
  );

  it.fails(
    'defect 3: `constraint` is a Record keyed by constraint id, not an array — ' +
      'uscore-patient.fhirschema.json has name.constraint["us-core-6"], but no invariant TODO marker ' +
      "is ever emitted for it",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.name?.constraint).toHaveProperty("us-core-6"); // ground truth
      const { source } = generateSchemaFile(doc);
      expect(source).toContain("TODO(invariant us-core-6)");
    }
  );

  it.fails(
    "defect 4: a profile element that only narrows a base carries no type/array/min/max — " +
      'uscore-patient.fhirschema.json\'s "name" element has no `array` field at all (it lives on base ' +
      "r4-patient), so the generated name schema loses array:true and its leaf children (e.g. family, " +
      "given) fall through to z.unknown() instead of z.string()",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.name?.array).toBeUndefined(); // ground truth
      const { source } = generateSchemaFile(doc);
      const nameField = extractField(source, "name");
      expect(nameField).toMatch(/^z\.array\(/);
      expect(nameField).not.toContain("z.unknown()");
    }
  );

  it.fails(
    "defect 5: no base or cross-file resolution — uscore-patient.fhirschema.json's top-level " +
      '"extension" element (type:"Extension", no nested `elements`) emits a bare `ExtensionSchema` ' +
      "reference with no corresponding import, so the generated file does not compile on its own",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.extension?.type).toBe("Extension"); // ground truth
      expect(doc.elements.extension?.elements).toBeUndefined();
      const { source } = generateSchemaFile(doc);
      if (source.includes("ExtensionSchema")) {
        expect(source).toMatch(/import\s*\{[^}]*\bExtensionSchema\b[^}]*\}\s*from/);
      }
    }
  );
});
