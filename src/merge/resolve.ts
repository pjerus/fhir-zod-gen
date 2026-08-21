/**
 * Profile-over-base element resolution. Pure — no network, no fs reads.
 * Every lookup goes through the injected SchemaSource (see schema-source.ts);
 * this file never touches the outside world. That's what lets Phase 4 swap
 * a real IG-package-backed SchemaSource in without touching a line here.
 *
 * ## Why a profile needs its base at all
 *
 * A FHIR profile (`derivation: "constraint"`) only restates what it
 * *narrows* — concrete `type`/`array`/`min`/`max` live on the base resource
 * it derives from (design doc section 1, defect 4). Resolving a profile
 * means merging its (partial) elements over its base's (complete) elements,
 * recursively — the same operation applies again one level down whenever an
 * element's `type` names another complex type (e.g. "name" -> HumanName),
 * since a resolved element's own field list comes from that type's
 * StructureDefinition, not from the profile.
 *
 * ## Merge semantics
 *
 * Profile narrows base: where profile and base both specify a field,
 * profile wins; where profile is silent, base value is inherited. This
 * applies field-by-field, including the `required` array that governs a
 * node's *children* (see resolveOneElement below) — a profile that doesn't
 * restate `required` on some element inherits the base type's required
 * children rather than resetting them to "none required". Verified against
 * fixtures/r4-patient.fhirschema.json's `communication.required: ["language"]`:
 * US Core Patient's own `communication` element doesn't restate `required`,
 * yet `communication.language` must still resolve as required — proof this
 * is inheritance, not a reset.
 *
 * A profile is expected to only ever *tighten* (e.g. min 0->1), never
 * widen. That expectation is now load-bearing, not just aspirational: a
 * `required` array converted from a StructureDefinition's *differential*
 * (which is what `@atomic-ehr/fhirschema`'s `translate()` reads — see the
 * design doc's defect 4) only lists the children THIS layer's differential
 * newly marks required, not a complete restatement of everything required
 * so far. Confirmed against real data: `us-core-vital-signs`'s own
 * `required` is `["category"]` alone — `status`/`code`/`subject`/`effective`
 * are also required (inherited unchanged from its base `vitalsigns`, whose
 * own `required` array does list them), but the differential never
 * restates them because it didn't change them. A layer whose `required`
 * array is *defined* is therefore not "wholesale authoritative" the way an
 * earlier version of this comment claimed — the case that claim was
 * verified against (`uscore-patient` over `r4-patient`) merely never
 * exercised a base with its own non-empty required list, since
 * `r4-patient.required` is `undefined`. `resolveOneElement` computes each
 * child's `required` boolean as `thisLayerSaysRequired || baseAlreadyRequired`
 * (an OR, never a replace) precisely so that a differential's *silence*
 * about an already-required field can never read as "not required after
 * all". Because a valid FHIR profile can only add min (0->1), never remove
 * it, OR is also the semantically correct merge, not just the one that
 * happens to match observed data.
 *
 * ## Recursion, cycles, and why Extension is deliberately unexpanded
 *
 * Complex FHIR datatypes reference each other (Reference.identifier :
 * Identifier, Identifier.assigner : Reference), so naive recursive
 * expansion doesn't terminate. `resolveTypeElements` guards this with a
 * cache keyed by type name and states "creating" | "created": the first
 * call to expand a type marks it "creating" and recurses; a *re-entrant*
 * call for the same type while it's still "creating" is a genuine cycle —
 * that element gets `isCyclic: true` and its `elements` are left
 * unexpanded rather than recursing forever. This is a data-structure-level
 * guard, not Zod emission — Phase 3 decides whether `isCyclic` becomes a
 * `z.lazy()`.
 *
 * The same SchemaSource-not-found path (see resolveTypeElements) also
 * covers "Extension", which is deliberately NOT in the fixture-backed
 * SchemaSource used to test this module. Extension.value[x] alone
 * references 15 more narrow datatypes (Age, ContactDetail, Signature,
 * Timing, Dosage, ...) that exist only to be extension values and appear
 * nowhere else in these fixtures — expanding it would nearly double the
 * committed datatype fixture set for a branch Phase 3 handles separately
 * anyway (extension slicing gets "its own path" per the design doc's Phase
 * 3 section, and the generic `extension` catch-all element is emitted as a
 * cross-file reference per defect 5, not inlined). A type name with no
 * SchemaSource entry resolves to a concrete `type` string with `elements`
 * left undefined — NOT the same as defect 4's z.unknown(), since the type
 * itself is still known; there's just nothing further to expand it with.
 */

