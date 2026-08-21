/**
 * Parsing for the `hl7.fhir.us.core#6.1.0` form the CLI accepts alongside a
 * file/directory path.
 */

export interface PackageSpec {
  id: string;
  /** Absent means "let the registry pick" — resolved to the `latest` dist-tag. */
  version?: string;
}

/**
 * FHIR package ids are dot-separated lowercase segments (`hl7.fhir.us.core`,
 * `us.nlm.vsac`, `ihe.formatcode.fhir`). The dot requirement is what keeps
 * this from swallowing a relative path like `generated` — see
 * looksLikePackageSpec.
 */
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

export function parsePackageSpec(input: string): PackageSpec {
  const trimmed = input.trim();
  // Both separators are in the wild: `#` is the FHIR convention (and what the
  // package cache directory names use), `@` is npm's and is accepted by the
  // registry too.
  const separator = trimmed.includes("#") ? "#" : trimmed.includes("@") ? "@" : undefined;

  const id = separator ? trimmed.slice(0, trimmed.indexOf(separator)) : trimmed;
  const version = separator ? trimmed.slice(trimmed.indexOf(separator) + 1) : undefined;

  if (!PACKAGE_ID.test(id)) {
    throw new Error(
      `"${input}" is not a FHIR package identifier. Expected something like hl7.fhir.us.core#6.1.0.`
    );
  }
  if (separator && !version) {
    throw new Error(`"${input}" has a version separator but no version. Try ${id}#6.1.0, or just ${id}.`);
  }

  return version ? { id, version } : { id };
}

/**
 * True when `input` should be treated as a package identifier rather than a
 * path. Deliberately conservative: the CLI only reaches this after checking
 * whether the input exists on disk, so an existing `./hl7.fhir.us.core`
 * directory still wins.
 */
export function looksLikePackageSpec(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  if (trimmed.endsWith(".json")) return false;

  const separator = trimmed.includes("#") ? "#" : trimmed.includes("@") ? "@" : undefined;
  const id = separator ? trimmed.slice(0, trimmed.indexOf(separator)) : trimmed;
  return PACKAGE_ID.test(id);
}

export function formatPackageSpec(spec: PackageSpec): string {
  return spec.version ? `${spec.id}#${spec.version}` : spec.id;
}
