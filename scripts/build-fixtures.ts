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
 *   4. Convert the complex-type StructureDefinitions that base R4 Patient's
 *      elements (and US Core Blood Pressure's components) reference, into
 *      fixtures/datatypes/ — see DATATYPES below for the closed set and why
 *      it's closed.
 *   4b. Convert US Core Blood Pressure's full base chain
 *      (us-core-blood-pressure -> us-core-vital-signs -> vitalsigns ->
 *      Observation) so merge/'s multi-level profile resolution (issue #5)
 *      has real fixtures to walk, not just the leaf profile.
 *   4c. Convert US Core Observation Pregnancy Status
 *      (uscore-observation-pregnancystatus.fhirschema.json) — see
 *      docs/design/slicing-design.md §1's fixture-gap callout: our only
 *      other slicing fixture (blood pressure's `component`) uses a `pattern`
 *      discriminator with `path:"code"` (a sub-path of the sliced element).
 *      This profile's `category` is sliced with `path:"$this"` (a
 *      whole-element pattern match) — the IG's dominant shape (24 of 29 raw
 *      discriminators in hl7.fhir.us.core#6.1.0, per that doc's appendix),
 *      unverified until this fixture. Chosen over the other candidate named
 *      in that doc (US Core Practitioner's `identifier`, also `$this`)
 *      because it needs zero new base-resource or datatype fixtures — its
 *      base is plain Observation (already fixture'd) and its element types
 *      (CodeableConcept, Reference) are already in DATATYPES below, so this
 *      is a single additive file isolating exactly the one new variable.
 *   4d. Convert DomainResource and Resource — the `specialization` half of
 *      every resource's base chain (issue #23). Patient's own document
 *      restates none of `id`/`meta`/`text`/`contained`/`extension`; they
 *      live one and two levels up, and `DomainResource.extension` is the
 *      only place `array: true` is stated for it.
 *   5. Copy the ValueSet/CodeSystem pairs needed to expand the `required`
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

/**
 * Complex-type StructureDefinitions that fixtures/r4-patient.fhirschema.json
 * and fixtures/uscore-blood-pressure.fhirschema.json reference by `type`,
 * needed so Phase 2's merge/ can resolve a profile element's type (e.g.
 * "name": {type:"HumanName"}) down to its concrete leaf fields (e.g.
 * name.family: string).
 *
 * This set is verified closed: translating each of these 10 and walking
 * their own `elements` for further complex-type references yields only
 * types already in this list (or primitives). The one type that is NOT
 * closed is Extension — its `value[x]` choice group alone references 15
 * more narrow datatypes (Age, ContactDetail, Contributor, Count,
 * DataRequirement, Distance, Dosage, Duration, Expression, Money,
 * ParameterDefinition, RelatedArtifact, Signature, Timing,
 * TriggerDefinition, UsageContext) that exist *only* to be Extension.value
 * choices and are not otherwise used by these three fixtures. Extension is
 * deliberately NOT included here — see src/merge/resolve.ts's module
 * comment for how merge/ handles a type name with no SchemaSource entry.
 */
const DATATYPES = [
  "Address",
  "Attachment",
  "CodeableConcept",
  "Coding",
  "ContactPoint",
  "HumanName",
  "Identifier",
  "Period",
  "Quantity",
  "Reference",
  // Added for issue #5 (multi-level profile chains): US Core Blood
  // Pressure's base chain bottoms out at Observation, whose component
  // value[x] choice group references these four. Verified closed the same
  // way as the set above: translating each and walking its own `elements`
  // for further complex-type references yields only types already in this
  // list (or primitives) — EXCEPT Timing (see below), which is why Timing
  // is deliberately excluded here rather than added.
  "Annotation",
  "Range",
  "Ratio",
  "SampledData",
  // Added for issue #23 (specializations inherit from their base). Element
  // is what every complex type above specializes, so it's where their
  // `id`/`extension` come from; Narrative and Meta are the two types
  // DomainResource/Resource reference (`text`, `meta`) and would otherwise
  // resolve to a concrete-but-unexpanded type on every resource fixture.
  // Verified closed the same way as the sets above: Element's own elements
  // are `id` (primitive) and `extension` (Extension, deliberately excluded
  // throughout), Narrative's are `status`/`div` (both primitive), and
  // Meta's further references (Coding) are already listed here.
  "Element",
  "Narrative",
  "Meta",
  // Added for issue #27. Every BackboneElement inherits `modifierExtension`
  // from here and `id`/`extension` from Element, and no profile ever
  // restates them — so without this fixture the set again misrepresents
  // every inline backbone structure as having no inherited fields.
  "BackboneElement",
  // NOT included: Timing. Observation.effectiveTiming (a choice-type
  // variant) references it, but Timing's own elements pull in Element ->
  // Extension, and Extension.value[x] alone references 15 more datatypes
  // that exist only to be Extension values (the same non-closure documented
  // above for why Extension itself is excluded). Adding Timing would nearly
  // double this list for a branch nothing here needs expanded. merge/
  // already handles this: a type name with no SchemaSource entry resolves
  // to a concrete `type: "Timing"` with `elements` left unexpanded — the
  // same treatment Extension already gets, not an error.
];

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
    mkdirSync(join(FIXTURES_DIR, "datatypes"), { recursive: true });
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

    // 3b. US Core Blood Pressure's full base chain (issue #5): its base is
    // us-core-vital-signs (a US Core profile), whose base is vitalsigns (a
    // FHIR core profile), whose base is Observation (the true base
    // resource). Committing all three lets merge/'s multi-level resolution
    // be tested against real converter output end-to-end, not just stubs.
    const uscoreVitalSigns = readStructureDefinition(
      uscoreDir,
      "StructureDefinition-us-core-vital-signs.json"
    );
    writeFixture("uscore-vital-signs.fhirschema.json", translate(uscoreVitalSigns as any));

    const vitalsigns = readStructureDefinition(r4Dir, "StructureDefinition-vitalsigns.json");
    writeFixture("vitalsigns.fhirschema.json", translate(vitalsigns as any));

    const observation = readStructureDefinition(r4Dir, "StructureDefinition-Observation.json");
    writeFixture("observation.fhirschema.json", translate(observation as any));

    // 4c. US Core Observation Pregnancy Status — see the module comment's
    // step 4c for why this profile specifically (a `$this`-path pattern
    // discriminator on `category`, sitting directly on base Observation, no
    // new datatype fixtures needed).
    const uscorePregnancyStatus = readStructureDefinition(
      uscoreDir,
      "StructureDefinition-us-core-observation-pregnancystatus.json"
    );
    writeFixture("uscore-observation-pregnancystatus.fhirschema.json", translate(uscorePregnancyStatus as any));

    // 4d. The *specialization* half of every base chain (issue #23).
    // `translate()` emits only each layer's own differential, so base R4
    // Patient's document has no `extension`/`id`/`meta` entry at all — those
    // live on DomainResource and Resource, which Patient inherits from via
    // `derivation: "specialization"` rather than `"constraint"`. Without
    // these two fixtures the fixture set silently misrepresents every
    // resource as having no inherited fields, which is exactly why #23 went
    // unnoticed: `DomainResource.extension` is where `array: true` actually
    // lives. Element is the datatype-side counterpart (HumanName and every
    // other complex type specialize it, inheriting `id`/`extension`).
    for (const [fixtureName, sdFile] of [
      ["r4-domainresource.fhirschema.json", "StructureDefinition-DomainResource.json"],
      ["r4-resource.fhirschema.json", "StructureDefinition-Resource.json"],
    ] as const) {
      writeFixture(fixtureName, translate(readStructureDefinition(r4Dir, sdFile) as any));
    }

    // 4. Complex-type datatype schemas — see DATATYPES above.
    for (const name of DATATYPES) {
      const sd = readStructureDefinition(r4Dir, `StructureDefinition-${name}.json`);
      writeFixture(`datatypes/${name}.fhirschema.json`, translate(sd as any));
    }

    // 5. ValueSets/CodeSystems needed to expand the `required` bindings the
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

    // 6. A conformant US Core Patient example from the package's own
    // example/ dir (declares the us-core-patient profile in meta.profile).
    copyFixture(
      join(uscoreDir, "example", "Patient-example.json"),
      join("examples", "uscore-patient-example.json")
    );

    // 7. Raw StructureDefinitions, copied verbatim (issue #32).
    //
    // Every other fixture here is converter *output*. These three are
    // converter *input*, because slice-match recovery exists precisely to
    // read what the converter didn't carry across — a converted document
    // cannot be the fixture for that. Chosen as the smallest real
    // definitions covering the three distinct shapes:
    //
    //   patient-citizenship          extension slicing; the discriminating
    //                                `fixedUri` sits one level down on
    //                                `extension:code.url`. This is the
    //                                dominant shape (302 of 379 recoverable
    //                                pattern entries across seven packages).
    //   us-core-observation-lab      `patternCodeableConcept` on the slice
    //                                head itself, and the case where the
    //                                converter wrote "[Circular Reference]"
    //                                over its copy.
    //   example-composition          two sliced elements with no pattern
    //                                anywhere — the negative case, which
    //                                must stay unrecovered rather than
    //                                acquire an invented match.
    for (const [dir, sdFile] of [
      [r4Dir, "StructureDefinition-patient-citizenship.json"],
      [uscoreDir, "StructureDefinition-us-core-observation-lab.json"],
      [r4Dir, "StructureDefinition-example-composition.json"],
    ] as const) {
      copyFixture(join(dir, sdFile), join("raw", sdFile));
    }

    console.log("\nDone. Review `git diff --stat fixtures/` before committing.");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main();
