import { describe, it, expect } from "vitest";
import { emitDocument } from "./emit.js";
import { PRIMITIVE_REGEX_TYPES, anchorFhirRegex } from "./primitive-regex.js";
import type { ResolvedElement, ResolvedSchema } from "../merge/index.js";

function el(overrides: Partial<ResolvedElement> & Pick<ResolvedElement, "type">): ResolvedElement {
  return { array: false, min: 0, max: undefined, required: false, ...overrides };
}

function schema(elements: Record<string, ResolvedElement>): ResolvedSchema {
  return { name: "TestResource", url: "http://example.org/T", type: "TestResource", kind: "resource", elements };
}

/** The real R4 regexes, as extracted from the package's own StructureDefinitions. */
const R4 = {
  id: "[A-Za-z0-9\\-\\.]{1,64}",
  code: "[^\\s]+(\\s[^\\s]+)*",
  date: "([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?",
  uri: "\\S*",
  string: "[ \\r\\n\\t\\S]+",
  boolean: "true|false",
};

describe("anchorFhirRegex", () => {
  it("anchors, because FHIR regexes are whole-string but Zod's .regex() is a substring test", () => {
    // The bug this exists to prevent: an unanchored /[A-Za-z0-9\-\.]{1,64}/
    // matches *inside* "bad id!", so the constraint silently accepts garbage.
    const anchored = new RegExp(anchorFhirRegex(R4.id));
    expect(anchored.test("patient-1")).toBe(true);
    expect(anchored.test("bad id!")).toBe(false);
    expect(new RegExp(R4.id).test("bad id!")).toBe(true);
  });

  it("wraps in a non-capturing group so a top-level alternation can't escape the anchors", () => {
    // /^true|false$/ parses as /(^true)|(false$)/ — it would accept
    // "falsehood". The group is what makes anchoring actually bind.
    const anchored = new RegExp(anchorFhirRegex(R4.boolean));
    expect(anchored.test("true")).toBe(true);
    expect(anchored.test("truthy")).toBe(false);
    expect(anchored.test("nonsense-false")).toBe(false);
  });

  it("accepts a real conformant date and rejects a malformed one", () => {
    const anchored = new RegExp(anchorFhirRegex(R4.date));
    for (const ok of ["2020", "2020-08", "2020-08-21"]) expect(anchored.test(ok)).toBe(true);
    for (const bad of ["2020-13-01", "20-08-21", "2020-08-21T00:00:00Z"]) expect(anchored.test(bad)).toBe(false);
  });
});

describe("PRIMITIVE_REGEX_TYPES", () => {
  it("covers the structurally meaningful string primitives", () => {
    for (const t of ["id", "code", "oid", "uuid", "base64Binary", "date", "dateTime", "instant", "time"]) {
      expect(PRIMITIVE_REGEX_TYPES.has(t)).toBe(true);
    }
  });

  it("excludes primitives we don't emit as strings — their regex describes a serialization we never produce", () => {
    // `integer`'s regex is "-?([0]|([1-9][0-9]*))", which can only ever be
    // applied to a string; we emit z.number().int().
    for (const t of ["boolean", "integer", "decimal", "positiveInt", "unsignedInt", "integer64"]) {
      expect(PRIMITIVE_REGEX_TYPES.has(t)).toBe(false);
    }
  });

  it("excludes uri/url/canonical and string/markdown, per the documented conformance rules", () => {
    // uri/url/canonical stay plain z.string() (CLAUDE.md); string/markdown's
    // regex only means "non-empty", which isn't worth new rejection surface.
    for (const t of ["uri", "url", "canonical", "string", "markdown"]) {
      expect(PRIMITIVE_REGEX_TYPES.has(t)).toBe(false);
    }
  });
});

describe("emitted output", () => {
  const primitiveRegex = { id: R4.id, code: R4.code, date: R4.date, uri: R4.uri, string: R4.string };

  it("applies the regex to an eligible primitive", () => {
    const { source } = emitDocument(schema({ id: el({ type: "id", required: true }) }), { primitiveRegex });
    expect(source).toContain(`z.string().regex(/^(?:${R4.id})$/)`);
  });

  it("leaves uri and string untouched even when a regex is supplied for them", () => {
    const { source } = emitDocument(
      schema({ system: el({ type: "uri", required: true }), text: el({ type: "string", required: true }) }),
      { primitiveRegex }
    );
    expect(source).toContain('"system": z.string(),');
    expect(source).toContain('"text": z.string(),');
    expect(source).not.toContain(".regex(");
  });

  it("emits exactly today's output when no regex map is supplied — an adopter opting out loses nothing else", () => {
    const withOut = emitDocument(schema({ id: el({ type: "id", required: true }) })).source;
    expect(withOut).toContain('"id": z.string(),');
    expect(withOut).not.toContain(".regex(");
  });

  it("emits nothing for a type absent from the map, rather than inventing a pattern", () => {
    const { source } = emitDocument(schema({ when: el({ type: "instant", required: true }) }), { primitiveRegex });
    expect(source).toContain('"when": z.string(),');
  });

  it("lets a required binding's z.enum win — an enum is already stricter than the code regex", () => {
    const { source } = emitDocument(
      schema({ status: el({ type: "code", required: true, binding: { strength: "required", valueSet: "http://vs" } }) }),
      {
        primitiveRegex,
        terminology: {
          getValueSet: () => ({ resourceType: "ValueSet", url: "http://vs", compose: { include: [{ system: "http://cs" }] } }),
          getCodeSystem: () => ({ resourceType: "CodeSystem", url: "http://cs", concept: [{ code: "final" }] }),
        } as never,
      }
    );
    expect(source).toContain('z.enum(["final"])');
    expect(source).not.toContain(".regex(");
  });

  it("still applies the regex when a required binding could NOT be expanded, since the fallback is a bare string", () => {
    const { source } = emitDocument(
      schema({ status: el({ type: "code", required: true, binding: { strength: "required", valueSet: "http://missing" } }) }),
      { primitiveRegex }
    );
    expect(source).toContain(".regex(");
    expect(source).toContain("TODO(defect 2)");
  });

  it("applies inside arrays, to the element rather than the array", () => {
    const { source } = emitDocument(schema({ ids: el({ type: "id", array: true, required: true }) }), { primitiveRegex });
    expect(source).toContain(`z.array(z.string().regex(/^(?:${R4.id})$/))`);
  });
});
