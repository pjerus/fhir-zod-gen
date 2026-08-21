/**
 * Rebuilds fixtures/packages/test.fhir.mini-1.0.0.tgz — the tiny, offline
 * stand-in for a real IG package that src/resolve/'s tests load.
 *
 * Like scripts/build-fixtures.ts this is NOT run by `npm test` or CI; run it
 * by hand (`npx tsx scripts/build-test-package.ts`) if the fixture package
 * needs regenerating.
 *
 * The tarball mirrors the real registry layout (`package/` prefix,
 * `package/.index.json`, `package/package.json`) so the resolve/ tests
 * exercise the same code path a downloaded package does — extraction, index
 * parsing, lazy translate() — with no network.
 *
 * Contents, and why each file is there:
 *   - StructureDefinition-Period.json      a small base complex-type
 *   - StructureDefinition-Extension.json   a base type that also has ~400
 *     profiles in real R4, so it pins the "profiles must not shadow the base
 *     type in getByType" rule
 *   - StructureDefinition-patient-birthTime.json  one of those profiles:
 *     `type: "Extension"`, but its url is NOT .../StructureDefinition/Extension
 *
 * All three are copied verbatim out of hl7.fhir.r4.core#4.0.1 — real
 * StructureDefinitions, not hand-written ones, for the same reason the
 * fixtures/ documents are real converter output.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(REPO_ROOT, "fixtures", "packages");
const OUT_FILE = "test.fhir.mini-1.0.0.tgz";

const SOURCE_PACKAGE = { id: "hl7.fhir.r4.core", version: "4.0.1" };

const FILES = [
  "StructureDefinition-Period.json",
  "StructureDefinition-Extension.json",
  "StructureDefinition-patient-birthTime.json",
];

function main(): void {
  const scratch = mkdtempSync(join(tmpdir(), "fhir-zod-test-package-"));
  try {
    const tarball = join(scratch, "r4.tgz");
    const extractDir = join(scratch, "r4");
    mkdirSync(extractDir, { recursive: true });

    console.log(`Downloading ${SOURCE_PACKAGE.id}#${SOURCE_PACKAGE.version} ...`);
    execFileSync("curl", [
      "-sL",
      "-o",
      tarball,
      `https://packages2.fhir.org/packages/${SOURCE_PACKAGE.id}/${SOURCE_PACKAGE.version}`,
    ]);
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir]);
    const r4Dir = join(extractDir, "package");

    const stageDir = join(scratch, "stage", "package");
    mkdirSync(stageDir, { recursive: true });

    const indexFiles = [];
    for (const fileName of FILES) {
      copyFileSync(join(r4Dir, fileName), join(stageDir, fileName));
      const sd = JSON.parse(readFileSync(join(stageDir, fileName), "utf-8")) as Record<string, string>;
      indexFiles.push({
        filename: fileName,
        resourceType: sd.resourceType,
        id: sd.id,
        url: sd.url,
        version: sd.version,
        kind: sd.kind,
        type: sd.type,
      });
    }

    writeFileSync(
      join(stageDir, ".index.json"),
      `${JSON.stringify({ "index-version": 1, files: indexFiles }, null, 2)}\n`,
      "utf-8"
    );
    writeFileSync(
      join(stageDir, "package.json"),
      `${JSON.stringify(
        {
          name: "test.fhir.mini",
          version: "1.0.0",
          description: "Offline fixture package for fhir-zod-gen's resolve/ tests. Not published anywhere.",
          fhirVersions: ["4.0.1"],
          dependencies: {},
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    mkdirSync(OUT_DIR, { recursive: true });
    execFileSync("tar", ["-czf", join(OUT_DIR, OUT_FILE), "-C", join(scratch, "stage"), "package"]);
    console.log(`Wrote ${join(OUT_DIR, OUT_FILE)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
