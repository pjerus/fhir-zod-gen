/**
 * Offline: installPackageClosure's `skipTerminology` path (issue #9).
 * `us.nlm.vsac` is declared as a dependency but deliberately never written
 * to disk in these fixtures. With `registryUrl: "n/a"` (no network) and
 * skipTerminology excluding it from the walk before any download is
 * attempted, a regression that stopped excluding it would either surface it
 * in the result (assertion failure below) or throw trying to reach a
 * disabled registry to download it — there's no quiet way for this test to
 * pass against broken exclusion logic.
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
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-install-skip-terminology-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("installPackageClosure with skipTerminology", () => {
  it("never touches a terminology-only dependency, and doesn't warn about it being missing", async () => {
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0", "us.nlm.vsac": "0.1.0" });
    writeFixturePackage("test.dep-a", "1.0.0");

    const warnings: string[] = [];
    const { primary, packages } = await installPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a", skipTerminology: true, onWarn: (m) => warnings.push(m) }
    );

    expect(primary.name).toBe("test.root");
    expect(packages.map((p) => p.name).sort()).toEqual(["test.dep-a", "test.root"]);
    expect(warnings.join("\n")).not.toMatch(/vsac/);
  });

  it("keeps ordinary (non-terminology) dependencies exactly as the default path would", async () => {
    writeFixturePackage("test.root", "1.0.0", { "test.dep-a": "1.0.0" });
    writeFixturePackage("test.dep-a", "1.0.0");

    const { packages } = await installPackageClosure(
      { id: "test.root", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a", skipTerminology: true }
    );

    expect(packages.map((p) => p.name).sort()).toEqual(["test.dep-a", "test.root"]);
  });
});
