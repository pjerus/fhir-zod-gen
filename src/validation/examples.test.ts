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
import { resolvePackage } from "../resolve/index.js";
import { resolveDocument } from "../merge/index.js";

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

/**
 * Issue #37. The harness used to emit only the profiles some example
 * matched, while the CLI emits every document in the package. Both wrote
 * byte-identical per-profile files, but the *shared datatype* files came
 * out of a different batch — which is how this suite reported 441/441
 * green at the same moment the CLI's own US Core output falsely rejected
 * 18 of that package's 174 published examples (#34).
 *
 * #34's fix made the shared files batch-independent, so the two agree
 * again today. This gate is what keeps them agreeing: it pins the *set*,
 * not the bytes. A byte comparison would pass vacuously right now and stop
 * catching anything the moment batch-sensitivity returned somewhere else.
 */
describe("the ratchet emits the package the CLI does", () => {
  for (const packageId of PACKAGES) {
    it.skipIf(!hasExamples(packageId, CACHE_DIR))(`covers every document in ${packageId}`, async () => {
      const { emittedDocumentUrls } = await validatePackageExamples(packageId, { cacheDir: CACHE_DIR });
      const { source, documents } = await resolvePackage(packageId, { cacheDir: CACHE_DIR, registryUrl: "n/a" });

      const emitted = new Set(emittedDocumentUrls);
      const missing = documents
        .filter((doc) => {
          try {
            resolveDocument(doc, source);
            return !emitted.has(doc.url);
          } catch {
            // merge/ refuses to guess at an unreachable base; the CLI
            // reports those as failures and emits nothing for them either.
            return false;
          }
        })
        .map((doc) => doc.url);

      expect(
        missing,
        "documents the CLI emits and this suite never validates — its green is narrower than the artifact"
      ).toEqual([]);
    });
  }
});
