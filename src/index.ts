export * from "./fhir-schema-types.js";
export * from "./mapper.js";
export * from "./generate.js";
// The adoptable pieces per design doc section 3: merge/ (ResolvedSchema) and
// emit/ ((ResolvedSchema) => string). mapper.js above is the legacy
// FhirSchemaDocument-in compat shim; these are the real Phase 3 contract.
export * from "./merge/index.js";
export * from "./emit/index.js";
