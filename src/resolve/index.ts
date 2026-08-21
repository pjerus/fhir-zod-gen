/**
 * `resolve/` — the I/O half of the pipeline (design doc section 3): fetch an
 * IG package, index it, convert its StructureDefinitions to FHIR Schema, and
 * hand merge/ a `SchemaSource` it can query synchronously.
 *
 * Everything network- and disk-facing stops here. merge/ and emit/ stay pure
 * and fixture-tested; the only thing that crosses the seam is the
 * `SchemaSource` interface in merge/schema-source.ts, which this module
 * implements without modifying.
 */

import { installPackageClosure, type InstallOptions } from "./install.js";
import { PackageSchemaSource, type LoadedPackage } from "./package-schema-source.js";
import { PackageTerminologySource } from "./package-terminology-source.js";
import { parsePackageSpec, type PackageSpec } from "./package-spec.js";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";

export type { InstallOptions, InstalledClosure } from "./install.js";
export type { LoadedPackage } from "./package-schema-source.js";
export type { PackageIndexEntry, PackageManifest } from "./package-index.js";
export type { PackageSpec } from "./package-spec.js";
export type { ClosureEntry, ClosurePreview } from "./closure-preview.js";
export type { ClosureNode } from "./closure.js";
export { PackageSchemaSource } from "./package-schema-source.js";
export { PackageTerminologySource } from "./package-terminology-source.js";
export { readPackageIndex, readPackageManifest } from "./package-index.js";
export { installPackageClosure } from "./install.js";
export { previewPackageClosure } from "./closure-preview.js";
export { isKnownTerminologyPackage } from "./closure.js";
export { parsePackageSpec, looksLikePackageSpec, formatPackageSpec } from "./package-spec.js";

export interface ResolvedPackage {
  spec: PackageSpec;
  /** Backed by the whole dependency closure, not just the requested package. */
  source: PackageSchemaSource;
  /**
   * Backed by the whole dependency closure too — a profile package's own
   * required bindings often point at ValueSets/CodeSystems published by its
   * terminology dependencies, not by itself (issue #10).
   */
  terminology: PackageTerminologySource;
  /** The requested package as indexed — its `entries` are every resource it ships. */
  primary: LoadedPackage;
  /**
   * The requested package's own resource StructureDefinitions, converted.
   * Profiles as published: still to be merged over their bases by merge/.
   */
  documents: FhirSchemaDocument[];
}

/**
 * Resolve a package identifier (`hl7.fhir.us.core#6.1.0`, or a bare id for
 * the registry's `latest`) into everything the generator needs.
 */
export async function resolvePackage(
  identifier: string | PackageSpec,
  options: InstallOptions = {}
): Promise<ResolvedPackage> {
  const spec = typeof identifier === "string" ? parsePackageSpec(identifier) : identifier;
  const { primary, packages } = await installPackageClosure(spec, options);

  const source = new PackageSchemaSource(packages, { onWarn: options.onWarn });
  const terminology = new PackageTerminologySource(packages, { onWarn: options.onWarn });

  return {
    spec: { id: primary.name, version: primary.version },
    source,
    terminology,
    primary,
    // "resource" only: extension definitions (kind "complex-type", type
    // "Extension") are handled by emit/'s extension path per the design
    // doc's Phase 3 section, not emitted as standalone schema files.
    documents: source.documentsForPackage(primary.name, ["resource"]),
  };
}
