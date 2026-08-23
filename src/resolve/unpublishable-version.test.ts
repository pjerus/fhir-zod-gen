/**
 * Issue #48. A `#current` dependency is unresolvable by construction — it
 * names a build.fhir.org CI build, and the release registry serves published
 * versions only — but the warning read like a transient fetch failure, which
 * is misleading enough that it sent someone hunting for a cost that wasn't
 * there. These pin both halves: what counts as unpublishable, and that the
 * message says so.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unpublishableVersionKind } from "./closure.js";
import { installPackageClosure } from "./install.js";

describe("unpublishableVersionKind", () => {
  it.each([
    ["current", "ci-build"],
    ["current$main", "ci-build"],
    ["current$some-feature-branch", "ci-build"],
    ["dev", "local-dev"],
  ])("classifies %s as %s", (version, expected) => {
    expect(unpublishableVersionKind(version)).toBe(expected);
  });

  it.each(["4.0.1", "2.0.1", "1.1.0-ballot", "2.1.0-preview", "5.0.x"])(
    "leaves the ordinary version %s alone",
    (version) => {
      expect(unpublishableVersionKind(version)).toBeUndefined();
    }
  );

  it("does not claim `latest`, which the registry does serve", () => {
    // Per fhir-package-loader: latest is "the most recent published version",
    // retrieved from packages.fhir.org. Resolvable, so not our business.
    expect(unpublishableVersionKind("latest")).toBeUndefined();
  });

  it("does not mistake a version that merely starts with the word", () => {
    expect(unpublishableVersionKind("currently")).toBeUndefined();
    expect(unpublishableVersionKind("development")).toBeUndefined();
  });
});

let cacheDir: string;

function writeFixturePackage(id: string, version: string, dependencies: Record<string, string> = {}): void {
  const dir = join(cacheDir, `${id}#${version}`, "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version, dependencies }), "utf-8");
  writeFileSync(join(dir, ".index.json"), JSON.stringify({ "index-version": 1, files: [] }), "utf-8");
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-unpublishable-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("the warning for a dependency that cannot be published", () => {
  async function warningsFor(depVersion: string): Promise<string[]> {
    writeFixturePackage("test.root", "1.0.0", { "test.dep": depVersion });
    const warnings: string[] = [];
    await installPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a", onWarn: (m) => warnings.push(m) }
    );
    // Specifically the per-dependency warning. The cascade-failure warning
    // that precedes it quotes the installer's error verbatim, so it mentions
    // the dependency too.
    return warnings.filter((w) => w.startsWith("Skipping dependency test.dep"));
  }

  it("says a ci-build version cannot be resolved, rather than implying a failed fetch", async () => {
    const [warning] = await warningsFor("current");
    expect(warning).toMatch(/continuous-integration build on build\.fhir\.org/);
    expect(warning).toMatch(/serves published versions only/);
    // The specific misreading this issue exists to prevent.
    expect(warning).not.toMatch(/could not be downloaded/);
  });

  it("says a cached copy of another version won't help", async () => {
    // Verified in the wild: davinci-crd 2.0.1 AND 2.2.1 sit in the cache and
    // neither satisfies davinci-dtr's `current` dependency.
    const [warning] = await warningsFor("current");
    expect(warning).toMatch(/no amount of cached copies of other versions will satisfy it/);
  });

  it("says it is free when nothing resolves through it", async () => {
    const [warning] = await warningsFor("current");
    expect(warning).toMatch(/costs you nothing/);
  });

  it("points at the remedy that exists — naming a published version as another input", async () => {
    const [warning] = await warningsFor("current");
    expect(warning).toMatch(/name a published version of test\.dep as an additional input/);
  });

  it("distinguishes a local dev build from a ci-build", async () => {
    const [warning] = await warningsFor("dev");
    expect(warning).toMatch(/local development build in the package cache/);
    expect(warning).not.toMatch(/build\.fhir\.org/);
  });

  it("still gives the underlying cause for an ordinary version that genuinely failed", async () => {
    const [warning] = await warningsFor("9.9.9");
    expect(warning).toMatch(/could not be downloaded/);
    expect(warning).toMatch(/costs you nothing/);
  });
});
