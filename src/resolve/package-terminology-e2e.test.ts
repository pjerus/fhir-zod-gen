/**
 * Issue #10: enum expansion is real and unit-tested (terminology/expand.test.ts,
 * emit/emit.test.ts) but was never reachable through the code path the CLI
 * actually runs — generate.ts and cli.ts never constructed a TerminologySource,
 * so `ctx.terminology` was always undefined on the real code path and every
 * required binding took the degrade-to-z.string() branch.
 *
 * This test drives the exact same call sequence cli.ts's loadFromPackage()
 * and main() use — resolvePackage() then generatePackage() — offline, against
 * the fixture package's `.index.json`-discovered ValueSet/CodeSystem pair
 * (test-binding-status), so it fails if PackageTerminologySource is ever
 * unwired again without exercising the generator's actual entry points the
 * way emitDocument()-direct unit tests do not.
 *
 * Same offline pattern as install.test.ts: the tarball is extracted into a
 * throwaway package cache and read back with `registryUrl: "n/a"`, so nothing
 * here can reach the network.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePackage } from "../generate.js";
import { resolvePackage } from "./index.js";

const TARBALL = fileURLToPath(new URL("../../fixtures/packages/test.fhir.mini-1.0.0.tgz", import.meta.url));

let cacheDir: string;
let outDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fhir-zod-cache-"));
  const packageDir = join(cacheDir, "test.fhir.mini#1.0.0");
  mkdirSync(packageDir, { recursive: true });
  execFileSync("tar", ["-xzf", TARBALL, "-C", packageDir]);
  outDir = mkdtempSync(join(tmpdir(), "fhir-zod-generate-e2e-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

describe("terminology wiring through the real CLI path (resolvePackage -> generatePackage)", () => {
  it("emits z.enum([...]) for a required binding when resolvePackage's terminology is passed through", async () => {
    const resolved = await resolvePackage(
      { id: "test.fhir.mini", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a" }
    );

    const doc = resolved.documents.find((d) => d.name === "TestBindingResource");
    expect(doc).toBeDefined();

    const { filesWritten, failures } = await generatePackage(resolved.documents, {
      outDir,
      source: resolved.source,
      terminology: resolved.terminology,
    });

    expect(failures).toEqual([]);
    const generated = readFileSync(
      filesWritten.find((f) => f.endsWith("TestBindingResource.ts")) ?? "",
      "utf-8"
    );

    expect(generated).toContain('"status": z.enum(["active", "inactive", "entered-in-error"])');
    expect(generated).not.toContain("TODO(defect 2)");
  });

  it("still degrades to the primitive + TODO marker when terminology is omitted — proof the enum above isn't vacuous", async () => {
    const resolved = await resolvePackage(
      { id: "test.fhir.mini", version: "1.0.0" },
      { cacheDir, registryUrl: "n/a" }
    );

    const { filesWritten, warningCount } = await generatePackage(resolved.documents, {
      outDir,
      source: resolved.source,
      // terminology intentionally omitted — this is generate.ts's pre-#10 behaviour.
    });

    const generated = readFileSync(
      filesWritten.find((f) => f.endsWith("TestBindingResource.ts")) ?? "",
      "utf-8"
    );

    expect(generated).toContain('"status": z.string()');
    expect(generated).toContain("TODO(defect 2)");
    expect(warningCount).toBeGreaterThan(0);
  });
});
