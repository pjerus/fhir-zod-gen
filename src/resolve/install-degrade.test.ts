/**
 * Offline: installPackageClosure degrades a broken dependency instead of
 * aborting the whole run (issue #42 — hl7.fhir.us.davinci-pas#2.2.1 pulled
 * in us.nlm.vsac@0.18.0, a version the registry never published, and the
 * install() cascade's all-or-nothing failure meant zero output for the
 * other 12 dependencies that would have installed fine).
 *
 * `registryUrl: "n/a"` disables the registry, so any package not already
 * present in the fixture cache is guaranteed to fail its download the same
 * way a real 404 does — install.ts doesn't special-case 404 vs. any other
 * cause, so this is a faithful stand-in without touching the network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPackageClosure } from "./install.js";

let cacheDir: string;

function writeFixturePackage(id: string, version: string, dependencies: Record<string, string> = {}): void {
  const dir = join(cacheDir, `${id}#${version}`, "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version, dependencies }), "utf-8");
  writeFileSync(join(dir, ".index.json"), JSON.stringify({ "index-version": 1, files: [] }), "utf-8");
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-install-degrade-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("installPackageClosure degrading a broken dependency", () => {
  it("warns naming the dependency and its cause, and still returns a successful closure", async () => {
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0", "test.dep-broken": "9.9.9" });
    writeFixturePackage("test.dep-a", "1.0.0");
    // test.dep-broken is declared but never written to disk — with the
    // registry disabled, downloading it is guaranteed to fail.

    const warnings: string[] = [];
    const { primary, packages } = await installPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a", onWarn: (m) => warnings.push(m) }
    );

    expect(primary.name).toBe("test.root");
    expect(packages.map((p) => p.name).sort()).toEqual(["test.dep-a", "test.root"]);
    const dependencyWarning = warnings.find((w) => w.startsWith("Skipping dependency test.dep-broken#9.9.9"));
    expect(dependencyWarning).toBeDefined();
    expect(dependencyWarning).toMatch(/could not be downloaded/);
    // The warning must carry the actual cause, not swallow it.
    expect(dependencyWarning).toMatch(/registry.*disabled/i);
  });

  it("still throws when the primary package itself cannot be fetched", async () => {
    await expect(
      installPackageClosure({ id: "test.root-missing", version: "1.0.0" }, { cacheDir, registryUrl: "n/a" })
    ).rejects.toThrow();
  });

  it("degrades a dependency broken two levels down, not just a direct one", async () => {
    // A dependency-only failure must not be mistaken for a primary failure:
    // this closure has the primary readable but a nested dependency of
    // test.dep-a broken two levels deep from the root — degradation should
    // still reach it without special-casing depth.
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0" });
    writeFixturePackage("test.dep-a", "1.0.0", { "test.dep-nested-broken": "1.0.0" });

    const warnings: string[] = [];
    const { primary, packages } = await installPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a", onWarn: (m) => warnings.push(m) }
    );

    expect(primary.name).toBe("test.root");
    expect(packages.map((p) => p.name).sort()).toEqual(["test.dep-a", "test.root"]);
    expect(warnings.some((w) => w.startsWith("Skipping dependency test.dep-nested-broken#1.0.0"))).toBe(true);
  });
});
