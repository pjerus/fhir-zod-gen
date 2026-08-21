/**
 * Fixture-backed TerminologySource — mirrors merge/fixture-schema-source.ts's
 * shape and rationale. Deliberately NOT part of expand.ts: this file does the
 * fs reads that expand.ts must never do itself. Phase 4's package pipeline
 * will provide a real IG-package-backed TerminologySource with the exact
 * same interface; this one exists so terminology/ has something concrete to
 * be tested against today, using fixtures/valuesets/ (committed by Phase 1
 * precisely so ValueSet expansion stays offline).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodeSystemResource, ValueSetResource } from "./resources.js";
import type { TerminologySource } from "./terminology-source.js";

export class FixtureTerminologySource implements TerminologySource {
  private readonly valueSets = new Map<string, ValueSetResource>();
  private readonly codeSystems = new Map<string, CodeSystemResource>();

  constructor(resources: (ValueSetResource | CodeSystemResource)[]) {
    for (const resource of resources) {
      if (resource.resourceType === "ValueSet") {
        this.valueSets.set(resource.url, resource);
      } else if (resource.resourceType === "CodeSystem") {
        this.codeSystems.set(resource.url, resource);
      }
    }
  }

  getValueSet(url: string): ValueSetResource | undefined {
    return this.valueSets.get(url);
  }

  getCodeSystem(url: string): CodeSystemResource | undefined {
    return this.codeSystems.get(url);
  }
}

/** Loads every `ValueSet-*.json` / `CodeSystem-*.json` under `<fixturesDir>/valuesets/`. */
export function loadFixtureTerminologySource(fixturesDir: string): FixtureTerminologySource {
  const dir = join(fixturesDir, "valuesets");
  const resources: (ValueSetResource | CodeSystemResource)[] = [];

  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    resources.push(JSON.parse(readFileSync(join(dir, fileName), "utf-8")) as ValueSetResource | CodeSystemResource);
  }

  return new FixtureTerminologySource(resources);
}