import {
  FHIR_PRIMITIVE_TYPES,
  type FhirSchemaDocument,
  type FhirSchemaElement,
} from "../fhir-schema-types.js";
import type { SchemaSource } from "./schema-source.js";
import type { ResolvedElement, ResolvedSchema } from "./resolved-schema.js";

const PRIMITIVE_TYPES = new Set<string>(FHIR_PRIMITIVE_TYPES);

type TypeExpansion =
  | { status: "resolved"; elements: Record<string, ResolvedElement> }
  | { status: "cyclic" }
  | { status: "not-found" };

type CacheEntry =
  | { state: "creating" }
  | { state: "created"; elements: Record<string, ResolvedElement> };

/**
 * Resolve one FHIR Schema document (profile or base resource) to a
 * ResolvedSchema with every element's type/array/min/max concrete.
 *
 * Walks the base chain recursively: a profile's base may itself be a
 * profile (`us-core-blood-pressure -> us-core-vital-signs -> vitalsigns ->
 * Observation` is four levels — 15 of 49 US Core resource profiles hit this
 * shape, see issue #5). Each layer resolves over the one beneath it,
 * outermost profile last, until a document with `derivation` other than
 * `"constraint"` (a true base resource/type) terminates the walk.
 *
 * Throws if `doc` (or any profile in its base chain) declares no base, or
 * if a base URL can't be resolved through `source` — without the base
 * there is no principled way to fill in the missing type/array/min/max, and
 * silently emitting z.unknown() there is exactly the defect this project
 * exists to fix. Also throws if the base chain is circular (A's base is B,
 * B's base is A, or a node reaches itself transitively) — that's malformed
 * input, not a case to walk forever or blow the stack on. This is a
 * document/URL-level cycle guard, a different axis from `resolveTypeElements`'s
 * type-name cache below: that one guards datatype recursion (Reference ->
 * Identifier -> Reference); this one guards the base-resource axis, and a
 * malformed base chain doesn't imply a malformed type graph or vice versa.
 */
export function resolveDocument(doc: FhirSchemaDocument, source: SchemaSource): ResolvedSchema {
  const cache = new Map<string, CacheEntry>();
  const { elements } = resolveDocumentOverBaseChain(doc, new Set<string>(), source, cache);

  return {
    name: doc.name,
    url: doc.url,
    type: doc.type,
    kind: doc.kind,
    base: doc.base,
    derivation: doc.derivation,
    elements,
  };
}

/**
 * Resolves `doc` over its full base chain (recursing until a non-profile
 * document terminates it), returning both the resolved elements and the
 * `required` array that was used to resolve `doc`'s own direct children —
 * the latter is only consumed by the caller one level up, to seed its own
 * `doc.required ?? ...` fallback; each individual child's `required`
 * *boolean* is what actually carries requiredness upward (see
 * resolveOneElement's OR-merge), not this array.
 *
 * `visitedUrls` accumulates every document URL already on the current
 * walk-up path (including `doc.url` itself, added before recursing into
 * its base) — revisiting any of them is a cycle.
 */
