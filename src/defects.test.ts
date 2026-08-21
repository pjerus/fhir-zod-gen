/**
 * One test per verified defect from
 * docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md section 1,
 * asserted against the real committed fixtures under fixtures/ (not
 * hand-authored stand-ins — see mapper.test.ts's history, since deleted, for
 * why that approach validated nothing).
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
 *
 * Phase 3a update: the emitter under test is now emit/emitDocument, which
 * consumes a ResolvedSchema (merge/resolveDocument's output), not the raw
 * FhirSchemaDocument. Ground-truth assertions about the *source* format
 * (e.g. `doc.required` being a string[]) still load the raw fixture
 * directly — that's a claim about what the converter emits, independent of
 * how we resolve or emit it. Assertions about generated *output* now go
 * through resolveDocument first.
 *
 * Defect 2 (ValueSet expansion -> z.enum) and the cross-file-import half of
 * defect 5 remain unimplemented by design — later sub-phases (3b, and the
 * rest of 5) — so they stay it.fails(). Defects 1/3/4 are genuinely fixed by
 * consuming ResolvedSchema, so those are flipped. Defect 5's "output does
 * not compile" consequence is also fixed — see that test's comment for why
 * it's flipped even though full cross-file resolution isn't.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveDocument } from "./merge/resolve.js";
import { loadFixtureSchemaSource } from "./merge/fixture-schema-source.js";
import { emitDocument } from "./emit/index.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const source = loadFixtureSchemaSource(FIXTURES_DIR);

function loadFixture(name: string): FhirSchemaDocument {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as FhirSchemaDocument;
}

function emitFixture(name: string): string {
  const resolved = resolveDocument(loadFixture(name), source);
  return emitDocument(resolved).source;
}

/**
 * Pulls the source text of one `"<name>": <expr>,` property value out of
 * generated output, balancing brackets so multi-line nested object
 * expressions (e.g. a backbone element's z.object({...})) come back whole
 * rather than truncated at the first inner comma.
 */
function extractField(generatedSource: string, name: string): string {
  const marker = `"${name}": `;
  const start = generatedSource.indexOf(marker);
  if (start === -1) {
    throw new Error(`field "${name}" not found in generated source:\n${generatedSource}`);
  }
  let i = start + marker.length;
  let depth = 0;
  for (; i < generatedSource.length; i++) {
    const ch = generatedSource[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) break;
  }
  return generatedSource.slice(start + marker.length, i);
}

describe("verified defects (design doc section 1)", () => {
  it(
    'defect 1 (FIXED): doc-level `required` (string[] of child element names) now drives requiredness — ' +
      'uscore-patient.fhirschema.json has required:["gender","identifier","name"], and generated ' +
      '"gender" is emitted without .optional()',
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.required).toContain("gender"); // ground truth, not a mapper claim
      const generated = emitFixture("uscore-patient.fhirschema.json");
      expect(extractField(generated, "gender")).not.toMatch(/\.optional\(\)$/);
    }
  );

  it.fails(
    "defect 2: `binding.codes` never exists on real bindings (only {strength, valueSet, bindingName}) — " +
      "required-strength gender never becomes a z.enum, even though the ValueSet it references is " +
      "committed and expandable at fixtures/valuesets/ValueSet-administrative-gender.json. ValueSet " +
      "expansion is phase 3b, not this phase — still unimplemented.",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.gender?.binding).not.toHaveProperty("codes"); // ground truth
      const generated = emitFixture("uscore-patient.fhirschema.json");
      expect(extractField(generated, "gender")).toMatch(/^z\.enum\(/);
    }
  );

  it(
    'defect 3 (FIXED): `constraint` is a Record keyed by constraint id, not an array — ' +
      'uscore-patient.fhirschema.json has name.constraint["us-core-6"], and an invariant TODO marker ' +
      "is now emitted for it",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.name?.constraint).toHaveProperty("us-core-6"); // ground truth
      const generated = emitFixture("uscore-patient.fhirschema.json");
      expect(generated).toContain("TODO(invariant us-core-6)");
    }
  );

  it(
    "defect 4 (FIXED): a profile element that only narrows a base carries no type/array/min/max in the " +
      'raw document — uscore-patient.fhirschema.json\'s "name" element has no `array` field at all (it ' +
      "lives on base r4-patient) — but merge/resolveDocument fills it in from the base, so the generated " +
      "name schema keeps array:true and its leaf children (family, given) resolve to z.string(), never z.unknown()",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.name?.array).toBeUndefined(); // ground truth: profile alone doesn't carry it
      const generated = emitFixture("uscore-patient.fhirschema.json");
      const nameField = extractField(generated, "name");
      expect(nameField).toMatch(/^z\.array\(/);
      expect(nameField).not.toContain("z.unknown()");
    }
  );

  it(
    "defect 5 (partially fixed — see below): no base or cross-file resolution — " +
      'uscore-patient.fhirschema.json\'s top-level "extension" element (type:"Extension", no nested ' +
      "`elements`) used to emit a bare `ExtensionSchema` reference with no corresponding import, so the " +
      "generated file did not compile on its own. It now falls back to an honest z.unknown() with a " +
      "TODO(defect 5) marker instead (design doc section 7, \"REJECT/DO BETTER #4\": a loud gap beats a " +
      "silent one) — the file compiles. This closes the 'does not compile' consequence only. Real " +
      "cross-file imports and z.lazy() cycle emission (the other half of defect 5) are still open — " +
      "see the TODO markers themselves and this PR's description.",
    () => {
      const doc = loadFixture("uscore-patient.fhirschema.json");
      expect(doc.elements.extension?.type).toBe("Extension"); // ground truth
      expect(doc.elements.extension?.elements).toBeUndefined();
      const generated = emitFixture("uscore-patient.fhirschema.json");
      expect(generated).not.toContain("ExtensionSchema");
      expect(extractField(generated, "extension")).toContain("z.unknown()");
    }
  );
});
