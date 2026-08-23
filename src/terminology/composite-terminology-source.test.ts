import { describe, it, expect } from "vitest";
import { compositeTerminologySource } from "./composite-terminology-source.js";
import type { CodeSystemResource, ValueSetResource } from "./resources.js";
import type { TerminologySource } from "./terminology-source.js";

function sourceOf(
  valueSets: Record<string, ValueSetResource> = {},
  codeSystems: Record<string, CodeSystemResource> = {}
): TerminologySource {
  return {
    getValueSet: (url) => valueSets[url],
    getCodeSystem: (url) => codeSystems[url],
  };
}

const vsA = { resourceType: "ValueSet", url: "http://example.org/vs", name: "A" } as unknown as ValueSetResource;
const vsB = { resourceType: "ValueSet", url: "http://example.org/vs", name: "B" } as unknown as ValueSetResource;
const csA = { resourceType: "CodeSystem", url: "http://example.org/cs", name: "A" } as unknown as CodeSystemResource;

describe("compositeTerminologySource", () => {
  it("finds a ValueSet held by any member", () => {
    const composite = compositeTerminologySource([sourceOf(), sourceOf({ "http://example.org/vs": vsA })]);
    expect(composite.getValueSet("http://example.org/vs")).toBe(vsA);
  });

  it("takes the leftmost when two packages publish the same canonical", () => {
    // Deliberately does NOT reconcile: a wrong reconciliation emits a z.enum
    // that rejects conformant data.
    const composite = compositeTerminologySource([
      sourceOf({ "http://example.org/vs": vsA }),
      sourceOf({ "http://example.org/vs": vsB }),
    ]);
    expect(composite.getValueSet("http://example.org/vs")).toBe(vsA);
  });

  it("applies the same rule to CodeSystems, and returns undefined for a miss", () => {
    const composite = compositeTerminologySource([sourceOf({}, { "http://example.org/cs": csA })]);
    expect(composite.getCodeSystem("http://example.org/cs")).toBe(csA);
    expect(composite.getCodeSystem("http://example.org/nope")).toBeUndefined();
  });
});
