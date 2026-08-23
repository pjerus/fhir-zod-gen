import { describe, it, expect } from "vitest";
import { compositeSchemaSource } from "./composite-schema-source.js";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import type { SchemaSource } from "./schema-source.js";

function doc(name: string, url: string): FhirSchemaDocument {
  return { name, url, elements: {} } as FhirSchemaDocument;
}

function sourceOf(entries: Record<string, FhirSchemaDocument>, byType: Record<string, FhirSchemaDocument> = {}): SchemaSource {
  return {
    getByUrl: (url) => entries[url],
    getByType: (name) => byType[name],
  };
}

describe("compositeSchemaSource", () => {
  const patientA = doc("Patient", "http://example.org/Patient");
  const patientB = doc("PatientOther", "http://example.org/Patient");

  it("finds a document held by any member", () => {
    const a = sourceOf({ "http://example.org/A": doc("A", "http://example.org/A") });
    const b = sourceOf({ "http://example.org/B": doc("B", "http://example.org/B") });
    const composite = compositeSchemaSource([a, b]);
    expect(composite.getByUrl("http://example.org/A")?.name).toBe("A");
    expect(composite.getByUrl("http://example.org/B")?.name).toBe("B");
  });

  it("resolves a conflict to the leftmost input, not to iteration order", () => {
    // Real shape: davinci-pas' closure carries three US Core versions. The
    // rule has to be predictable from the command that was run.
    const composite = compositeSchemaSource([
      sourceOf({ "http://example.org/Patient": patientA }),
      sourceOf({ "http://example.org/Patient": patientB }),
    ]);
    expect(composite.getByUrl("http://example.org/Patient")?.name).toBe("Patient");
  });

  it("applies the same rule to getByType", () => {
    const composite = compositeSchemaSource([
      sourceOf({}, { HumanName: doc("HumanName", "http://example.org/first") }),
      sourceOf({}, { HumanName: doc("HumanName", "http://example.org/second") }),
    ]);
    expect(composite.getByType("HumanName")?.url).toBe("http://example.org/first");
  });

  it("returns undefined rather than throwing when nothing has it", () => {
    const composite = compositeSchemaSource([sourceOf({}), sourceOf({})]);
    expect(composite.getByUrl("http://example.org/missing")).toBeUndefined();
    expect(composite.getByType("Nothing")).toBeUndefined();
  });

  it("is a no-op wrapper over a single source", () => {
    const only = sourceOf({ "http://example.org/A": doc("A", "http://example.org/A") });
    expect(compositeSchemaSource([only]).getByUrl("http://example.org/A")?.name).toBe("A");
  });

  it("survives being given nothing", () => {
    expect(compositeSchemaSource([]).getByUrl("http://example.org/A")).toBeUndefined();
  });
});
