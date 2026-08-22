/**
 * Validates a package's own `package/example/` resources against the Zod
 * schemas generated for it — the highest-value check this project hadn't
 * done yet. The standing conformance rule everywhere else in the codebase
 * ("never reject conformant data" — see CLAUDE.md's conformance rules) had,
 * before this module, exactly one example resource backing it (US Core
 * Patient, in emit/regression.test.ts). Every IG package ships a directory
 * of real resources the IG publisher already validated against the
 * official HL7 FHIR validator — ground truth for "this is definitely valid
 * data" that costs nothing extra to check against, since the packages are
 * already on disk for merge/ to read as base/complex-type sources.
 *
 * ## Matching an example to a schema
 *
 * An example's `meta.profile` (when present) is the precise signal — an
 * instance claiming conformance to `us-core-patient` should validate
 * against *that* profile's schema, not just base `Patient`. Only the
 * package's own StructureDefinitions are searched for a profile match
 * (`documents`, not the whole dependency closure) — a `meta.profile`
 * pointing outside the package being tested falls through to the
 * `resourceType` fallback below rather than reaching across packages,
 * since "which package this validation run is *for*" should stay well
 * defined.
 *
 * When there's no `meta.profile`, or none of the declared profiles belong
 * to this package, the fallback is the resource's own base type
 * (`resourceType`), resolved via `SchemaSource.getByType` — which searches
 * the *whole* dependency closure, so a plain `Questionnaire` instance in an
 * SDC example (no us-core-style narrowing claimed) still gets a real
 * schema from `hl7.fhir.r4.core`. This matters a lot for some packages:
 * SDC's own examples mostly don't declare a profile at all (most are plain
 * `Questionnaire`/`QuestionnaireResponse` instances).
 *
 * ## What's excluded, and why
 *
 * - `Bundle` resources are excluded. Their own schema would validate the
 *   Bundle wrapper (trivial), not the resources it carries — validating
 *   `entry[].resource` individually would need a resourceType-dispatch
 *   layer this module doesn't build. A real (if partial) gap: some IG
 *   examples exist ONLY inside a Bundle.
 * - Anything with no `resourceType` at all (e.g. a package's `.index.json`
 *   living alongside the real examples) — not a FHIR resource.
 * - A `resourceType` with no schema resolvable anywhere in the package's
 *   dependency closure (rare; would mean the closure is missing a
 *   dependency the example implicitly needs).
 *
 * None of these are "the generator got it wrong" — they're resources this
 * module doesn't attempt to check, and are reported as such rather than
 * silently dropped.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolvePackage } from "../resolve/index.js";
import { resolveDocument, type ResolvedSchema } from "../merge/index.js";
import { emitPackage } from "../emit/index.js";

export interface ExcludedExample {
  file: string;
  reason: string;
}

export interface ExampleResult {
  file: string;
  /** "profile:<canonical url>" or "baseType:<resourceType>" — how the target schema was chosen. */
  matchedVia: string;
  success: boolean;
  /** zod's issue list when `success` is false — untyped here since callers only need to log/compare it, never act on its shape. */
  issues: unknown[];
}

export interface PackageValidationResult {
  packageId: string;
  results: ExampleResult[];
  excluded: ExcludedExample[];
}

export interface ValidateOptions {
  /** Defaults to the standard FHIR package cache (`~/.fhir/packages`). */
  cacheDir?: string;
}

/** Where a package's own example/ directory lives, given the same cache layout install.ts uses. */
export function packageExampleDir(packageId: string, cacheDir?: string): string {
  return join(cacheDir ?? join(homedir(), ".fhir", "packages"), packageId, "package", "example");
}

/**
 * Resolves, emits, and `safeParse`s every real example resource in
 * `packageId`'s own `package/example/` directory against the schema
 * generated for it. Offline: `registryUrl: "n/a"` forbids all registry
 * access (see resolve/install.ts's InstallOptions), so this only ever
 * reads whatever is already in the package cache — callers are expected to
 * check `packageExampleDir` exists before calling, exactly like a normal
 * `resolvePackage` failure surfaces (this function does not catch a
 * missing/uncached package).
 */
