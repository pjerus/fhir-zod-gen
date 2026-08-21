import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";
import { generateSchemaFile } from "./mapper.js";

export interface GenerateOptions {
  outDir: string;
  /** Print warnings (unhandled elements, missing types) to stderr as they occur. */
  verbose?: boolean;
}

export async function generatePackage(
  docs: FhirSchemaDocument[],
  opts: GenerateOptions
): Promise<{ filesWritten: string[]; warningCount: number }> {
  await mkdir(opts.outDir, { recursive: true });

  const filesWritten: string[] = [];
  let warningCount = 0;
  const exportLines: string[] = [];

  for (const doc of docs) {
    const result = generateSchemaFile(doc);
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

  return { filesWritten, warningCount };
}
