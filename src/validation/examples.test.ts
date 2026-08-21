/**
 * Runs validate-examples.ts's harness against every package this repo
 * already has a full offline closure for, and gates on the result.
 *
 * Gated per package with `describe.skipIf` on `hasExamples` — a package not
 * present in `~/.fhir/packages` (a fresh checkout / CI with an empty cache)
 * skips cleanly rather than failing, keeping the suite hermetic (CLAUDE.md:
 * "no network in the test suite"). `resolvePackage(..., {registryUrl: "n/a"})`
 * inside the harness additionally forbids any registry access outright, so
 * a *partially* cached package fails loudly instead of silently reaching
 * the network.
 *
 * ## The ratchet
 *
 * Mirrors defects.test.ts's it.fails() convention, generalized to a set
 * instead of one test per case (dozens of examples share the same two root
 * causes — see KNOWN_FAILURES below): every file NOT in KNOWN_FAILURES must
 * pass; every file IN KNOWN_FAILURES must currently fail. Either direction
 * flipping is a signal:
 *   - a new, undocumented failure -> a regression (or a genuinely new false
 *     rejection that needs its own issue).
 *   - a known failure starting to pass -> the underlying bug got fixed;
 *     remove it from KNOWN_FAILURES (don't leave a stale entry — an
 *     it.fails() that starts passing unnoticed is exactly the failure mode
 *     that convention exists to catch, and this mirrors it).
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { hasExamples, validatePackageExamples } from "./validate-examples.js";

const CACHE_DIR = join(homedir(), ".fhir", "packages");

/**
 * Known, filed, genuine false rejections — two distinct root causes, not
 * "known gaps" like choice-type flattening or slicing (which degrade to
 * z.unknown()/reject nothing extra, and aren't in this list at all):
 *
 *   - issue #23: an `extension`-slice-bearing element resolves with
 *     `array: false` instead of `true` (merge/resolve.ts). Real resources
 *     that actually carry extensions (the overwhelming common case for any
 *     mustSupport-heavy US-Core-style profile) get rejected outright.
 *   - issue #24: a primitive-typed element that also carries an extension
 *     slice's own `elements.extension` submap is emitted as
 *     `z.object({extension: ...})` instead of its real primitive type
 *     (emit/emit.ts's elementToZod: the `el.elements` branch is checked
 *     before the primitive-type branch). Confirmed on `canonical`
 *     (QuestionnaireResponse.questionnaire) and `string`
 *     (CodeSystem.concept.display, Questionnaire.item.text).
 */
const KNOWN_FAILURES: Record<string, string[]> = {
  "hl7.fhir.us.core#6.1.0": [
    "Condition-condition-SDOH-example.json",
    "Condition-condition-duodenal-ulcer.json",
    "Condition-encounter-diagnosis-example1.json",
    "Condition-encounter-diagnosis-example2.json",
    "Condition-health-concern-example.json",
    "Patient-child-example.json",
    "Patient-deceased-example.json",
    "Patient-example-targeted-provenance.json",
    "Patient-example.json",
    "Patient-infant-example.json",
    "QuestionnaireResponse-glascow-coma-score.json",
    "QuestionnaireResponse-hunger-vital-sign-example.json",
    "QuestionnaireResponse-phq-9-example.json",
    "QuestionnaireResponse-prapare-example.json",
  ],
  "hl7.fhir.uv.sdc#3.0.0": [
    "CodeSystem-CSPHQ9.json",
    "Questionnaire-SDOHCC-QuestionnaireHungerVitalSign.json",
    "Questionnaire-demographics.json",
    "Questionnaire-questionnaire-sdc-profile-example-PHQ9.json",
    "Questionnaire-questionnaire-sdc-profile-example-image-options.json",
    "Questionnaire-questionnaire-sdc-test-fhirpath-prepop-source-query.json",
  ],
  "hl7.fhir.uv.genomics-reporting#2.0.0": [
    "Observation-PolyGenicDiagnosticImpExample.json",
    "Observation-TxImp01.json",
    "Observation-TxImp02.json",
    "Observation-TxImp03.json",
    "Observation-TxImp04.json",
    "Observation-TxImp05.json",
    "Observation-TxImp06.json",
    "Observation-obs-idh-ex.json",
  ],
  "hl7.fhir.us.mcode#3.0.0": [
    "Condition-primary-cancer-condition-breast.json",
    "Condition-primary-cancer-condition-jenny-m.json",
    "Condition-primary-cancer-condition-nsclc.json",
    "Condition-secondary-cancer-condition-brain-mets.json",
    "Patient-cancer-patient-adam-everyman.json",
    "Patient-cancer-patient-eve-anyperson.json",
    "Patient-cancer-patient-jenny-m.json",
    "Patient-cancer-patient-john-anyperson.json",
    "Patient-gx-cancer-patient-adam-anyperson.json",
  ],
};

const PACKAGES = Object.keys(KNOWN_FAILURES);

for (const packageId of PACKAGES) {
  describe.skipIf(!hasExamples(packageId, CACHE_DIR))(`real IG examples validate — ${packageId}`, () => {
    it("every matched example either validates, or is a documented known false rejection", async () => {
      const { results, excluded } = await validatePackageExamples(packageId, { cacheDir: CACHE_DIR });
      const known = new Set(KNOWN_FAILURES[packageId] ?? []);

      const unexpectedFailures = results.filter((r) => !r.success && !known.has(r.file));
      const unexpectedPasses = results.filter((r) => r.success && known.has(r.file)).map((r) => r.file);

      const passCount = results.filter((r) => r.success).length;
      console.log(
        `${packageId}: ${passCount}/${results.length} real examples validate ` +
          `(${excluded.length} excluded — Bundles/no-resourceType/unresolvable, see the harness's own report if needed)`
      );

      expect(
        unexpectedFailures.map((r) => ({ file: r.file, matchedVia: r.matchedVia, issues: r.issues })),
        "new false rejection(s) not in KNOWN_FAILURES — either a regression, or a genuinely new bug that needs its own issue"
      ).toEqual([]);

      expect(
        unexpectedPasses,
        "known failure(s) now passing — the underlying bug was fixed; remove these from KNOWN_FAILURES"
      ).toEqual([]);
    });
  });
}