export async function validatePackageExamples(
  packageId: string,
  options: ValidateOptions = {}
): Promise<PackageValidationResult> {
  const exampleDir = packageExampleDir(packageId, options.cacheDir);
  const files = readdirSync(exampleDir).filter((f) => f.endsWith(".json"));

  const { source, terminology, documents } = await resolvePackage(packageId, {
    cacheDir: options.cacheDir,
    registryUrl: "n/a",
  });

  // This package's own profiles, resolved once and keyed by canonical url —
  // the precise (meta.profile) match target.
  const profileByUrl = new Map<string, ResolvedSchema>();
  for (const doc of documents) {
    profileByUrl.set(doc.url, resolveDocument(doc, source));
  }

  // Base-type fallback, resolved lazily and cached — many examples share a
  // resourceType (SDC alone has ~30 plain Questionnaire instances).
  const baseTypeCache = new Map<string, ResolvedSchema | undefined>();
  function resolveBaseType(resourceType: string): ResolvedSchema | undefined {
    if (baseTypeCache.has(resourceType)) return baseTypeCache.get(resourceType);
    const doc = source.getByType(resourceType);
    const resolved = doc ? resolveDocument(doc, source) : undefined;
    baseTypeCache.set(resourceType, resolved);
    return resolved;
  }

  const excluded: ExcludedExample[] = [];
  const matched: { file: string; example: Record<string, unknown>; target: ResolvedSchema; matchedVia: string }[] = [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(exampleDir, file), "utf-8")) as Record<string, unknown>;
    const resourceType = raw.resourceType as string | undefined;
    if (!resourceType) {
      excluded.push({ file, reason: "no resourceType — not a FHIR resource" });
      continue;
    }
    if (resourceType === "Bundle") {
      excluded.push({ file, reason: "Bundle — entries are not individually validated (see module comment)" });
      continue;
    }

    const meta = raw.meta as { profile?: string[] } | undefined;
    let target: ResolvedSchema | undefined;
    let matchedVia = "";
    for (const profileUrl of meta?.profile ?? []) {
      const bare = profileUrl.split("|")[0];
      const candidate = profileByUrl.get(bare);
      if (candidate) {
        target = candidate;
        matchedVia = `profile:${bare}`;
        break;
      }
    }
    if (!target) {
      const base = resolveBaseType(resourceType);
      if (base) {
        target = base;
        matchedVia = `baseType:${resourceType}`;
      }
    }
    if (!target) {
      const profileNote = meta?.profile?.length ? ` (declared profile(s): ${meta.profile.join(", ")}, none resolvable)` : "";
      excluded.push({ file, reason: `no schema resolvable for resourceType "${resourceType}"${profileNote}` });
      continue;
    }
    matched.push({ file, example: raw, target, matchedVia });
  }

  // Emit every distinct target once (emitPackage dedupes shared datatypes
  // and resolves cross-type cycles consistently across the whole batch —
  // per-target emitDocument calls would either duplicate or never emit
  // them, per emit.ts's own module comment).
  const targetsByUrl = new Map<string, ResolvedSchema>();
  for (const m of matched) targetsByUrl.set(m.target.url, m.target);
  const targets = [...targetsByUrl.values()];

  // primitiveRegex included deliberately: these examples are the only real
  // evidence that a regex constraint doesn't reject conformant data, so the
  // ratchet has to generate the same schemas the CLI does.
  const emitted = emitPackage(targets, { terminology, primitiveRegex: source.primitiveRegexes() });
  // emitPackage's results are `targets` in order, then shared datatypes
  // appended after (see emit.ts) — positional correspondence with `targets`
  // for its first targets.length entries.
  const fileNameByUrl = new Map<string, string>();
  emitted.slice(0, targets.length).forEach((result, i) => fileNameByUrl.set(targets[i].url, result.fileName));

  const outDir = join(process.cwd(), ".tmp-validate-examples", packageId.replace(/[#.]/g, "_"));
  mkdirSync(outDir, { recursive: true });
  for (const result of emitted) {
    writeFileSync(join(outDir, result.fileName), result.source, "utf-8");
  }

  const results: ExampleResult[] = [];
  for (const m of matched) {
    const fileName = fileNameByUrl.get(m.target.url);
    if (!fileName) {
      excluded.push({ file: m.file, reason: `internal: no emitted file for ${m.target.url}` });
      continue;
    }
    const mod = (await import(pathToFileURL(join(outDir, fileName)).href)) as Record<string, unknown>;
    const schemaEntry = Object.entries(mod).find(([key]) => key.endsWith("Schema"));
    if (!schemaEntry) {
      excluded.push({ file: m.file, reason: `internal: no *Schema export in ${fileName}` });
      continue;
    }
    const schema = schemaEntry[1] as { safeParse: (data: unknown) => { success: boolean; error?: { issues: unknown[] } } };
    const outcome = schema.safeParse(m.example);
    results.push({
      file: m.file,
      matchedVia: m.matchedVia,
      success: outcome.success,
      issues: outcome.error?.issues ?? [],
    });
  }

  return { packageId, results, excluded };
}

/** True when `packageId` has example/ resources on disk to validate against. */
export function hasExamples(packageId: string, cacheDir?: string): boolean {
  return existsSync(packageExampleDir(packageId, cacheDir));
}
