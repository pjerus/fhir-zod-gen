/**
 * Unit coverage for slicing -> Zod, per docs/design/slicing-design.md.
 *
 * The runtime semantic gate (a conformant Observation parsing, a
 * non-conformant one being rejected by the emitted `.superRefine`) lives in
 * regression.test.ts, which already generates fixtures to disk and imports
 * them — asserting on source strings alone would prove the code looks right,
 * not that it validates right.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emitDocument } from "./emit.js";
import { sliceChecksFor } from "./slicing.js";
import { resolveDocument } from "../merge/resolve.js";
import { loadFixtureSchemaSource } from "../merge/fixture-schema-source.js";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import type { ResolvedElement } from "../merge/index.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
const source = loadFixtureSchemaSource(FIXTURES_DIR);

function resolveFixture(fileName: string) {
  const doc = JSON.parse(readFileSync(join(FIXTURES_DIR, fileName), "utf-8")) as FhirSchemaDocument;
  return resolveDocument(doc, source);
}

function checks(el: ResolvedElement | undefined, name: string) {
  const warnings: string[] = [];
  return { result: sliceChecksFor(name, el!, warnings), warnings };
}

describe("sliceChecksFor — pattern/value discriminators", () => {
  it("takes the pattern from the converter's pre-combined `match`, for a sub-path discriminator", () => {
    // us-core-blood-pressure's `component`, discriminator {type:"pattern",
    // path:"code"} — `match` arrives wrapped under the discriminator's path.
    const { result } = checks(resolveFixture("uscore-blood-pressure.fhirschema.json").elements.component, "component");
    expect(result.map((c) => c.name).sort()).toEqual(["diastolic", "systolic"]);
    const systolic = result.find((c) => c.name === "systolic")!;
    expect(systolic.pattern).toEqual({ code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] } });
    expect(systolic.min).toBe(1);
    expect(systolic.max).toBe(1);
  });

  it("handles a `$this` discriminator identically — the bare pattern, no path wrapper, no branching", () => {
    const { result } = checks(
      resolveFixture("uscore-observation-pregnancystatus.fhirschema.json").elements.category,
      "category"
    );
    expect(result).toHaveLength(1);
    expect(result[0].pattern).toEqual({
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "social-history" }],
    });
    // No `min` on this slice: absent means 0, not "unset".
    expect(result[0].min).toBe(0);
    expect(result[0].max).toBe(1);
  });
});

describe("sliceChecksFor — extension slicing", () => {
  it("synthesizes a {url} pattern, since every extension slice's `match` is empty and the url is on `schema`", () => {
    const { result } = checks(resolveFixture("uscore-patient.fhirschema.json").elements.extension, "extension");
    const race = result.find((c) => c.name === "race")!;
    expect(race.pattern).toEqual({ url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race" });
    expect(race.max).toBe(1);
  });

  it("drops slices that constrain nothing (min 0, unbounded max) rather than emitting dead checks", () => {
    // us-core-patient's tribalAffiliation and genderIdentity are 0..* — a
    // check for them can never fail, and the generated file is meant to be
    // read.
    const { result } = checks(resolveFixture("uscore-patient.fhirschema.json").elements.extension, "extension");
    expect(result.map((c) => c.name).sort()).toEqual(["birthsex", "ethnicity", "race", "sex"]);
  });
});

describe("sliceChecksFor — degrading safely", () => {
  function sliced(slices: Record<string, unknown>): ResolvedElement {
    return {
      type: "CodeableConcept",
      array: true,
      min: 0,
      max: undefined,
      required: false,
      slicing: { slices } as ResolvedElement["slicing"],
    };
  }

  it("skips a slice whose pattern carries the converter's [Circular Reference] sentinel, with a warning", () => {
    // The hazard in the design doc's section 7. Comparing real data against
    // the literal string is silently-always-false, and worse, looks like a
    // passing test if anyone ever hand-authors it as "expected".
    const warnings: string[] = [];
    const result = sliceChecksFor(
      "category",
      sliced({ bad: { match: { coding: ["[Circular Reference]"] }, min: 1 } }),
      warnings
    );
    expect(result).toEqual([]);
    expect(warnings.join()).toContain("[Circular Reference]");
  });

  it("skips a slice with neither a usable `match` nor a url, rather than matching everything", () => {
    // An empty pattern deep-matches every element, which would turn a `min`
    // into "the array is non-empty" and a `max` into a false rejection.
    const warnings: string[] = [];
    expect(sliceChecksFor("category", sliced({ mystery: { match: {}, min: 1, max: 1 } }), warnings)).toEqual([]);
    expect(warnings.join()).toContain("mystery");
  });

  it("returns nothing for an element that isn't an array — slice counting is an array-level idea", () => {
    const { result } = checks(
      { type: "CodeableConcept", array: false, min: 0, max: undefined, required: false,
        slicing: { slices: { a: { match: { x: 1 } }, } } as ResolvedElement["slicing"] },
      "category"
    );
    expect(result).toEqual([]);
  });
});

describe("emitted slicing source", () => {
  it("layers .superRefine() on the array, after the array's own .min(), and emits the matcher helper once", () => {
    const { source: src } = emitDocument(resolveFixture("uscore-blood-pressure.fhirschema.json"));
    expect(src).toContain(".min(2)");
    expect(src).toContain("__fhirSliceMatches");
    expect(src).toMatch(/function __fhirSliceMatches/);
    // Helper is declared exactly once per file even though two slices use it.
    expect(src.match(/function __fhirSliceMatches/g)).toHaveLength(1);
    expect(src).toContain('"8480-6"');
    expect(src).toContain('slice "systolic"');
  });

  it("emits no matcher helper at all for a document with no enforceable slices", () => {
    const { source: src } = emitDocument(resolveFixture("r4-patient.fhirschema.json"));
    expect(src).not.toContain("__fhirSliceMatches");
  });

  it("reads the slice pattern from `match`, never from the corrupted inner schema.pattern", () => {
    const { source: src } = emitDocument(resolveFixture("uscore-blood-pressure.fhirschema.json"));
    expect(src).not.toContain("[Circular Reference]");
  });
});
