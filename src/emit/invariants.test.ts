/**
 * What this module is allowed to translate — and, more importantly, what it
 * must refuse. A mistranslated invariant falsely rejects conformant data,
 * which this project treats as worse than not enforcing the rule at all
 * (same principle as "never a partial enum"), so most of these tests assert
 * a refusal rather than a translation.
 */

import { describe, it, expect } from "vitest";
import { translateInvariant } from "./invariants.js";

const plainChildren = {
  low: {},
  high: {},
  text: {},
};

/** An Observation.component-shaped scope: a value[x] choice group plus an ordinary sibling. */
const choiceChildren = {
  value: { choices: ["valueQuantity", "valueString"] },
  valueQuantity: { choiceOf: "value" },
  valueString: { choiceOf: "value" },
  dataAbsentReason: {},
};

describe("translateInvariant", () => {
  it("translates an n-ary exists-or into one operand per term", () => {
    const result = translateInvariant(
      "obs-3",
      { expression: "low.exists() or high.exists() or text.exists()", human: "Must have at least a low or a high or text", severity: "error" },
      { children: plainChildren }
    );
    expect(result).toEqual({
      id: "obs-3",
      human: "Must have at least a low or a high or text",
      operands: [["low"], ["high"], ["text"]],
    });
  });

  it("resolves a choice-group operand to the variant keys the object actually emits", () => {
    // vs-3. `value` is never a real JSON key — reading it as one would make
    // this rule fail on every instance, including the ones carrying a
    // perfectly good valueQuantity.
    const result = translateInvariant(
      "vs-3",
      { expression: "value.exists() or dataAbsentReason.exists()", human: "…", severity: "error" },
      { children: choiceChildren }
    );
    expect(result?.operands).toEqual([["valueQuantity", "valueString"], ["dataAbsentReason"]]);
  });

  it("tolerates the whitespace and parens real profiles write", () => {
    const result = translateInvariant(
      "con-1",
      { expression: "(summary.exists()   or\n assessment.exists())", human: "…", severity: "error" },
      { children: { summary: {}, assessment: {} } }
    );
    expect(result?.operands).toEqual([["summary"], ["assessment"]]);
  });

  it("refuses a warning-severity rule — FHIR means those as advice, not rejection", () => {
    expect(
      translateInvariant(
        "sdcqr-1",
        { expression: "subject.exists() or author.exists()", human: "…", severity: "warning" },
        { children: { subject: {}, author: {} } }
      )
    ).toBeUndefined();
  });

  it("refuses the whole rule when a single operand names something this object doesn't emit", () => {
    // No partial enforcement: `high` resolving is not a licence to enforce
    // half of obs-3.
    expect(
      translateInvariant(
        "obs-3",
        { expression: "low.exists() or high.exists() or text.exists()", human: "…", severity: "error" },
        { children: { high: {}, text: {} } }
      )
    ).toBeUndefined();
  });

  it("refuses a dotted operand", () => {
    // bdl-9's `identifier.system.exists()` reaches into a nested object,
    // whose empty-collection semantics this translator doesn't implement.
    expect(
      translateInvariant(
        "bdl-9",
        { expression: "identifier.system.exists() or identifier.value.exists()", human: "…", severity: "error" },
        { children: { identifier: {} } }
      )
    ).toBeUndefined();
  });

  it.each([
    ["us-core-6 (xor)", "(family.exists() or given.exists()) xor extension.where(url='x').exists()"],
    ["qrs-1 (negated and)", "(answer.exists() and item.exists()).not()"],
    ["us-core-7 (implies)", "(status='completed') implies performed.exists()"],
    ["cpl-3 (empty, not exists)", "detail.empty() or reference.empty()"],
    ["pd-1 (bare names)", "telecom or endpoint"],
    ["single exists", "subject.exists()"],
  ])("refuses %s", (_label, expression) => {
    expect(
      translateInvariant("x", { expression, human: "…", severity: "error" }, { children: plainChildren })
    ).toBeUndefined();
  });

  it("refuses a rule with no expression at all", () => {
    expect(translateInvariant("x", { human: "…", severity: "error" }, { children: plainChildren })).toBeUndefined();
  });
});