function resolveDocumentOverBaseChain(
  doc: FhirSchemaDocument,
  visitedUrls: Set<string>,
  source: SchemaSource,
  cache: Map<string, CacheEntry>
): { elements: Record<string, ResolvedElement>; required: string[] | undefined } {
  if (visitedUrls.has(doc.url)) {
    const chain = [...visitedUrls, doc.url].join(" -> ");
    throw new Error(
      `resolveDocument: circular base chain detected — "${doc.url}" is reached again while walking up ` +
        `its own base chain (${chain}). A profile's base chain must terminate at a base resource/type, ` +
        `not loop back on itself.`
    );
  }
  const nextVisitedUrls = new Set(visitedUrls);
  nextVisitedUrls.add(doc.url);

  if (doc.derivation !== "constraint") {
    // True base resource/type: nothing to merge over, its own elements are
    // already self-sufficient.
    return {
      elements: resolveElementMap(doc.elements ?? {}, undefined, doc.required, source, cache),
      required: doc.required,
    };
  }

  if (!doc.base) {
    throw new Error(
      `resolveDocument: "${doc.url}" is a profile (derivation: "constraint") but declares no base — ` +
        `there is nothing to resolve its narrowed elements against.`
    );
  }
  const baseDoc = source.getByUrl(doc.base);
  if (!baseDoc) {
    throw new Error(
      `resolveDocument: base "${doc.base}" for profile "${doc.url}" was not found via SchemaSource.getByUrl. ` +
        `A profile's concrete type/array/min/max live on its base — inject a SchemaSource that has it.`
    );
  }

  const baseResolved = resolveDocumentOverBaseChain(baseDoc, nextVisitedUrls, source, cache);
  const effectiveRequired = doc.required ?? baseResolved.required;

  return {
    elements: resolveElementMap(doc.elements ?? {}, baseResolved.elements, effectiveRequired, source, cache),
    required: effectiveRequired,
  };
}

/**
 * Merge a raw (profile-side) elements map with an already-resolved
 * (base-side) elements map into concrete ResolvedElements. `resolvedBase`
 * is undefined at the very root of a non-profile document (e.g. base R4
 * Patient resolved standalone — its own elements are already
 * self-sufficient, nothing to merge against) and populated everywhere else
 * a base actually exists.
 */
function resolveElementMap(
  rawElements: Record<string, FhirSchemaElement>,
  resolvedBaseElements: Record<string, ResolvedElement> | undefined,
  requiredNames: string[] | undefined,
  source: SchemaSource,
  cache: Map<string, CacheEntry>
): Record<string, ResolvedElement> {
  const names = new Set<string>([...Object.keys(rawElements), ...Object.keys(resolvedBaseElements ?? {})]);
  const result: Record<string, ResolvedElement> = {};
  for (const name of names) {
    result[name] = resolveOneElement(
      name,
      rawElements[name],
      resolvedBaseElements?.[name],
      requiredNames,
      source,
      cache
    );
  }
  return result;
}

