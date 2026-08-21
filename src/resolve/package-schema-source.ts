/**
 * The real, package-backed `SchemaSource` — the Phase 4 counterpart to
 * merge/fixture-schema-source.ts, satisfying the exact same interface so
 * merge/ never learns where its documents came from.
 *
 * ## Lazy by design
 *
 * `SchemaSource` is synchronous (`getByUrl(url): FhirSchemaDocument | undefined`),
 * so everything expensive has to happen either up front or inside a sync
 * call. Up front would mean translate()-ing all 658 StructureDefinitions in
 * hl7.fhir.r4.core to answer a handful of lookups. Instead the constructor
 * only indexes `.index.json` header fields (filename/url/type/kind), and a
 * lookup reads + translates that one file on demand, memoised by path. A
 * US Core Patient resolution touches ~15 files instead of ~700.
 *
 * ## Why getByType can't just be "the entry whose `type` is T"
 *
 * `.index.json` version 1 (what hl7.fhir.r4.core#4.0.1 ships) carries no
 * `derivation`, and 397 of its 658 StructureDefinition entries have
 * `type: "Extension"` — every extension definition in R4. Keying getByType
 * on `type` alone would let `patient-birthTime` answer a lookup for the
 * Extension *type*, which is a silently-wrong-output defect of exactly the
 * kind this rebuild exists to remove.
 *
 * The rule used instead is the canonical-url convention every base
 * definition follows: the StructureDefinition *defining* type T is the one
 * published at `.../StructureDefinition/T`. Profiles get their own url
 * (`.../StructureDefinition/us-core-patient`), so they can never win. Where
 * no entry matches the convention and exactly one candidate carries the
 * type, that one is used — that covers packages defining a type at a
 * non-conventional url, without reintroducing the shadowing risk (ambiguity
 * resolves to "not found", which merge/ handles as an unexpanded concrete
 * type rather than as a wrong answer).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { translate } from "@atomic-ehr/fhirschema";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import type { SchemaSource } from "../merge/schema-source.js";
import type { PackageIndexEntry } from "./package-index.js";

/** A package that is already on disk and indexed. */
export interface LoadedPackage {
  name: string;
  version: string;
  /** Directory holding the resource files — i.e. the tarball's `package/` dir. */
  dir: string;
  entries: PackageIndexEntry[];
}

/**
 * translate()'s input type, borrowed from its own signature.
 * @atomic-ehr/fhirschema doesn't export its `StructureDefinition` type from
 * the package root, and a parsed JSON file is `unknown` to us either way —
 * this keeps the unavoidable cast in one named place instead of an `any`.
 */
type StructureDefinitionInput = Parameters<typeof translate>[0];

export interface PackageSchemaSourceOptions {
  onWarn?: (message: string) => void;
}

export class PackageSchemaSource implements SchemaSource {
  private readonly byUrl = new Map<string, string>();
  private readonly byType = new Map<string, string>();
  private readonly documents = new Map<string, FhirSchemaDocument | undefined>();
  private readonly packages: LoadedPackage[];
  private readonly onWarn: (message: string) => void;

  constructor(packages: LoadedPackage[], options: PackageSchemaSourceOptions = {}) {
    this.packages = packages;
    this.onWarn = options.onWarn ?? (() => {});

    const typeCandidates = new Map<string, string[]>();

    for (const pkg of packages) {
      for (const entry of pkg.entries) {
        if (entry.resourceType !== "StructureDefinition") continue;
        const path = join(pkg.dir, entry.filename);

        // First package wins: packages are ordered primary-then-dependencies,
        // so an IG that republishes a canonical shadows its dependency's copy.
        if (entry.url && !this.byUrl.has(entry.url)) this.byUrl.set(entry.url, path);

        if (!entry.type) continue;
        if (entry.url?.endsWith(`/StructureDefinition/${entry.type}`)) {
          if (!this.byType.has(entry.type)) this.byType.set(entry.type, path);
        } else {
          const candidates = typeCandidates.get(entry.type) ?? [];
          candidates.push(path);
          typeCandidates.set(entry.type, candidates);
        }
      }
    }

    for (const [type, candidates] of typeCandidates) {
      if (!this.byType.has(type) && candidates.length === 1) {
        this.byType.set(type, candidates[0]);
      }
    }
  }

  getByUrl(url: string): FhirSchemaDocument | undefined {
    // Canonical references may carry a version (`...|6.1.0`); the index keys
    // on the bare url, and a package holds one version of a canonical anyway.
    const bare = url.split("|")[0];
    const path = this.byUrl.get(bare);
    return path ? this.load(path) : undefined;
  }

  getByType(name: string): FhirSchemaDocument | undefined {
    const path = this.byType.get(name);
    return path ? this.load(path) : undefined;
  }

  /**
   * Every StructureDefinition in one package, translated — the CLI's input
   * for "generate this whole IG". `kinds` filters on the index's `kind`
   * field; the CLI passes ["resource"] so that extension definitions
   * (kind "complex-type", type "Extension") don't each become a file.
   */
  documentsForPackage(packageName: string, kinds?: string[]): FhirSchemaDocument[] {
    const pkg = this.packages.find((p) => p.name === packageName);
    if (!pkg) throw new Error(`Package ${packageName} was not loaded into this SchemaSource.`);

    const docs: FhirSchemaDocument[] = [];
    for (const entry of pkg.entries) {
      if (entry.resourceType !== "StructureDefinition") continue;
      if (kinds && (!entry.kind || !kinds.includes(entry.kind))) continue;
      const doc = this.load(join(pkg.dir, entry.filename));
      if (doc) docs.push(doc);
    }
    return docs;
  }

  private load(path: string): FhirSchemaDocument | undefined {
    if (this.documents.has(path)) return this.documents.get(path);

    let document: FhirSchemaDocument | undefined;
    try {
      const structureDefinition = JSON.parse(readFileSync(path, "utf-8")) as StructureDefinitionInput;
      document = translate(structureDefinition) as unknown as FhirSchemaDocument;
    } catch (err) {
      // A single unconvertible StructureDefinition must not abort a package
      // run, but it must be visible: merge/ will report the resulting
      // missing base as a hard error, and this says which file caused it.
      this.onWarn(`Could not convert ${path} to FHIR Schema: ${err instanceof Error ? err.message : String(err)}`);
      document = undefined;
    }

    this.documents.set(path, document);
    return document;
  }
}
