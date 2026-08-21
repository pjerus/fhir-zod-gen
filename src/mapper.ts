/**
 * Backward-compat shim. The real emitter now lives in src/emit/ and
 * consumes a ResolvedSchema (src/merge/'s output) instead of a raw
 * FhirSchemaDocument — see
 * docs/superpowers/specs/2026-08-21-fhir-zod-gen-design.md section 3. This
 * file used to be the whole generator (mapping the *imagined* FHIR Schema
 * format straight to Zod source, with no base resolution); that's exactly
 * what produced defects 1/3/4/5/6 in the design doc's section 1.
 *
 * `generateSchemaFile` exists only so existing callers of the old
 * `FhirSchemaDocument -> source` contract (src/generate.ts, src/cli.ts) keep
 * working. It resolves with an *empty* SchemaSource, so it only produces
 * correct output for a document that's already self-sufficient — a base
 * resource whose elements all carry their own concrete type/array/min/max
 * (real base FHIR Schema output always does), not a profile that needs a
 * base merged in from elsewhere. Pass a profile through
 * `merge/resolveDocument` with a real SchemaSource and call
 * `emit/emitDocument` directly instead — that's the actual Phase 3
 * contract, and what src/defects.test.ts now does.
 */
import { resolveDocument, type SchemaSource } from "./merge/index.js";
import { emitDocument, type EmitResult } from "./emit/index.js";
import type { FhirSchemaDocument } from "./fhir-schema-types.js";

const EMPTY_SOURCE: SchemaSource = {
  getByUrl: () => undefined,
  getByType: () => undefined,
};

export function generateSchemaFile(doc: FhirSchemaDocument): EmitResult {
  return emitDocument(resolveDocument(doc, EMPTY_SOURCE));
}

export type { EmitResult as GenerateResult };
