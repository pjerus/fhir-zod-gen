/**
 * Offline end-to-end of the install path: a real tarball is extracted into a
 * throwaway package cache and read back through installPackageClosure() and
 * PackageSchemaSource — the same code the CLI runs for
 * `fhir-zod-gen hl7.fhir.us.core#6.1.0`, minus the download.
 *
 * The installer is constructed with `registryUrl: "n/a"`, which is
 * fhir-package-installer's hard registry-disabled mode: if anything in this
 * path tried to reach the network, the test would fail rather than quietly
 * download. That is what keeps `npm test` hermetic.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installPackageClosure } from "./install.js";
import { PackageSchemaSource } from "./package-schema-source.js";

const TARBALL = fileURLToPath(new URL("../../fixtures/packages/test.fhir.mini-1.0.0.tgz", import.meta.url));

let cacheDir: string;

beforeAll(() => {
  // Exactly what a download does: extract the tarball into
  // `<cache>/<id>#<version>/`, leaving the tarball's own `package/` prefix
  // as the resource directory (https://confluence.hl7.org/display/FHIR/FHIR+Package+Cache).
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-cache-"));
  const packageDir = join(cacheDir, "test.fhir.mini#1.0.0");
  mkdirSync(packageDir, { recursive: true });
  execFileSync("tar", ["-xzf", TARBALL, "-C", packageDir]);
});

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("installPackageClosure", () => {
  it("indexes a package that is already in the cache, without touching the registry", async () => {
    const { primary, packages } = await installPackageClosure(
      { id: "test.fhir.mini", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a" }
    );

    expect(primary.name).toBe("test.fhir.mini");
    expect(primary.version).toBe("1.0.0");
    expect(packages).toHaveLength(1);
    expect(primary.entries.filter((e) => e.resourceType === "StructureDefinition")).toHaveLength(3);
  });

  it("produces a SchemaSource merge/ can query", async () => {
    const { packages } = await installPackageClosure(
      { id: "test.fhir.mini", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a" }
    );
    const source = new PackageSchemaSource(packages);

    expect(source.getByType("Period")?.url).toBe("http://hl7.org/fhir/StructureDefinition/Period");
    expect(source.getByUrl("http://hl7.org/fhir/StructureDefinition/patient-birthTime")?.base).toBe(
      "http://hl7.org/fhir/StructureDefinition/Extension"
    );
  });

  it("fails loudly when the requested package is not cached and the registry is off", async () => {
    await expect(
      installPackageClosure({ id: "test.fhir.absent", version: "9.9.9" }, { cacheDir, registryUrl: "n/a" })
    ).rejects.toThrow();
  });
});
