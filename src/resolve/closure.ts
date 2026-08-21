/**
 * Walking a package's dependency graph via registry metadata only — no
 * tarball downloads. Shared by closure-preview.ts (issue #9: show the user
 * what's about to be pulled down before pulling it) and install.ts's
 * `--skip-terminology` path (which needs to decide what to download
 * *before* downloading it, not after).
 *
 * `fhir-package-installer`'s `getDependencies(pkg, {includePlanningFallbacks:
 * true})` reads a package's `dependencies` from whichever is cheapest:
 * its own already-cached package.json, or (when nothing is cached yet) the
 * registry's per-version metadata — a small JSON document, not the tarball.
 * Verified against the real registry (packages.fhir.org): a version's
 * metadata carries only name/version/dist/fhirVersion/url — no size, no
 * `type` — which is also why closure-preview.ts can't report a size for a
 * not-yet-cached package without downloading it (see its module comment).
 *
 * ## Why versions are pinned by first sighting, not per-call reconciliation
 *
 * Different branches of a real closure can declare the same dependency id at
 * different versions — e.g. `hl7.terminology.r4` and `hl7.fhir.uv.extensions.r4`
 * are implicit dependencies of every `hl7.fhir.rX.core` package, resolved
 * independently of whatever version another branch might name explicitly.
 * The installer *can* reconcile this internally (passing `rootPackage` to
 * `getDependencies` triggers its own closure-wide pinning pass), but that
 * pinning is rebuilt from scratch on every single call and isn't guaranteed
 * consistent across calls when a version comes from implicit resolution
 * rather than an explicit declaration — verified: walking
 * `hl7.fhir.uv.smart-app-launch#1.0.0` with `rootPackage` set on every call
 * still surfaced `hl7.terminology.r4` at two different versions (7.1.0 and
 * 7.3.0) because different call sites resolved its implicit version
 * differently. (`hl7.fhir.us.core#6.1.0` didn't show this, because it
 * happens to declare both packages explicitly at the root — the very first
 * thing visited — so there was nothing left to reconcile.)
 *
 * The fix here is simpler than leaning on the installer's internal
 * reconciliation at all: this walker pins a version the first time it sees
 * an id (breadth-first, so the closest declaration wins) and calls
 * `getDependencies` for that id's own dependencies exactly once, ever. A
 * later branch naming a different version for an already-pinned id is
 * ignored rather than explored as a second node. This is fully self-
 * contained — no dependency on cross-call consistency inside the installer —
 * and incidentally cheaper too, since no id's dependencies are fetched twice.
 */

import type { FhirPackageInstaller } from "fhir-package-installer";

export interface ClosureNode {
  id: string;
  version: string;
}

/**
 * Known terminology-only packages — no schema resolution depends on them,
 * only ValueSet/CodeSystem expansion does. This is a curated identity list,
 * not a content classifier: the registry doesn't expose a package's `type`
 * or resource-type breakdown without downloading it (see this file's module
 * comment), so there is no honest way to *detect* "terminology-only" before
 * downloading — only to *recognize* specific packages known to be that by
 * publisher convention.
 *
 * Verified against a real hl7.fhir.us.core#6.1.0 install: `us.nlm.vsac`
 * (272 MB) and `us.cdc.phinvads` (117 MB) both self-declare
 * `"type": "Conformance"` and ship nothing but ValueSets. `hl7.terminology.*`
 * (60-70 MB depending on version) self-declares `"type": "IG"` instead, but
 * its only StructureDefinitions are 9 internal Extension-kind definitions
 * used by its own ValueSets/NamingSystems — never a base type or profile
 * base that merge/ would need to resolve another package's elements.
 *
 * This list is conservative by construction: a terminology-only package not
 * on it is simply never skipped (its download still counts against
 * --skip-terminology's savings estimate as "not classified"), not silently
 * misclassified the other way.
 */
const KNOWN_TERMINOLOGY_PACKAGE_IDS = /^(us\.nlm\.vsac|us\.cdc\.phinvads|hl7\.terminology(\..+)?)$/;

export function isKnownTerminologyPackage(id: string): boolean {
  return KNOWN_TERMINOLOGY_PACKAGE_IDS.test(id);
}

export interface WalkDependencyClosureOptions {
  /**
   * When it returns true for a dependency id, that dependency (and anything
   * only reachable through it) is left out of the walk entirely — it's
   * never enqueued, so its own `getDependencies` is never called either.
   * `primary` itself is never excluded by this, only its dependencies.
   */
  excludeDependency?: (id: string) => boolean;
}

/**
 * Breadth-first walk of `primary`'s dependency closure using registry
 * metadata only. Mirrors install.ts's hardcoded `skipExamples: true`
 * (an implicit `*.examples` dependency is never useful to codegen) in
 * addition to whatever `excludeDependency` the caller supplies.
 *
 * Pins each id to the version it's first discovered at (see this file's
 * module comment for why) — a package id never appears twice in the result,
 * even if a deeper branch of the graph declares it at a different version.
 */
export async function walkDependencyClosure(
  installer: FhirPackageInstaller,
  primary: ClosureNode,
  options: WalkDependencyClosureOptions = {}
): Promise<ClosureNode[]> {
  const nodes: ClosureNode[] = [];
  const pinnedVersion = new Map<string, string>([[primary.id, primary.version]]);
  const explored = new Set<string>();
  const queue: ClosureNode[] = [primary];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (explored.has(next.id)) continue;
    explored.add(next.id);
    nodes.push(next);

    const deps = await installer.getDependencies(next, { includePlanningFallbacks: true });
    for (const [depId, depVersion] of Object.entries(deps)) {
      if (depId.includes("examples")) continue;
      if (options.excludeDependency?.(depId)) continue;
      if (pinnedVersion.has(depId)) continue; // already pinned by an earlier (closer) branch
      pinnedVersion.set(depId, depVersion);
      queue.push({ id: depId, version: depVersion });
    }
  }

  return nodes;
}
