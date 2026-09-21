/**
 * LP-D06 - job detail "Handling requirements" rendered the raw code "grooming safety:friendly" for a
 * pricing.requirements entry shaped `grooming_safety:friendly` (see app/mobile-app/grooming-flow.tsx).
 * The generic `label()` helper only replaces underscores with spaces, so the colon-joined code came
 * through almost verbatim instead of the "Safety: friendly" the desktop partner feed
 * (app/partner/jobs/page.tsx) already renders for the same data.
 *
 * requirementLabel() now recognises the known category prefixes and humanises an unknown one instead of
 * showing the raw code. This extracts the REAL function bodies from app/partner-app/job-notes.tsx (not a
 * hand-copied re-implementation) and executes them, so a future edit that keeps the surrounding text but
 * changes the logic fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/partner-app/job-notes.tsx", import.meta.url), "utf8");

function extractArrow(name) {
  // This file is written in the repository's compact style (`const x=(value:string)=>`), so the
  // marker tolerates the spacing rather than assuming one of the two forms.
  const start = source.search(new RegExp(`const\\s+${name}\\s*=\\s*\\(`));
  assert.ok(start >= 0, `${name} must be defined in app/partner-app/job-notes.tsx`);
  const arrowStart = source.indexOf("=>", start);
  let bodyStart = arrowStart + 2;
  while (/\s/.test(source[bodyStart])) bodyStart++;
  if (source[bodyStart] !== "{") {
    // Expression-bodied arrow: `const x = (value: string) => value.replaceAll(...);`
    const end = source.indexOf(";", bodyStart);
    return { params: "value", body: `return (${source.slice(bodyStart, end)});` };
  }
  // Block-bodied arrow: find the matching closing brace.
  let depth = 0, i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return { params: "value", body: source.slice(bodyStart + 1, i) };
}

function extractObjectLiteral(name) {
  const start = source.search(new RegExp(`const\\s+${name}\\s*:\\s*Record<string,\\s*string>\\s*=\\s*`));
  assert.ok(start >= 0, `${name} must be defined in app/partner-app/job-notes.tsx`);
  const braceStart = source.indexOf("{", start);
  const braceEnd = source.indexOf("}", braceStart);
  return new Function(`return (${source.slice(braceStart, braceEnd + 1)});`)();
}

const categoryLabels = extractObjectLiteral("CATEGORY_LABELS");
const labelFn = (() => { const { params, body } = extractArrow("label"); return new Function(params, body); })();
const requirementLabelFn = (() => {
  const { body } = extractArrow("requirementLabel");
  // The extracted body references `label` and `REQUIREMENT_CATEGORY_LABELS` by name; supply the same
  // values the module itself computed, not stand-ins, so this really executes the shipped logic.
  return new Function("value", "label", "CATEGORY_LABELS", body);
})();
const requirementLabel = (value) => requirementLabelFn(value, labelFn, categoryLabels);

test("LP-D06: a known grooming_safety code renders as 'Safety: <humanised detail>', not the raw code", () => {
  assert.equal(requirementLabel("grooming_safety:friendly"), "Safety: friendly");
  assert.equal(requirementLabel("grooming_safety:no_loud_noises"), "Safety: no loud noises");
  assert.doesNotMatch(requirementLabel("grooming_safety:friendly"), /grooming safety:friendly/, "the raw code must never be shown verbatim");
});

test("LP-D06: the other known category (grooming_special) is also humanised", () => {
  assert.equal(requirementLabel("grooming_special:handle_ears_gently"), "Special instructions: handle ears gently");
});

test("LP-D06: an unknown category:detail code still gets a humanised fallback, not the raw code", () => {
  assert.equal(requirementLabel("boarding_medical:diabetic"), "boarding medical: diabetic");
  assert.doesNotMatch(requirementLabel("boarding_medical:diabetic"), /boarding_medical:diabetic/);
});

test("LP-D06: a code with no colon still falls back to the plain underscore-to-space label", () => {
  assert.equal(requirementLabel("leash_required"), "leash required");
});

test("LP-D06 source contract: the Handling requirements list renders through requirementLabel, not the bare label()", () => {
  // The list lives in the extracted PartnerJobNotes component on this branch; the guarantee is the
  // same — every requirement is rendered through requirementLabel, never the bare underscore label.
  assert.match(source, /Handling requirements[\s\S]{0,80}safetyRequirements\.map\(item\s*=>\s*<li key=\{item\}>\{requirementLabel\(item\)\}<\/li>\)/);
  assert.doesNotMatch(source, /safetyRequirements\.map\(item\s*=>\s*<li key=\{item\}>\{label\(item\)\}<\/li>\)/, "the bare label must not come back");
  const page = fs.readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<PartnerJobNotes safetyRequirements=\{selected\.safetyRequirements\}/, "the partner app must render the notes through that component");
});
