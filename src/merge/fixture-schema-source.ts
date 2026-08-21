/**
 * Fixture-backed SchemaSource — the "for now" implementation the design doc
 * asks for (section 4, Phase 2). Deliberately NOT part of resolve.ts: this
 * file does the fs reads that resolve.ts's module comment says merge/'s
 * core algorithm must never do itself. Phase 4's `resolve/` will provide a
 * real IG-package-backed SchemaSource with the exact same interface; this
 * one exists so merge/ has something concrete to be tested against today,
 * using the fixtures/ and fixtures/datatypes/ documents already committed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FhirSchemaDocument } from "../fhir-schema-types.js";
import type { SchemaSource } from "./schema-source.js";

export class FixtureSchemaSource implements SchemaSource {
  private readonly byUrl = new Map<string, FhirSchemaDocument>();
  private readonly byType = new Map<string, FhirSchemaDocument>();

  constructor(documents: FhirSchemaDocument[]) {
    for (const doc of documents) {
      this.byUrl.set(doc.url, doc);
      this.byType.set(doc.type, doc);
    }
  }

  getByUrl(url: string): FhirSchemaDocument | undefined {
    return this.byUrl.get(url);
  }

  getByType(name: string): FhirSchemaDocument | undefined {
    return this.byType.get(name);
  }
}

/**
 * Loads every base/profile fixture plus all of fixtures/datatypes/ into a
 * FixtureSchemaSource. This is the "closed set" documented in
 * scripts/build-fixtures.ts's DATATYPES constant — Extension is
 * intentionally absent (see resolve.ts's module comment).
 */
export function loadFixtureSchemaSource(fixturesDir: string): FixtureSchemaSource {
  const documents: FhirSchemaDocument[] = [];

  const topLevel = [
    "r4-patient.fhirschema.json",
    "uscore-patient.fhirschema.json",
    "uscore-blood-pressure.fhirschema.json",
    // Issue #5's multi-level base chain: us-core-blood-pressure ->
    // us-core-vital-signs -> vitalsigns -> observation.
    "uscore-vital-signs.fhirschema.json",
    "vitalsigns.fhirschema.json",
    "observation.fhirschema.json",
  ];
  for (const fileName of topLevel) {
    documents.push(readDocument(join(fixturesDir, fileName)));
  }

  const datatypesDir = join(fixturesDir, "datatypes");
  for (const fileName of readdirSync(datatypesDir)) {
    if (fileName.endsWith(".fhirschema.json")) {
      documents.push(readDocument(join(datatypesDir, fileName)));
    }
  }

  return new FixtureSchemaSource(documents);
}

function readDocument(path: string): FhirSchemaDocument {
  return JSON.parse(readFileSync(path, "utf-8")) as FhirSchemaDocument;
}
