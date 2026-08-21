#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";
import { generatePackage } from "./generate.js";
import type { SchemaSource } from "./merge/index.js";
import { formatPackageSpec, looksLikePackageSpec, parsePackageSpec, resolvePackage } from "./resolve/index.js";
import type { TerminologySource } from "./terminology/index.js";

interface Args {
  input: string;
  outDir: string;
  verbose: boolean;
  /** Overrides the standard FHIR package cache. Only meaningful for package input. */
  cacheDir?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") {
      args.outDir = argv[++i];
    } else if (a === "--cache-dir") {
      args.cacheDir = argv[++i];
    } else if (a === "-v" || a === "--verbose") {
      args.verbose = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith("-")) {
      args.input = a;
    }
  }

  if (!args.input) {
    console.error("Error: missing <input>.\n");
    printHelp();
    process.exit(1);
  }

  return {
    input: args.input,
    outDir: args.outDir ?? "./generated",
    verbose: args.verbose ?? false,
    cacheDir: args.cacheDir,
  };
}

function printHelp() {
  console.log(`
fhir-zod-gen — generate Zod schemas from FHIR Implementation Guides

Usage:
  fhir-zod-gen <input> [-o <outDir>] [-v] [--cache-dir <dir>]

  <input>   An IG package identifier (hl7.fhir.us.core#6.1.0, or a bare id
            for the registry's latest), OR a path to a single FHIR Schema
            .json file, OR a directory of them.

Options:
  -o, --out <dir>      Output directory (default: ./generated)
  -v, --verbose        Print per-document warnings and package progress
      --cache-dir <d>  FHIR package cache to use (default: ~/.fhir/packages,
                       shared with sushi / the IG publisher / HAPI)

Examples:
  fhir-zod-gen hl7.fhir.us.core#6.1.0 -o ./generated
  fhir-zod-gen ./examples/patient.fhirschema.json -o ./generated
  fhir-zod-gen ./fhir-schemas/us-core -o ./generated -v

Note: the first run for a package downloads it and its declared dependency
closure (US Core pulls hl7.fhir.r4.core for the base resources it profiles).
That is a few hundred MB and a minute or so; later runs read the cache.
`);
}

/**
 * Package identifier or path? An existing path always wins, so a local
 * directory that happens to look like a package id still resolves to itself.
 */
function isPackageInput(input: string): boolean {
  if (existsSync(input)) return false;
  return looksLikePackageSpec(input);
}

async function loadDocsFromPath(input: string): Promise<FhirSchemaDocument[]> {
  const stats = await stat(input);

  const paths: string[] = [];
  if (stats.isDirectory()) {
    const entries = await readdir(input);
    for (const e of entries) {
      if (extname(e) === ".json") paths.push(join(input, e));
    }
  } else {
    paths.push(input);
  }

  if (paths.length === 0) {
    throw new Error(`No .json FHIR Schema files found at ${input}`);
  }

  const docs: FhirSchemaDocument[] = [];
  for (const p of paths) {
    const raw = await readFile(p, "utf-8");
    docs.push(JSON.parse(raw) as FhirSchemaDocument);
  }
  return docs;
}

interface LoadedInput {
  docs: FhirSchemaDocument[];
  /** Present only for package input — file/directory input has no base chain to walk. */
  source?: SchemaSource;
  /** Present only for package input — file/directory input has no package to read terminology from. */
  terminology?: TerminologySource;
}

async function loadFromPackage(input: string, args: Args): Promise<LoadedInput> {
  const spec = parsePackageSpec(input);
  const log = (message: string) => {
    if (args.verbose) console.log(message);
  };

  const resolved = await resolvePackage(spec, {
    cacheDir: args.cacheDir,
    onLog: log,
    onWarn: (message) => console.warn(message),
  });

  if (resolved.documents.length === 0) {
    // Real case: hl7.fhir.uv.bulkdata ships OperationDefinitions and
    // CapabilityStatements but no resource profiles. Writing an empty
    // barrel index and calling that success would be the kind of quiet
    // wrong answer this project exists to avoid.
    const structureDefinitions = resolved.primary.entries.filter(
      (e) => e.resourceType === "StructureDefinition"
    ).length;
    throw new Error(
      `${formatPackageSpec(resolved.spec)} has no resource StructureDefinitions to generate from ` +
        `(${structureDefinitions} StructureDefinition(s) of other kinds, ${resolved.primary.entries.length} resources total).`
    );
  }

  console.log(
    `Resolved ${formatPackageSpec(resolved.spec)} — ${resolved.documents.length} resource StructureDefinition(s).`
  );

  // The documents are profiles as published — they restate only what they
  // narrow. `resolved.source` is what fills the rest in: it indexes the whole
  // dependency closure, so merge/ can walk each profile up to the base
  // resource in hl7.fhir.r4.core (design doc section 1, defect 4).
  // `resolved.terminology` does the same for required bindings (issue #10).
  return { docs: resolved.documents, source: resolved.source, terminology: resolved.terminology };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { docs, source, terminology } = isPackageInput(args.input)
    ? await loadFromPackage(args.input, args)
    : { docs: await loadDocsFromPath(args.input), source: undefined, terminology: undefined };

  console.log(`Loaded ${docs.length} FHIR Schema document(s).`);

  const { filesWritten, warningCount, failures } = await generatePackage(docs, {
    outDir: args.outDir,
    verbose: args.verbose,
    source,
    terminology,
  });

  console.log(`Wrote ${filesWritten.length} file(s) to ${args.outDir}`);
  if (warningCount > 0) {
    console.warn(
      `${warningCount} warning(s) emitted — run with -v to see them inline, or check the /* TODO */ markers in generated output.`
    );
  }
  if (failures.length > 0) {
    console.warn(`\n${failures.length} document(s) could not be resolved and were skipped:`);
    for (const failure of failures) {
      console.warn(`  ${failure.name} (${failure.url})\n    ${failure.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
