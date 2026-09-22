/**
 * LP-D06 - job detail "Handling requirements" rendered the raw code "grooming safety:friendly" for a
 * pricing.requirements entry shaped `grooming_safety:friendly` (see app/mobile-app/grooming-flow.tsx).
 * The generic `label()` helper only replaces underscores with spaces, so the colon-joined code came
 * through almost verbatim instead of the "Safety: friendly" the desktop partner feed
 * (app/partner/jobs/page.tsx) already renders for the same data.
 *
 * requirementLabel() now recognises the known category prefixes and humanises an unknown one instead of
 * showing the raw code. It is a closure inside PartnerJobNotes and is not exported, so every case here
 * goes through a real render of that component rather than a re-implementation: a future edit that keeps
 * the surrounding text but changes the logic fails here.
 *
 * An earlier version of this file reached requirementLabel by slicing its body out of the .tsx source and
 * passing it to `new Function`. That executed the shipped logic, but it is also CodeQL's js/code-injection
 * sink (file contents flowing into a code evaluator) and it reported as a new high-severity alert. Rendering
 * the component is both safer and a truer test - it exercises the path the provider's screen actually takes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__LP_D06_DB__");
import fs from "node:fs";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/partner-app/job-notes.tsx", import.meta.url), "utf8");

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const PartnerJobNotes = (await import("../app/partner-app/job-notes.tsx")).default;

const renderRequirements = (values) =>
  renderToStaticMarkup(React.createElement(PartnerJobNotes, { safetyRequirements: values, addOns: [] }));

/** The rendered text of the one <li> the component emits for a single requirement code. */
const requirementLabel = (value) => {
  const items = [...renderRequirements([value]).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
  assert.equal(items.length, 1, `exactly one requirement must render for ${value}`);
  return items[0];
};

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

test("LP-D06 executed: the real component renders the humanised label, not the raw code", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const notes = await import("../app/partner-app/job-notes.tsx");
  const html = renderToStaticMarkup(React.createElement(notes.default, {
    safetyRequirements: ["grooming_safety:friendly", "grooming_special:slow_dryer", "unknown_category:some_detail", "no_colon_code"],
    addOns: [],
  }));
  assert.match(html, /Safety: friendly/);
  assert.match(html, /Special instructions: slow dryer/);
  assert.match(html, /unknown category: some detail/);
  assert.match(html, /no colon code/);
  assert.ok(!html.includes("grooming_safety:friendly"), "the raw code must not reach the provider");
});
