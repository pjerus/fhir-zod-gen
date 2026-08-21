/**
 * Getting an IG package (and everything it depends on) onto disk.
 *
 * ## Why fhir-package-installer rather than hand-rolled registry HTTP
 *
 * The download itself is easy — `GET https://packages2.fhir.org/packages/{id}/{version}`
 * 302s to a tarball, and Node 18+ has global fetch. What is *not* easy, and
 * what this library already does:
 *
 *   - the standard FHIR package cache (`~/.fhir/packages`, per
 *     https://confluence.hl7.org/display/FHIR/FHIR+Package+Cache), shared
 *     with sushi / the IG publisher / HAPI, so a package another tool
 *     already downloaded is not downloaded again;
 *   - registry fallback — packages.fhir.org's npm-style manifest points
 *     tarballs at packages.simplifier.net, and version resolution goes
 *     through `dist-tags`;
 *   - concurrency-safe installs (disk locks + staging dirs), which matters
 *     because the cache is shared with other processes;
 *   - the transitive dependency closure.
 *
 * Its dependency tree is four small packages (fs-extra, p-limit, semver,
 * tar-stream), so "heavy dependency" doesn't apply. Hand-rolling would mean
 * reimplementing the cache layout to stay compatible with the rest of the
 * FHIR toolchain, which is strictly more code for a worse result.
 *
 * Two deliberate configuration choices:
 *   - `skipExamples: true` — hl7.fhir.r4.core pulls hl7.fhir.r4.examples
 *     (193 MB of example instances) as an implicit dependency. Nothing in
 *     codegen reads examples.
 *   - the dependency closure this module *indexes* is walked from each
 *     package's own `package.json` `dependencies`, not from the installer's
 *     dependency resolution, so what feeds the SchemaSource is exactly what
 *     the IG declares.
 *
 * ## `skipTerminology` (issue #9)
 *
 * The default path above is unchanged: one `installer.install(specString)`
 * call, which cascades through the installer's own dependency resolution and
 * downloads everything, then this module re-walks the now-on-disk
 * `package.json` files to index them. `install()` has no public option to
 * exclude specific dependencies from that cascade — so skipping a
 * terminology-only package's ~100s of MB for real (not just from the index)
 * means never calling `install()` on the primary at all when the flag is
 * set. Instead `installClosureSkippingTerminology` walks the closure itself
 * via closure.ts's registry-metadata-only walker (pruning terminology-only
 * dependencies out of the walk before they're ever enqueued) and downloads
 * each accepted, not-yet-cached package individually with
 * `downloadPackage()` — the one public API that materializes a single
 * package without cascading into its dependencies. The trade-off: this path
 * loses `install()`'s cross-process disk locking during concurrent installs
 * of the same package. Acceptable for a single-user CLI invocation; not
 * something the default (far more common) path takes on.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { FhirPackageInstaller } from "fhir-package-installer";
import { isKnownTerminologyPackage, walkDependencyClosure, type ClosureNode } from "./closure.js";
import { readPackageIndex, readPackageManifest } from "./package-index.js";
import type { LoadedPackage } from "./package-schema-source.js";
import { formatPackageSpec, type PackageSpec } from "./package-spec.js";

export interface InstallOptions {
  /** Defaults to the standard FHIR package cache (`~/.fhir/packages`). */
  cacheDir?: string;
  /** Set to "n/a" to forbid all registry access (used by the offline tests). */
  registryUrl?: string;
  onLog?: (message: string) => void;
  onWarn?: (message: string) => void;
  /**
   * Omit terminology-only dependencies (closure.ts's isKnownTerminologyPackage)
   * from the closure entirely — not downloaded, not indexed. A required
   * binding then degrades to z.string() plus the existing TODO(defect 2)
   * marker (the same fallback that already fires when a binding's ValueSet
   * simply can't be found) instead of expanding to z.enum. Issue #9.
   */
  skipTerminology?: boolean;
}

export interface InstalledClosure {
  /** The primary package, with its version resolved to something concrete. */
  primary: LoadedPackage;
  /** Primary first, then its declared dependencies, breadth-first. */
  packages: LoadedPackage[];
}

