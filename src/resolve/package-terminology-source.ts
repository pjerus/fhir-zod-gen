/**
 * The real, package-backed `TerminologySource` — the Phase 4 counterpart to
 * terminology/fixture-terminology-source.ts, satisfying the exact same
 * interface so terminology/expand.ts never learns where its ValueSets and
 * CodeSystems came from. Sibling of package-schema-source.ts: same
 * `.index.json`-driven discovery, same lazy + memoised load-on-demand shape.
 *
 * ## Whole closure, not just the primary package
 *
 * A profile package (e.g. hl7.fhir.us.core) narrows bindings but rarely ships
 * the ValueSets/CodeSystems those bindings point at itself — they live in
 * upstream/terminology dependencies pulled in by the same
 * `installPackageClosure` that already feeds PackageSchemaSource. This class
 * takes the identical `packages` array (primary first, then its dependency
 * closure breadth-first) and indexes every ValueSet/CodeSystem across all of
 * them, so a required binding resolves regardless of which package in the
 * closure actually published it.
 *
 * ## Not found is not fatal
 *
 * A ValueSet or CodeSystem missing from the closure isn't an error here —
 * `getValueSet`/`getCodeSystem` just return `undefined`, same as an absent
 * map entry would. expand.ts turns that into an `ExpansionResult` failure,
 * and emit.ts turns that into the existing degrade-to-primitive + TODO
 * marker path (defect 2's conformance rule: never a partial enum).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeSystemResource, TerminologySource, ValueSetResource } from "../terminology/index.js";
import type { LoadedPackage } from "./package-schema-source.js";

export interface PackageTerminologySourceOptions {
  onWarn?: (message: string) => void;
}

export class PackageTerminologySource implements TerminologySource {
  private readonly valueSetPaths = new Map<string, string>();
  private readonly codeSystemPaths = new Map<string, string>();
  private readonly valueSets = new Map<string, ValueSetResource | undefined>();
  private readonly codeSystems = new Map<string, CodeSystemResource | undefined>();
  private readonly onWarn: (message: string) => void;

  constructor(packages: LoadedPackage[], options: PackageTerminologySourceOptions = {}) {
    this.onWarn = options.onWarn ?? (() => {});

    for (const pkg of packages) {
      for (const entry of pkg.entries) {
        if (!entry.url) continue;
        // First package wins, same rule as PackageSchemaSource: packages are
        // ordered primary-then-dependencies, so an IG that republishes a
        // canonical shadows its dependency's copy.
        if (entry.resourceType === "ValueSet") {
          if (!this.valueSetPaths.has(entry.url)) this.valueSetPaths.set(entry.url, join(pkg.dir, entry.filename));
        } else if (entry.resourceType === "CodeSystem") {
          if (!this.codeSystemPaths.has(entry.url)) this.codeSystemPaths.set(entry.url, join(pkg.dir, entry.filename));
        }
      }
    }
  }

  getValueSet(url: string): ValueSetResource | undefined {
    // Canonical references may carry a version (`...|4.0.1`); the index keys
    // on the bare url, same convention as PackageSchemaSource.getByUrl.
    const bare = url.split("|")[0];
    if (this.valueSets.has(bare)) return this.valueSets.get(bare);

    const path = this.valueSetPaths.get(bare);
    const resource = path ? this.load<ValueSetResource>(path, "ValueSet") : undefined;
    this.valueSets.set(bare, resource);
    return resource;
  }

  getCodeSystem(url: string): CodeSystemResource | undefined {
    const bare = url.split("|")[0];
    if (this.codeSystems.has(bare)) return this.codeSystems.get(bare);

    const path = this.codeSystemPaths.get(bare);
    const resource = path ? this.load<CodeSystemResource>(path, "CodeSystem") : undefined;
    this.codeSystems.set(bare, resource);
    return resource;
  }

  private load<T>(path: string, kind: string): T | undefined {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as T;
    } catch (err) {
      // A single unparseable resource must not abort a run — expand.ts's
      // caller (emit.ts) already has a degrade path for "not found"; this
      // just makes the reason visible instead of silent.
      this.onWarn(`Could not read ${kind} at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
