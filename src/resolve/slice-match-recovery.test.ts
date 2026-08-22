/**
 * Issue #32. Inputs are raw StructureDefinitions committed under
 * fixtures/raw/ — converter *input*, not the converter *output* every other
 * fixture holds, because recovery exists precisely to read what the
 * conversion didn't carry across.
 *
 * Each fixture isolates one shape; see scripts/build-fixtures.ts step 7 for
 * why these three definitions specifically.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { translate } from "@atomic-ehr/fhirschema";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import { recoverSliceMatches } from "./slice-match-recovery.js";

function rawFixture(fileName: string): unknown {
  return JSON.parse(readFileSync(join("fixtures", "raw", fileName), "utf-8"));
}

/** The raw definition plus its own conversion — recovery's two inputs. */
function convert(fileName: string): { raw: unknown; document: FhirSchemaDocument } {
  const raw = rawFixture(fileName);
  return { raw, document: translate(raw as Parameters<typeof translate>[0]) as unknown as FhirSchemaDocument };
}

describe("recoverSliceMatches", () => {
  it("recovers an extension slice's match from the `url` fixed value one level down", () => {
    const { raw, document } = convert("StructureDefinition-patient-citizenship.json");
    const slices = document.elements?.extension?.slicing?.slices ?? {};
    expect(slices.code?.match, "precondition: the converter left this empty").toEqual({});

    recoverSliceMatches(raw, document);

    // Raw: `Extension.extension:code.url` carries fixedUri "code".
    expect(slices.code?.match).toEqual({ url: "code" });
    expect(slices.period?.match).toEqual({ url: "period" });
  });

  it("recovers a slice-head pattern the converter overwrote with its cycle sentinel", () => {
    const { raw, document } = convert("StructureDefinition-us-core-observation-lab.json");
    const slices = document.elements?.category?.slicing?.slices ?? {};
    expect(slices["us-core"]?.schema?.pattern, "precondition: the converter's own copy is corrupted").toBe(
      "[Circular Reference]"
    );

    recoverSliceMatches(raw, document);

    // Raw: `Observation.category:us-core` carries patternCodeableConcept
    // directly, so the whole pattern value is the match.
    expect(slices["us-core"]?.match).toEqual({
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }],
    });
  });

  it("leaves a slice with no discriminating pattern unrecovered rather than inventing one", () => {
    const { raw, document } = convert("StructureDefinition-example-composition.json");

    const recovered = recoverSliceMatches(raw, document);

    expect(recovered).toBe(0);
    const slices = document.elements?.section?.slicing?.slices ?? {};
    for (const name of ["procedure", "medications", "plan"]) {
      expect(slices[name]?.match, `slice "${name}" must stay unmatched`).toEqual({});
    }
  });

  it("never overwrites a match the converter did populate", () => {
    const { raw, document } = convert("StructureDefinition-patient-citizenship.json");
    const slices = document.elements?.extension?.slicing?.slices ?? {};
    slices.code!.match = { url: "converter-supplied" };

    recoverSliceMatches(raw, document);

    expect(slices.code?.match).toEqual({ url: "converter-supplied" });
  });

  it("reports how many slices it filled in", () => {
    const { raw, document } = convert("StructureDefinition-patient-citizenship.json");

    expect(recoverSliceMatches(raw, document)).toBe(2);
  });
});

/**
 * Breadth, against whatever real packages the local cache happens to hold.
 * Skips cleanly on an empty cache the same way examples.test.ts does, so the
 * suite stays hermetic; the fixtures above are what CI actually exercises.
 *
 * The assertion is one-directional on purpose — recovery must not *lose*
 * ground, but a converter upgrade that starts populating `match` itself
 * would legitimately drive our own recovery count down, and that should not
 * fail a build.
 */
const CACHE_DIR = join(homedir(), ".fhir", "packages");
const BREADTH_PACKAGE = "hl7.fhir.uv.genomics-reporting#2.0.0";
const breadthDir = join(CACHE_DIR, BREADTH_PACKAGE, "package");

describe.skipIf(!existsSync(breadthDir))(`recovery breadth — ${BREADTH_PACKAGE}`, () => {
  it("recovers the child-level `code` patterns this IG discriminates its component slices by", () => {
    let recovered = 0;
    let sliceHeads = 0;

    for (const fileName of readdirSync(breadthDir)) {
      if (!fileName.startsWith("StructureDefinition-") || !fileName.endsWith(".json")) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(breadthDir, fileName), "utf-8"));
      } catch {
        continue;
      }
      if ((raw as { resourceType?: string }).resourceType !== "StructureDefinition") continue;

      let document: FhirSchemaDocument;
      try {
        document = translate(raw as Parameters<typeof translate>[0]) as unknown as FhirSchemaDocument;
      } catch {
        continue;
      }

      const countSlices = (elements: FhirSchemaDocument["elements"] | undefined): void => {
        for (const element of Object.values(elements ?? {})) {
          sliceHeads += Object.keys(element.slicing?.slices ?? {}).length;
          countSlices(element.elements);
        }
      };
      countSlices(document.elements);
      recovered += recoverSliceMatches(raw, document);
    }

    console.log(`${BREADTH_PACKAGE}: recovered ${recovered} slice match patterns across ${sliceHeads} slices`);
    expect(recovered).toBeGreaterThanOrEqual(30);
  });
});