/**
 * Installs `spec` and its dependency closure into the package cache, then
 * indexes every package in that closure.
 *
 * The closure is not optional. A profile package like hl7.fhir.us.core
 * carries only what it narrows — the base resources it constrains live in
 * hl7.fhir.r4.core, and merge/ throws without them (design doc section 1,
 * defect 4).
 */
export async function installPackageClosure(
  spec: PackageSpec,
  options: InstallOptions = {}
): Promise<InstalledClosure> {
  const log = options.onLog ?? (() => {});
  const warn = options.onWarn ?? ((message: string) => console.warn(message));

  const installer = new FhirPackageInstaller({
    cachePath: options.cacheDir,
    registryUrl: options.registryUrl,
    skipExamples: true,
    logger: { info: log, warn, error: warn, debug: () => {} },
  });

  const specString = formatPackageSpec(spec);
  const primaryId = await installer.toPackageObject(specString);

  if (options.skipTerminology) {
    return await installClosureSkippingTerminology(installer, primaryId, log, warn);
  }

  log(`Installing ${specString} and its dependencies (cache: ${installer.getCachePath()}) ...`);
  await installer.install(specString);

  return await readClosureFromDisk(installer, primaryId, warn);
}

async function installClosureSkippingTerminology(
  installer: FhirPackageInstaller,
  primary: ClosureNode,
  log: (message: string) => void,
  warn: (message: string) => void
): Promise<InstalledClosure> {
  log(
    `Resolving ${formatPackageSpec(primary)}'s dependency closure (cache: ${installer.getCachePath()}), ` +
      `skipping terminology-only dependencies (--skip-terminology) ...`
  );
  const nodes = await walkDependencyClosure(installer, primary, { excludeDependency: isKnownTerminologyPackage });
  const allowed = new Set(nodes.map((n) => `${n.id}#${n.version}`));

  for (const node of nodes) {
    if (await installer.isInstalled(node, { deep: false })) continue;
    log(`Downloading ${formatPackageSpec(node)} ...`);
    await installer.downloadPackage(node, { destination: installer.getCachePath(), extract: true });
  }

  return await readClosureFromDisk(installer, primary, warn, allowed);
}

/**
 * Re-walks a closure already on disk (or partially on disk) from each
 * package's own `package.json` `dependencies`, indexing every package that
 * is actually present. `allowed`, when given, silently drops any dependency
 * outside that set instead of warning about it being missing — used by the
 * skip-terminology path, where a skipped dependency is expected to be
 * absent, not a sign something went wrong.
 */
async function readClosureFromDisk(
  installer: FhirPackageInstaller,
  primary: ClosureNode,
  warn: (message: string) => void,
  allowed?: Set<string>
): Promise<InstalledClosure> {
  const packages: LoadedPackage[] = [];
  const seen = new Set<string>();
  const queue: ClosureNode[] = [primary];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const key = `${next.id}#${next.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (allowed && !allowed.has(key)) continue;

    const dir = await installer.getPackageDirPath(next);
    const packageDir = existsSync(join(dir, "package")) ? join(dir, "package") : dir;
    if (!existsSync(join(packageDir, "package.json"))) {
      // Reachable when a declared dependency was not installed — e.g. an
      // examples package skipped by `skipExamples`. Not fatal: a missing
      // dependency shows up later as an unresolvable base, reported by
      // merge/ with the canonical it could not find.
      warn(`Skipping ${key}: not present in the package cache at ${dir}`);
      continue;
    }

    const manifest = readPackageManifest(packageDir);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      dir: packageDir,
      entries: readPackageIndex(packageDir),
    });

    for (const [depId, depVersion] of Object.entries(manifest.dependencies ?? {})) {
      queue.push({ id: depId, version: depVersion });
    }
  }

  const primaryLoaded = packages[0];
  if (!primaryLoaded) {
    throw new Error(`Could not load ${formatPackageSpec(primary)} from the package cache.`);
  }
  return { primary: primaryLoaded, packages };
}
