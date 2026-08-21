#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";
import { generatePackage } from "./generate.js";

interface Args {
  input: string;
  outDir: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") {
      args.outDir = argv[++i];
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
    console.error("Error: missing <input> path.\n");
    printHelp();
    process.exit(1);
  }

  return {
    input: args.input,
    outDir: args.outDir ?? "./generated",
    verbose: args.verbose ?? false,
  };
}

function printHelp() {
  console.log(`
fhir-zod-gen — generate Zod schemas from FHIR Schema documents

Usage:
  fhir-zod-gen <input> [-o <outDir>] [-v]

  <input>   Path to a single FHIR Schema .json file, or a directory of them.

Examples:
  fhir-zod-gen ./examples/patient.fhirschema.json -o ./generated
  fhir-zod-gen ./fhir-schemas/us-core -o ./generated -v

Roadmap (not yet implemented):
  fhir-zod-gen hl7.fhir.us.davinci-crd#2.1.0   # resolve + fetch an IG package directly
    This requires pulling the package from the FHIR package registry
    (packages.fhir.org) and converting StructureDefinitions to FHIR Schema
    first (or consuming pre-converted FHIR Schema, where published). Tracked
    in the README roadmap — contributions welcome.
`);
}

async function loadDocs(input: string): Promise<FhirSchemaDocument[]> {
  const stat = await import("node:fs/promises").then((fs) => fs.stat(input));

  const paths: string[] = [];
  if (stat.isDirectory()) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docs = await loadDocs(args.input);

  console.log(`Loaded ${docs.length} FHIR Schema document(s).`);

  const { filesWritten, warningCount } = await generatePackage(docs, {
    outDir: args.outDir,
    verbose: args.verbose,
  });

  console.log(`Wrote ${filesWritten.length} file(s) to ${args.outDir}`);
  if (warningCount > 0) {
    console.warn(
      `${warningCount} warning(s) emitted — run with -v to see them inline, or check the /* TODO */ markers in generated output.`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
