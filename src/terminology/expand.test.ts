import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expandValueSet } from "./expand.js";
import { loadFixtureTerminologySource, FixtureTerminologySource } from "./fixture-terminology-source.js";
import type { CodeSystemResource, ValueSetResource } from "./resources.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

describe("expandValueSet — fixture-backed (committed fixtures/valuesets/)", () => {
  const source = loadFixtureTerminologySource(FIXTURES_DIR);

  it("expands administrative-gender (system, no explicit concept list) to all CodeSystem codes, in source order", () => {
    const result = expandValueSet("http://hl7.org/fhir/ValueSet/administrative-gender", source);
    expect(result).toEqual({ ok: true, codes: ["male", "female", "other", "unknown"] });
  });

  it("strips a `|version` suffix off the ValueSet URL before lookup", () => {
    const result = expandValueSet("http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1", source);
    expect(result).toEqual({ ok: true, codes: ["male", "female", "other", "unknown"] });
  });

  it("expands contact-point-use", () => {
    const result = expandValueSet("http://hl7.org/fhir/ValueSet/contact-point-use", source);
    expect(result.ok).toBe(true);
    expect(result.ok && result.codes).toEqual(["home", "work", "temp", "old", "mobile"]);
  });

  it("degrades (does not throw) for a ValueSet absent from the source, with a descriptive reason", () => {
    const result = expandValueSet("http://hl7.org/fhir/ValueSet/link-type", source);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/not found/);
  });
});

describe("expandValueSet — synthetic sources (edge cases not present in the committed fixtures)", () => {
  function sourceWith(resources: (ValueSetResource | CodeSystemResource)[]): FixtureTerminologySource {
    return new FixtureTerminologySource(resources);
  }

  it("uses an explicit compose.include.concept list verbatim, without needing the CodeSystem", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/explicit",
      compose: { include: [{ system: "http://example.org/cs/unresolved", concept: [{ code: "a" }, { code: "b" }] }] },
    };
    const result = expandValueSet(vs.url, sourceWith([vs]));
    expect(result).toEqual({ ok: true, codes: ["a", "b"] });
  });

  it("recurses into nested CodeSystem concept children and skips abstract classification codes", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/hierarchical",
      compose: { include: [{ system: "http://example.org/cs/hierarchical" }] },
    };
    const cs: CodeSystemResource = {
      resourceType: "CodeSystem",
      url: "http://example.org/cs/hierarchical",
      concept: [
        {
          code: "root",
          abstract: true,
          concept: [{ code: "child-a" }, { code: "child-b", concept: [{ code: "grandchild" }] }],
        },
      ],
    };
    const result = expandValueSet(vs.url, sourceWith([vs, cs]));
    expect(result).toEqual({ ok: true, codes: ["child-a", "child-b", "grandchild"] });
  });

  it("degrades when the ValueSet itself is not found", () => {
    const result = expandValueSet("http://example.org/vs/missing", sourceWith([]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('ValueSet "http://example.org/vs/missing" not found');
  });

  it("degrades when compose.include references a system with no matching CodeSystem", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/orphan",
      compose: { include: [{ system: "http://example.org/cs/nowhere" }] },
    };
    const result = expandValueSet(vs.url, sourceWith([vs]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('CodeSystem "http://example.org/cs/nowhere" not found');
  });

  it("degrades on compose.exclude — never silently ignored", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/excluding",
      compose: {
        include: [{ system: "http://example.org/cs/x" }],
        exclude: [{ system: "http://example.org/cs/x", concept: [{ code: "banned" }] }],
      },
    };
    const cs: CodeSystemResource = {
      resourceType: "CodeSystem",
      url: "http://example.org/cs/x",
      concept: [{ code: "a" }, { code: "banned" }],
    };
    const result = expandValueSet(vs.url, sourceWith([vs, cs]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("compose.exclude");
  });

  it("degrades on an intensional filter, rather than expanding an unfiltered superset", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/filtered",
      compose: { include: [{ system: "http://example.org/cs/x", filter: [{ property: "concept", op: "is-a", value: "root" }] }] },
    };
    const result = expandValueSet(vs.url, sourceWith([vs]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/filter/);
  });

  it("degrades when a ValueSet has no compose at all (e.g. purely intensional/external)", () => {
    const vs: ValueSetResource = { resourceType: "ValueSet", url: "http://example.org/vs/no-compose" };
    const result = expandValueSet(vs.url, sourceWith([vs]));
    expect(result.ok).toBe(false);
  });

  it("degrades on a compose.include entry with neither system nor concept (e.g. composing another ValueSet by reference)", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/composed",
      compose: { include: [{ valueSet: ["http://example.org/vs/other"] }] },
    };
    const result = expandValueSet(vs.url, sourceWith([vs]));
    expect(result.ok).toBe(false);
  });

  it("never returns a partial code list when one of several include entries fails", () => {
    const vs: ValueSetResource = {
      resourceType: "ValueSet",
      url: "http://example.org/vs/mixed",
      compose: {
        include: [{ system: "http://example.org/cs/good" }, { system: "http://example.org/cs/missing" }],
      },
    };
    const cs: CodeSystemResource = { resourceType: "CodeSystem", url: "http://example.org/cs/good", concept: [{ code: "a" }] };
    const result = expandValueSet(vs.url, sourceWith([vs, cs]));
    expect(result.ok).toBe(false);
  });
});
