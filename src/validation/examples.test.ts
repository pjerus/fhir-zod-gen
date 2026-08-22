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
 * Known, filed, genuine false rejections — not "known gaps" like
 * choice-type flattening or slicing (which degrade to z.unknown()/reject
 * nothing extra, and aren't in this list at all):
 *
 *   - issue #27: a primitive's extensions live in a sibling `_<field>` key
 *     that isn't modelled at all, so a *required* primitive supplied only
 *     via that sibling is rejected for being absent. US Core profiles
 *     QuestionnaireResponse.questionnaire as required and says to carry a
 *     non-FHIR form's URI in an extension on `_questionnaire`; this example
 *     does exactly that and has no `questionnaire` key.
 *
 * Both of the root causes this list was created for are now fixed, and
 * every entry they accounted for is gone from it:
 *   - issue #24 (a primitive-typed element carrying an extension slice's
 *     own `elements.extension` submap emitted as `z.object({extension})`
 *     rather than its real primitive type) — 4 examples.
 *   - issue #23 (`extension` resolving `array: false`, because
 *     specializations never merged over their base and `array: true` is
 *     stated only on DomainResource) — 32 examples across all four
 *     packages.
 */
const KNOWN_FAILURES: Record<string, string[]> = {
  "hl7.fhir.us.core#6.1.0": ["QuestionnaireResponse-glascow-coma-score.json"],
  "hl7.fhir.uv.sdc#3.0.0": [],
  "hl7.fhir.uv.genomics-reporting#2.0.0": [],
  "hl7.fhir.us.mcode#3.0.0": [],
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