function resolveOneElement(
  name: string,
  rawEl: FhirSchemaElement | undefined,
  resolvedBase: ResolvedElement | undefined,
  requiredNames: string[] | undefined,
  source: SchemaSource,
  cache: Map<string, CacheEntry>
): ResolvedElement {
  const type = rawEl?.type ?? resolvedBase?.type;
  const array = rawEl?.array ?? resolvedBase?.array ?? false;
  const min = rawEl?.min ?? resolvedBase?.min ?? 0;
  const max = rawEl?.max ?? resolvedBase?.max;
  // OR, not replace: `requiredNames` is converted from a differential, so
  // it only lists names THIS layer's differential newly marks required —
  // silence about a name doesn't mean "not required", it means "unchanged
  // from base". A name already required in `resolvedBase` (accumulated from
  // every layer beneath this one) must stay required regardless of whether
  // this layer's own list happens to restate it — see the module comment's
  // `us-core-vital-signs` example. A layer can only ever ADD requiredness
  // this way, never remove it, which matches FHIR's own narrowing-only rule
  // for profiles.
  const required = (requiredNames?.includes(name) ?? false) || (resolvedBase?.required ?? false);

  const resolved: ResolvedElement = {
    type: type ?? "unknown",
    array,
    min,
    max,
    required,
    binding: rawEl?.binding ?? resolvedBase?.binding,
    constraint: rawEl?.constraint ?? resolvedBase?.constraint,
    choices: rawEl?.choices ?? resolvedBase?.choices,
    choiceOf: rawEl?.choiceOf ?? resolvedBase?.choiceOf,
    mustSupport: rawEl?.mustSupport ?? resolvedBase?.mustSupport,
    short: rawEl?.short ?? resolvedBase?.short,
    refers: rawEl?.refers ?? resolvedBase?.refers,
    slicing: rawEl?.slicing ?? resolvedBase?.slicing,
    extensions: rawEl?.extensions ?? resolvedBase?.extensions,
  };

  if (!type) {
    // Neither this layer nor its base carries a type. Not expected from any
    // committed fixture (see resolveDocument's throws for the document-root
    // version of this gap) — left as a bare fallback rather than a thrown
    // error since this is one element deep in a tree the caller may still
    // want the rest of, not a whole-document resolution.
    return resolved;
  }

  let childResolvedBase = resolvedBase?.elements;

  if (!rawEl?.type && resolvedBase?.isCyclic) {
    // This exact node was already determined to be a cyclic dead-end when
    // its base was resolved (e.g. it's Reference.identifier reached again
    // through a later profile layer's overlay), and this layer doesn't
    // change its type. Preserve that terminal marker as-is rather than
    // asking resolveTypeElements again: the type-name cache is keyed
    // globally and by now reads "created" (the type's first, successful
    // expansion completed elsewhere), so a fresh lookup here would
    // "resurrect" the very structure this node exists to cut off —
    // reintroducing the cycle instead of stopping at it. Concretely:
    // Identifier -> assigner -> identifier(cyclic) -> [without this guard]
    // -> Identifier (cache hit, full elements) -> assigner -> identifier
    // (cyclic) -> ... forever, once Identifier is reached a second time via
    // a resolvedBase overlay rather than a fresh resolveTypeElements call.
    resolved.isCyclic = true;
    childResolvedBase = undefined;
  } else if (type === "BackboneElement") {
    // Inline structure only, defined directly on whichever layer (profile
    // or base) declared it — never looked up via SchemaSource.
  } else if (!PRIMITIVE_TYPES.has(type)) {
    const expansion = resolveTypeElements(type, source, cache);
    if (expansion.status === "cyclic") {
      resolved.isCyclic = true;
      childResolvedBase = undefined;
    } else if (expansion.status === "resolved") {
      childResolvedBase = expansion.elements;
    }
    // "not-found": SchemaSource has no document for this type name (e.g.
    // Extension). Keep whatever childResolvedBase already was — normally
    // undefined, since a type-not-found element has nothing upstream to
    // have populated it either.
  }
  // Primitives: no structure to expand; childResolvedBase stays whatever
  // resolvedBase already had (normally undefined).

  const rawNestedElements = rawEl?.elements;
  if (rawNestedElements || childResolvedBase) {
    resolved.elements = resolveElementMap(
      rawNestedElements ?? {},
      childResolvedBase,
      rawEl?.required,
      source,
      cache
    );
  }

  return resolved;
}

/**
 * Resolve a named complex type's own elements via SchemaSource, cached and
 * cycle-guarded by type name. Datatype documents (HumanName, Identifier,
 * ...) are themselves specializations with fully concrete elements already
 * (verified: every fixtures/datatypes/*.json has `derivation:
 * "specialization"`) — there's no profile layer to merge at this step, just
 * recursive expansion of each field's own type.
 */
function resolveTypeElements(
  typeName: string,
  source: SchemaSource,
  cache: Map<string, CacheEntry>
): TypeExpansion {
  const cached = cache.get(typeName);
  if (cached) {
    return cached.state === "creating" ? { status: "cyclic" } : { status: "resolved", elements: cached.elements };
  }

  const typeDoc = source.getByType(typeName);
  if (!typeDoc) {
    return { status: "not-found" };
  }

  cache.set(typeName, { state: "creating" });
  const elements = resolveElementMap(typeDoc.elements ?? {}, undefined, typeDoc.required, source, cache);
  cache.set(typeName, { state: "created", elements });
  return { status: "resolved", elements };
}
