/**
 * Rebuilds fixtures/ from real IG packages.
 *
 * This is the reproduction recipe for the committed fixtures — it is not run
 * by `npm test` or CI. Run it by hand (`npx tsx scripts/build-fixtures.ts`)
 * when a fixture needs to be regenerated (e.g. a package version bump).
 *
 * Steps:
 *   1. Download hl7.fhir.r4.core#4.0.1 and hl7.fhir.us.core#6.1.0 tarballs
 *      from the registry (packages2.fhir.org — packages.fhir.org 404s, see
 *      docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md).
 *   2. Extract them into a scratch directory.
 *   3. Convert the target StructureDefinitions to FHIR Schema with
 *      @atomic-ehr/fhirschema's translate(), and write the *unmodified*
 *      converter output as pretty-printed JSON under fixtures/.
 *   4. Copy the ValueSet/CodeSystem pairs needed to expand the `required`
 *      bindings those StructureDefinitions use, and one conformant example,
 *      verbatim into fixtures/.
 *
 * Fixtures are committed as real converter output — do not hand-edit them.
 * Re-run this script and re-commit instead.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { translate } from "@atomic-ehr/fhirschema";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

const PACKAGES = {
  r4: { id: "hl7.fhir.r4.core", version: "4.0.1" },
  uscore: { id: "hl7.fhir.us.core", version: "6.1.0" },
};

function packageUrl(id: string, version: string): string {
  return `https://packages2.fhir.org/packages/${id}/${version}`;
}

function downloadAndExtract(scratchDir: string, key: keyof typeof PACKAGES): string {
  const { id, version } = PACKAGES[key];
  const tarballPath = join(scratchDir, `${key}.tgz`);
  const extractDir = join(scratchDir, key);
  mkdirSync(extractDir, { recursive: true });

  console.log(`Downloading ${id}#${version} ...`);
  execFileSync("curl", ["-sL", "-o", tarballPath, packageUrl(id, version)]);
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir]);

  return join(extractDir, "package");
}

function readStructureDefinition(packageDir: string, fileName: string): object {
  return JSON.parse(readFileSync(join(packageDir, fileName), "utf-8"));
}

function writeFixture(fileName: string, data: unknown): void {
  const path = join(FIXTURES_DIR, fileName);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  console.log(`Wrote ${path}`);
}

function copyFixture(srcPath: string, destRelPath: string): void {
  const destPath = join(FIXTURES_DIR, destRelPath);
  mkdirSync(join(destPath, ".."), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`Copied ${destPath}`);
}

function main(): void {
  const scratchDir = mkdtempSync(join(tmpdir(), "fhir-zod-fixtures-"));
  try {
    const r4Dir = downloadAndExtract(scratchDir, "r4");
    const uscoreDir = downloadAndExtract(scratchDir, "uscore");

    mkdirSync(FIXTURES_DIR, { recursive: true });
    mkdirSync(join(FIXTURES_DIR, "valuesets"), { recursive: true });
    mkdirSync(join(FIXTURES_DIR, "examples"), { recursive: true });

    // 1. Base R4 Patient.
    const r4Patient = readStructureDefinition(r4Dir, "StructureDefinition-Patient.json");
    writeFixture("r4-patient.fhirschema.json", translate(r4Patient as any));

    // 2. US Core Patient profile (extensions + restated required bindings).
    const uscorePatient = readStructureDefinition(uscoreDir, "StructureDefinition-us-core-patient.json");
    writeFixture("uscore-patient.fhirschema.json", translate(uscorePatient as any));

    // 3. US Core Blood Pressure (slicing + choice types).
    const uscoreBp = readStructureDefinition(uscoreDir, "StructureDefinition-us-core-blood-pressure.json");
    writeFixture("uscore-blood-pressure.fhirschema.json", translate(uscoreBp as any));

    // 4. ValueSets/CodeSystems needed to expand the `required` bindings the
    // three fixtures above actually reference: Patient.gender (both
    // fixtures) and US Core Patient's telecom.system / telecom.use.
    const terminology = [
      "ValueSet-administrative-gender.json",
      "CodeSystem-administrative-gender.json",
      "ValueSet-contact-point-system.json",
      "CodeSystem-contact-point-system.json",
      "ValueSet-contact-point-use.json",
      "CodeSystem-contact-point-use.json",
    ];
    for (const fileName of terminology) {
      copyFixture(join(r4Dir, fileName), join("valuesets", fileName));
    }

    // 5. A conformant US Core Patient example from the package's own
    // example/ dir (declares the us-core-patient profile in meta.profile).
    copyFixture(
      join(uscoreDir, "example", "Patient-example.json"),
      join("examples", "uscore-patient-example.json")
    );

    console.log("\nDone. Review `git diff --stat fixtures/` before committing.");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main();
