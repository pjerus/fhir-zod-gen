import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";
import { emitDocument } from "./emit/index.js";
import { resolveDocument, type SchemaSource } from "./merge/index.js";
import { generateSchemaFile } from "./mapper.js";

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
  const exportLines: string[] = [];

  for (const doc of docs) {
    let result;
    try {
      result = opts.source ? emitDocument(resolveDocument(doc, opts.source)) : generateSchemaFile(doc);
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
      continue;
    }

    const outPath = join(opts.outDir, result.fileName);
    await writeFile(outPath, result.source, "utf-8");
    filesWritten.push(outPath);
    exportLines.push(`export * from "./${doc.name}.js";`);

    if (result.warnings.length) {
      warningCount += result.warnings.length;
      if (opts.verbose) {
        for (const w of result.warnings) {
          console.warn(`[${doc.name}] ${w}`);
        }
      }
    }
  }

  const indexPath = join(opts.outDir, "index.ts");
  await writeFile(indexPath, exportLines.join("\n") + "\n", "utf-8");
  filesWritten.push(indexPath);

  return { filesWritten, warningCount, failures };
}
