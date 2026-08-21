import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";
import { emitPackage, type EmitResult } from "./emit/index.js";
import { resolveDocument, type ResolvedSchema, type SchemaSource } from "./merge/index.js";
import { generateSchemaFile } from "./mapper.js";
import type { TerminologySource } from "./terminology/index.js";

export interface GenerateOptions {
  outDir: string;
  /** Print warnings (unhandled elements, missing types) to stderr as they occur. */
  verbose?: boolean;
  /**
   * Where to look up a profile's base resource and its complex types. Supply
   * one whenever the documents are profiles — without it every profile hits
   * defect 4 (design doc section 1): a profile restates only what it
   * narrows, so its types/cardinality come from the base chain.
   * resolve/'s PackageSchemaSource is the real implementation; omitting it
   * keeps the old self-sufficient-document behaviour of mapper.ts's shim.
   */
  source?: SchemaSource;
  /**
   * Where to look up a required binding's ValueSet/CodeSystem for z.enum
   * expansion (defect 2, issue #10). Only meaningful alongside `source` —
   * the file/directory input path has no package to read terminology from
   * and goes through mapper.ts's shim regardless. Omitting it is a fully
   * supported degrade: every required binding falls back to its plain
   * primitive mapping with a TODO(defect 2) marker, same as an expansion
   * failure. resolve/'s PackageTerminologySource is the real implementation.
   */
  terminology?: TerminologySource;
}

/** A document that could not be resolved, and why. Never silently dropped. */
export interface GenerateFailure {
  name: string;
  url: string;
  message: string;
}

export async function generatePackage(
  docs: FhirSchemaDocument[],
  opts: GenerateOptions
): Promise<{ filesWritten: string[]; warningCount: number; failures: GenerateFailure[] }> {
  await mkdir(opts.outDir, { recursive: true });

  const filesWritten: string[] = [];
  const failures: GenerateFailure[] = [];
  let warningCount = 0;

  // Two passes, not one: emitPackage (issue #6) needs every document's
  // ResolvedSchema up front to discover and dedupe the complex datatypes
  // they share (Identifier, HumanName, ...) across the whole batch, and to
  // resolve genuine cross-type cycles (Identifier <-> Reference)
  // consistently everywhere they're referenced. Emitting per-document inside
  // the resolve loop, as before issue #6, can't do either — it would either
  // duplicate each shared datatype's file once per referencing document or
  // never emit it at all.
  const resolved: ResolvedSchema[] = [];
  // mapper.ts's shim path (no SchemaSource) has no base/complex-type
  // resolution to do, so it stays a direct per-document emit — there is
  // nothing for emitPackage to batch there.
  const shimResults: EmitResult[] = [];

  for (const doc of docs) {
    if (!opts.source) {
      shimResults.push(generateSchemaFile(doc));
      continue;
    }
    try {
      resolved.push(resolveDocument(doc, opts.source));
    } catch (err) {
      // merge/ throws rather than guessing when it can't reach a base — e.g.
      // a profile whose own base is a profile. Skipping one document and
      // reporting it beats aborting a 50-profile IG, but it is never quiet:
      // the caller gets the list back.
      failures.push({
        name: doc.name,
        url: doc.url,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const results = [...shimResults, ...emitPackage(resolved, { terminology: opts.terminology })];

  // Dedup by file name: two documents (or, in principle, a document and a
  // datatype) sharing a name would otherwise silently overwrite each other
  // on disk and emit the same barrel-index line twice (issue #14) — not
  // fully solved here (see issue #14), but not made worse either.
  const seenFileNames = new Set<string>();
  const exportLines: string[] = [];

  for (const result of results) {
    if (seenFileNames.has(result.fileName)) continue;
    seenFileNames.add(result.fileName);

    const outPath = join(opts.outDir, result.fileName);
    await writeFile(outPath, result.source, "utf-8");
    filesWritten.push(outPath);
    exportLines.push(`export * from "./${result.fileName.replace(/\.ts$/, "")}.js";`);

    if (result.warnings.length) {
      warningCount += result.warnings.length;
      if (opts.verbose) {
        for (const w of result.warnings) {
          console.warn(`[${result.fileName}] ${w}`);
        }
      }
    }
  }

  const indexPath = join(opts.outDir, "index.ts");
  await writeFile(indexPath, exportLines.join("\n") + "\n", "utf-8");
  filesWritten.push(indexPath);

  return { filesWritten, warningCount, failures };
}
