import { describe, expect, it } from "vitest";
import { formatPackageSpec, looksLikePackageSpec, parsePackageSpec } from "./package-spec.js";

describe("parsePackageSpec", () => {
  it("splits the FHIR `#` form", () => {
    expect(parsePackageSpec("hl7.fhir.us.core#6.1.0")).toEqual({ id: "hl7.fhir.us.core", version: "6.1.0" });
  });

  it("accepts the npm `@` form the registry also serves", () => {
    expect(parsePackageSpec("hl7.fhir.r4.core@4.0.1")).toEqual({ id: "hl7.fhir.r4.core", version: "4.0.1" });
  });

  it("leaves the version off when none is given", () => {
    expect(parsePackageSpec("hl7.fhir.us.core")).toEqual({ id: "hl7.fhir.us.core" });
  });

  it("rejects a separator with no version rather than silently meaning `latest`", () => {
    expect(() => parsePackageSpec("hl7.fhir.us.core#")).toThrow(/no version/);
  });

  it("rejects something that is not a package id", () => {
    expect(() => parsePackageSpec("./fixtures")).toThrow(/not a FHIR package identifier/);
  });
});

describe("looksLikePackageSpec", () => {
  it.each(["hl7.fhir.us.core#6.1.0", "hl7.fhir.us.core", "us.nlm.vsac@0.11.0", "ihe.formatcode.fhir"])(
    "treats %s as a package",
    (input) => {
      expect(looksLikePackageSpec(input)).toBe(true);
    }
  );

  it.each([
    "./examples/patient.fhirschema.json",
    "examples/patient.fhirschema.json",
    "patient.fhirschema.json",
    "generated",
    "../fhir-schemas/us-core",
  ])("treats %s as a path", (input) => {
    expect(looksLikePackageSpec(input)).toBe(false);
  });
});

describe("formatPackageSpec", () => {
  it("round-trips through the `#` form", () => {
    expect(formatPackageSpec(parsePackageSpec("hl7.fhir.us.core#6.1.0"))).toBe("hl7.fhir.us.core#6.1.0");
  });

  it("omits the separator when there is no version", () => {
    expect(formatPackageSpec({ id: "hl7.fhir.us.core" })).toBe("hl7.fhir.us.core");
  });
});
