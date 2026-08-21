/**
 * Reading a FHIR package's `.index.json` — the manifest every published
 * package ships in its `package/` directory listing every resource file with
 * enough header fields (url, type, kind) to route a lookup without opening
 * the file.
 *
 * Using the index instead of scanning + parsing every `*.json` matters:
 * hl7.fhir.r4.core#4.0.1 has 4581 resource files, of which 658 are
 * StructureDefinitions, and a codegen run typically touches a few dozen.
 * The index is ~1 file read; a scan is 4581.
 *
 * No network, no package installation — this takes a directory that already
 * exists on disk, which is what makes it (and everything built on it)
 * testable offline against fixtures/packages/.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface PackageIndexEntry {
  filename: string;
  resourceType: string;
  id?: string;
  url?: string;
  version?: string;
  /** "resource" | "complex-type" | "primitive-type" | "logical" for StructureDefinitions. */
  kind?: string;
  /** The FHIR type a StructureDefinition constrains — "Patient", "Extension", ... */
  type?: string;
}

export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

interface RawIndex {
  files?: unknown;
}

/**
 * Reads `<packageDir>/.index.json`.
 *
 * Falls back to scanning the directory when the index is missing — packages
 * published before the index convention (and any hand-assembled directory)
 * have none. The fallback reads each file's header fields, which is exactly
 * what the index would have told us.
 */
export function readPackageIndex(packageDir: string): PackageIndexEntry[] {
  const indexPath = join(packageDir, ".index.json");
  if (!existsSync(indexPath)) return scanPackageDirectory(packageDir);

  const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as RawIndex;
  if (!Array.isArray(parsed.files)) {
    throw new Error(`${indexPath} has no "files" array — not a FHIR package index.`);
  }

  const entries: PackageIndexEntry[] = [];
  for (const raw of parsed.files) {
    const entry = raw as Partial<PackageIndexEntry>;
    if (typeof entry.filename === "string" && typeof entry.resourceType === "string") {
      entries.push(entry as PackageIndexEntry);
    }
  }
  return entries;
}

export function readPackageManifest(packageDir: string): PackageManifest {
  const manifestPath = join(packageDir, "package.json");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<PackageManifest>;
  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error(`${manifestPath} has no name/version — not a FHIR package manifest.`);
  }
  return {
    name: parsed.name,
    version: parsed.version,
    dependencies: parsed.dependencies ?? {},
  };
}

function scanPackageDirectory(packageDir: string): PackageIndexEntry[] {
  const entries: PackageIndexEntry[] = [];
  for (const filename of readdirSync(packageDir)) {
    if (!filename.endsWith(".json") || filename === "package.json" || filename.startsWith(".")) {
      continue;
    }
    let parsed: Partial<PackageIndexEntry> & { resourceType?: string };
    try {
      parsed = JSON.parse(readFileSync(join(packageDir, filename), "utf-8")) as Partial<PackageIndexEntry>;
    } catch {
      continue; // Not JSON we can route on; the index would not have listed it either.
    }
    if (typeof parsed.resourceType !== "string") continue;
    entries.push({
      filename,
      resourceType: parsed.resourceType,
      id: parsed.id,
      url: parsed.url,
      version: parsed.version,
      kind: parsed.kind,
      type: parsed.type,
    });
  }
  return entries;
}
