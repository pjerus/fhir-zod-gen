#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";
import { generatePackage } from "./generate.js";
import type { SchemaSource } from "./merge/index.js";
import {
  formatPackageSpec,
  looksLikePackageSpec,
  parsePackageSpec,
  previewPackageClosure,
  resolvePackage,
  type ClosurePreview,
  type PackageSpec,
} from "./resolve/index.js";
import type { TerminologySource } from "./terminology/index.js";

interface Args {
  input: string;
  outDir: string;
  verbose: boolean;
  /** Overrides the standard FHIR package cache. Only meaningful for package input. */
  cacheDir?: string;
  /** Omit terminology-only dependencies from the closure — see resolve/closure.ts. */
  skipTerminology: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { verbose: false, skipTerminology: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") {
      args.outDir = argv[++i];
    } else if (a === "--cache-dir") {
      args.cacheDir = argv[++i];
    } else if (a === "-v" || a === "--verbose") {
      args.verbose = true;
    } else if (a === "--skip-terminology") {
      args.skipTerminology = true;
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
    skipTerminology: args.skipTerminology ?? false,
  };
}

function printHelp() {
  console.log(`
fhir-zod-gen — generate Zod schemas from FHIR Implementation Guides

Usage:
  fhir-zod-gen <input> [-o <outDir>] [-v] [--cache-dir <dir>] [--skip-terminology]

  <input>   An IG package identifier (hl7.fhir.us.core#6.1.0, or a bare id
            for the registry's latest), OR a path to a single FHIR Schema
            .json file, OR a directory of them.

Options:
  -o, --out <dir>       Output directory (default: ./generated)
  -v, --verbose         Print per-document warnings and package progress
      --cache-dir <d>   FHIR package cache to use (default: ~/.fhir/packages,
                        shared with sushi / the IG publisher / HAPI)
      --skip-terminology
                        Omit terminology-only dependencies (e.g. us.nlm.vsac,
                        us.cdc.phinvads, hl7.terminology.*) from the download.
                        Trade-off: required bindings that would have expanded
                        to z.enum([...]) instead degrade to z.string() with a
                        TODO(defect 2) marker, same as when a binding's
                        ValueSet can't be found at all.

Examples:
  fhir-zod-gen hl7.fhir.us.core#6.1.0 -o ./generated
  fhir-zod-gen hl7.fhir.us.core#6.1.0 -o ./generated --skip-terminology
  fhir-zod-gen ./examples/patient.fhirschema.json -o ./generated
  fhir-zod-gen ./fhir-schemas/us-core -o ./generated -v

Note: the first run for a package downloads its declared dependency closure
(US Core pulls in hl7.fhir.r4.core plus several terminology packages,
~646 MB total). Before downloading anything, the closure and its size
(where known) are printed and — in an interactive terminal — confirmed;
non-interactive runs (CI, piped input) proceed automatically. Packages are
cached at the path above; later runs of any package sharing a dependency
read the cache instead of re-downloading.
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
  /** Present only for package input — the regexes live on raw primitive-type StructureDefinitions, which only a package has. */
  primitiveRegex?: Record<string, string>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (const u of units) {
    unit = u;
    if (value < 1024) break;
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatClosureTable(preview: ClosurePreview, skipTerminology: boolean): string {
  const header = ["Package", "Version", "Status", "Size"];
  const rows = preview.packages.map((p) => {
    const status = p.cached ? "cached" : skipTerminology && p.terminologyOnly ? "skipped" : "not cached";
    const size = p.approxSizeBytes !== undefined ? formatBytes(p.approxSizeBytes) : p.cached ? "" : "unknown";
    const label = p.terminologyOnly ? `${p.id} (terminology)` : p.id;
    return [label, p.version, status, size];
  });

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [formatRow(header), ...rows.map(formatRow)].join("\n");
}

function summarizeClosure(preview: ClosurePreview, skipTerminology: boolean): string {
  const lines: string[] = [];
  const cached = preview.packages.filter((p) => p.cached);
  const cachedBytes = cached.reduce((sum, p) => sum + (p.approxSizeBytes ?? 0), 0);
  const terminologyOnly = preview.packages.filter((p) => p.terminologyOnly);
  const skipped = skipTerminology ? terminologyOnly.filter((p) => !p.cached) : [];
  const toDownload = preview.packages.filter((p) => !p.cached && !skipped.includes(p));

  lines.push(
    `${preview.packages.length} package(s) in the closure, ${cached.length} already cached (${formatBytes(cachedBytes)} on disk).`
  );

  if (toDownload.length > 0) {
    lines.push(
      `${toDownload.length} package(s) not yet cached and will be downloaded — the registry doesn't expose size without downloading, so their size isn't shown above.`
    );
  }

  if (skipTerminology) {
    if (skipped.length > 0) {
      lines.push(`${skipped.length} terminology-only package(s) skipped (--skip-terminology) — not downloaded.`);
    }
  } else if (terminologyOnly.length > 0) {
    const knownBytes = terminologyOnly.filter((p) => p.cached).reduce((sum, p) => sum + (p.approxSizeBytes ?? 0), 0);
    const sizeNote = knownBytes > 0 ? ` (at least ${formatBytes(knownBytes)}, based on what's already cached)` : "";
    lines.push(
      `${terminologyOnly.length} of these are terminology-only and would be skipped with --skip-terminology${sizeNote} — ` +
        `required bindings would then fall back to plain strings instead of enums.`
    );
  }

  return lines.join("\n");
}

async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Resolves and prints the dependency closure before touching the network for
 * a real download (issue #9) — ids, versions, cached status, and size where
 * it's actually known (see closure-preview.ts for why an uncached package's
 * size can't be shown without downloading it). In an interactive terminal,
 * asks before proceeding; a non-interactive session (CI, piped input, no
 * TTY) just logs and continues, per the same issue's requirement 3.
 * Skipped entirely when everything in the closure is already cached — there
 * is nothing left to warn about.
 */
async function confirmClosureDownload(spec: PackageSpec, args: Args): Promise<void> {
  const preview = await previewPackageClosure(spec, {
    cacheDir: args.cacheDir,
    onWarn: (message) => console.warn(message),
  });

  if (preview.packages.every((p) => p.cached)) {
    if (args.verbose) {
      console.log(`All ${preview.packages.length} package(s) in ${formatPackageSpec(spec)}'s closure are already cached.`);
    }
    return;
  }

  console.log(`\n${formatPackageSpec(spec)}'s dependency closure:\n`);
  console.log(formatClosureTable(preview, args.skipTerminology));
  console.log();
  console.log(summarizeClosure(preview, args.skipTerminology));

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("\nNon-interactive session — proceeding automatically.\n");
    return;
  }

  const proceed = await promptYesNo("\nProceed with download? [Y/n] ");
  if (!proceed) {
    console.log("Aborted — nothing downloaded.");
    process.exit(0);
  }
  console.log();
}

async function loadFromPackage(input: string, args: Args): Promise<LoadedInput> {
  const spec = parsePackageSpec(input);
  const log = (message: string) => {
    if (args.verbose) console.log(message);
  };

  await confirmClosureDownload(spec, args);

  const resolved = await resolvePackage(spec, {
    cacheDir: args.cacheDir,
    skipTerminology: args.skipTerminology,
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
  // Lifted from the closure's raw primitive-type StructureDefinitions, which
  // is the only place they survive — FHIR Schema drops them (see
  // emit/primitive-regex.ts). Version-correct by construction: an R5 run
  // picks up R5's patterns with no code change.
  return {
    docs: resolved.documents,
    source: resolved.source,
    terminology: resolved.terminology,
    primitiveRegex: resolved.source.primitiveRegexes(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { docs, source, terminology, primitiveRegex } = isPackageInput(args.input)
    ? await loadFromPackage(args.input, args)
    : { docs: await loadDocsFromPath(args.input), source: undefined, terminology: undefined, primitiveRegex: undefined };

  console.log(`Loaded ${docs.length} FHIR Schema document(s).`);

  const { filesWritten, warningCount, failures } = await generatePackage(docs, {
    outDir: args.outDir,
    verbose: args.verbose,
    source,
    terminology,
    primitiveRegex,
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
