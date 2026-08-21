/**
 * NETWORK TEST — skipped unless FHIR_ZOD_NETWORK_TESTS=1.
 *
 * `npm test` (and therefore CI) must stay hermetic and fast, so this never
 * runs by default. Run it by hand after touching resolve/:
 *
 *   FHIR_ZOD_NETWORK_TESTS=1 npx vitest run src/resolve/registry.integration.test.ts
 *
 * First run downloads hl7.fhir.us.core#6.1.0 plus its declared dependency
 * closure into the FHIR package cache (a few hundred MB, ~1 minute); later
 * runs read the cache. Point it elsewhere with FHIR_ZOD_CACHE_DIR.
 *
 * What it proves that the offline tests can't: that a *real* registry
 * package, resolved through the real dependency closure, satisfies merge/ —
 * i.e. the Phase 2 gate ("US Core Patient must resolve to concrete types
 * with name.array === true") holds on live package data, not just on the
 * committed fixtures.
 */

import { describe, expect, it } from "vitest";
import { resolveDocument } from "../merge/index.js";
import { resolvePackage } from "./index.js";

const enabled = process.env.FHIR_ZOD_NETWORK_TESTS === "1";

describe.skipIf(!enabled)("resolvePackage against the live registry", () => {
  it(
    "resolves US Core Patient to concrete types through the package-backed SchemaSource",
    async () => {
      const { spec, source, documents } = await resolvePackage("hl7.fhir.us.core#6.1.0", {
        cacheDir: process.env.FHIR_ZOD_CACHE_DIR,
      });

      expect(spec).toEqual({ id: "hl7.fhir.us.core", version: "6.1.0" });

      const profile = documents.find((d) => d.url.endsWith("/us-core-patient"));
      expect(profile?.base).toBe("http://hl7.org/fhir/StructureDefinition/Patient");

      // The base resource comes from hl7.fhir.r4.core — a *different*
      // package, reached only because the dependency closure was installed
      // and indexed. Without it resolveDocument throws.
      const resolved = resolveDocument(profile!, source);
      expect(resolved.elements.name?.type).toBe("HumanName");
      expect(resolved.elements.name?.array).toBe(true);
      expect(resolved.elements.name?.required).toBe(true);
      expect(Object.keys(resolved.elements.name?.elements ?? {})).toContain("family");
    },
    10 * 60 * 1000
  );
});
