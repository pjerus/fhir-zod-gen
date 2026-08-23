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
 * `install()` has no public option to exclude specific dependencies from its
 * cascade — so skipping a terminology-only package's ~100s of MB for real
 * (not just from the index) means never calling `install()` on the primary
 * at all when the flag is set. Instead `installClosureTolerantly` walks the
 * closure itself via closure.ts's registry-metadata-only walker (pruning
 * terminology-only dependencies out of the walk before they're ever
 * enqueued) and downloads each accepted, not-yet-cached package individually
 * with `downloadPackage()` — the one public API that materializes a single
 * package without cascading into its dependencies.
 *
 * ## A broken dependency must not abort the whole run (issue #42)
 *
 * The common-case default path still starts with one
 * `installer.install(specString)` call: it cascades through the installer's
 * own dependency resolution and download, with its cross-process disk
 * locking, and is what nearly every invocation hits. But `install()` is
 * all-or-nothing — one dependency it cannot fetch (e.g. a terminology
 * package pinned to a version the registry never published:
 * `us.nlm.vsac@0.18.0` in `hl7.fhir.us.davinci-pas#2.2.1`, where every
 * *other* one of its 13 dependencies downloads fine) aborts the entire
 * install and produces zero output, the same way an unresolvable binding or
 * type is never allowed to abort emission elsewhere in this codebase.
 *
 * So when `install()` throws, this module falls back to
 * `installClosureTolerantly` — the same per-package walk+download shape
 * `skipTerminology` already uses — with no exclusion filter. That function
 * always visits the primary package first (breadth-first from a single
 * root), so a failure on the primary itself still rethrows and remains a
 * hard error; a failure on any other node is a loud warning naming the
 * package and the underlying cause, and the walk continues. The trade-off,
 * same one `skipTerminology` already accepts: this path loses `install()`'s
 * cross-process disk locking. Acceptable for a single-user CLI invocation,
 * and it only runs at all after the fast path has already failed.
 *
 * Registry choice was evaluated separately and is *not* part of this fix:
 * `packages2.fhir.org` does serve `us.nlm.vsac@0.18.0`'s metadata (verified
 * via `GET https://packages2.fhir.org/packages/us.nlm.vsac/`), but
 * `fhir-package-installer@1.13.1`'s tarball URL is hardcoded to the
 * npm-style `{registryUrl}/{id}/-/{id}-{version}.tgz` shape regardless of
 * registry (its `isPrivateRegistry` branch and its `else` branch build the
 * identical string — dead code, not an actual distinction), and packages2
 * doesn't serve tarballs at that path (its real layout is
 * `/web/{id}-{version}.tgz`, reached through a 302 from
 * `/packages/{id}/{version}`, verified with `curl`). So no `registryUrl`
 * value makes this specific download succeed — graceful degradation is the
 * correct and complete fix, not a registry swap.
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
    return await installClosureTolerantly(installer, primaryId, log, warn, isKnownTerminologyPackage);
  }

  log(`Installing ${specString} and its dependencies (cache: ${installer.getCachePath()}) ...`);
  try {
    await installer.install(specString);
    return await readClosureFromDisk(installer, primaryId, warn);
  } catch (error) {
    // install()'s cascade is all-or-nothing, so any failure inside it —
    // whether the primary or one of its dependencies — lands here. Retry
    // package-by-package: installClosureTolerantly rethrows if the primary
    // itself is what's actually broken, and otherwise degrades just the
    // failing dependency. See this file's module comment (issue #42).
    const message = error instanceof Error ? error.message : String(error);
    warn(
      `${specString}'s dependency install cascade failed (${message}); retrying package-by-package so a single ` +
        `broken dependency doesn't abort the whole run.`
    );
    return await installClosureTolerantly(installer, primaryId, log, warn);
  }
}

async function installClosureTolerantly(
  installer: FhirPackageInstaller,
  primary: ClosureNode,
  log: (message: string) => void,
  warn: (message: string) => void,
  excludeDependency?: (id: string) => boolean
): Promise<InstalledClosure> {
  log(
    `Resolving ${formatPackageSpec(primary)}'s dependency closure (cache: ${installer.getCachePath()})` +
      (excludeDependency ? ", skipping terminology-only dependencies (--skip-terminology)" : "") +
      " ..."
  );
  const nodes = await walkDependencyClosure(installer, primary, { excludeDependency });
  const allowed = new Set<string>();

  for (const node of nodes) {
    const key = `${node.id}#${node.version}`;
    // Matched by identity, not by position. walkDependencyClosure does return
    // the primary first (it seeds the queue with it), but this is the line
    // that decides whether a run aborts or degrades, and it shouldn't rest on
    // another module's iteration order.
    const isPrimary = node.id === primary.id && node.version === primary.version;
    try {
      if (!(await installer.isInstalled(node, { deep: false }))) {
        log(`Downloading ${formatPackageSpec(node)} ...`);
        await installer.downloadPackage(node, { destination: installer.getCachePath(), extract: true });
      }
      allowed.add(key);
    } catch (error) {
      if (isPrimary) throw error;
      const message = error instanceof Error ? error.message : String(error);
      warn(
        `Skipping dependency ${key}: could not be downloaded (${message}). Required bindings and types that ` +
          `depend on it degrade instead of failing the run — an unexpandable required binding falls back to ` +
          `z.string(), an unresolvable base or type falls back to z.unknown() with a TODO marker.`
      );
    }
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
