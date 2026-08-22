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
 * Genuine false rejections that are filed but not yet fixed. **Currently
 * empty** — every matched example in all four packages validates.
 *
 * Empty is a meaningful state here, not an unused feature: the second
 * assertion below means any regression that rejects conformant data fails
 * the build immediately, with the offending file and its Zod issues in the
 * message. Keep the shape (and the per-package keys) rather than deleting
 * it — the next false rejection should land here with an issue number, not
 * quietly widen the gate.
 *
 * Entries are for false *rejections* only, never "known gaps" like
 * choice-type flattening or slicing, which degrade to z.unknown() and
 * reject nothing extra.
 *
 * The three root causes this list was created for are all fixed now, and
 * every entry they accounted for is gone:
 *   - issue #23 (`extension` resolving `array: false`, because
 *     specializations never merged over their base and `array: true` is
 *     stated only on DomainResource) — 32 examples, all four packages.
 *   - issue #24 (a primitive-typed element carrying an extension slice's
 *     own `elements.extension` submap emitted as `z.object({extension})`
 *     rather than its real primitive type) — 4 examples.
 *   - issue #27 (a required primitive whose value FHIR permits to be
 *     carried in its `_<field>` sibling) — 1 example.
 */
const KNOWN_FAILURES: Record<string, string[]> = {
  "hl7.fhir.us.core#6.1.0": [],
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
