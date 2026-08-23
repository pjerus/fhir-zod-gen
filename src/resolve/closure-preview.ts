/**
 * Resolving a package's dependency closure and reporting it — ids, versions,
 * cached status, and approximate on-disk size where it's actually knowable —
 * WITHOUT downloading anything. Issue #9: `fhir-zod-gen hl7.fhir.us.core#6.1.0`
 * pulls down a ~646 MB dependency closure on first run; a user typing a
 * one-line command shouldn't be ambushed by that. cli.ts calls this before
 * `resolvePackage()` so the closure is visible while the user can still stop
 * it, instead of only after.
 *
 * ## Why size is only ever reported for already-cached packages
 *
 * The registry's per-version metadata carries no size field (verified: see
 * closure.ts's module comment), and the only way to learn a tarball's size
 * from the registry is to actually transfer it — a `HEAD` against the
 * tarball URL 404s on packages.simplifier.net's redirect target, and a
 * `Range` request that falls back to a full `200` response means the bytes
 * were already sent over the wire, which is exactly the cost this preview
 * exists to let the user avoid incurring blind. So a not-yet-cached
 * package's size is reported as `undefined` — not a guess, not omitted
 * silently, just honestly unknown — and a caller that already has the
 * package cached gets the real number, computed by summing its extracted
 * files on disk.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FhirPackageInstaller } from "fhir-package-installer";
import type { InstallOptions } from "./install.js";
import {
  isKnownTerminologyPackage,
  unpublishableVersionKind,
  walkDependencyClosure,
  type ClosureNode,
  type UnpublishableVersion,
} from "./closure.js";
import { formatPackageSpec, type PackageSpec } from "./package-spec.js";

export interface ClosureEntry extends ClosureNode {
  /** Already present in the package cache — nothing to download for it. */
  cached: boolean;
  /** Sum of extracted file sizes on disk, in bytes. Only set when `cached`. */
  approxSizeBytes?: number;
  /** See closure.ts's isKnownTerminologyPackage — a --skip-terminology candidate. */
  terminologyOnly: boolean;
  /**
   * Set when the declared version is one no registry publishes — a
   * build.fhir.org CI build ("current", "current$branch") or a local "dev"
   * build. Such an entry will never be downloaded however long you wait, so
   * reporting it alongside packages that genuinely are about to be fetched
   * would overstate both the download and the wait. Issue #48; see
   * closure.ts's unpublishableVersionKind.
   */
  unpublishableVersion?: UnpublishableVersion;
}

export interface ClosurePreview {
  primary: ClosureEntry;
  /** Primary first, then its resolved dependency closure, breadth-first — same convention as InstalledClosure.packages. */
  packages: ClosureEntry[];
}

/**
 * Resolves `spec`'s full dependency closure (registry metadata only, see
 * closure.ts) and reports what's already cached vs. what a real
 * `resolvePackage()` call would need to download. Always walks the *whole*
 * closure, including terminology-only packages — the point is to show the
 * user everything so they can decide, `--skip-terminology` included.
 */
export async function previewPackageClosure(spec: PackageSpec, options: InstallOptions = {}): Promise<ClosurePreview> {
  const installer = new FhirPackageInstaller({
    cachePath: options.cacheDir,
    registryUrl: options.registryUrl,
    skipExamples: true,
    logger: {
      info: options.onLog ?? (() => {}),
      warn: options.onWarn ?? (() => {}),
      error: options.onWarn ?? (() => {}),
      debug: () => {},
    },
  });

  const primaryId = await installer.toPackageObject(formatPackageSpec(spec));
  const nodes = await walkDependencyClosure(installer, primaryId);

  const packages: ClosureEntry[] = [];
  for (const node of nodes) {
    const cached = await installer.isInstalled(node, { deep: false });
    let approxSizeBytes: number | undefined;
    if (cached) {
      try {
        approxSizeBytes = directorySizeBytes(await installer.getPackageDirPath(node));
      } catch {
        approxSizeBytes = undefined;
      }
    }
    packages.push({
      ...node,
      cached,
      approxSizeBytes,
      terminologyOnly: isKnownTerminologyPackage(node.id),
      unpublishableVersion: unpublishableVersionKind(node.version),
    });
  }

  const primary = packages[0];
  if (!primary) throw new Error(`Could not resolve ${formatPackageSpec(spec)}'s dependency closure.`);
  return { primary, packages };
}

function directorySizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}
