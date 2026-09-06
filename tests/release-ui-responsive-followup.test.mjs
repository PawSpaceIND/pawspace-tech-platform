import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../app/review-overrides.css", import.meta.url), "utf8");
const providerTraining = fs.readFileSync(new URL("../app/team/people/provider-training/page.tsx", import.meta.url), "utf8");
const customerExperienceCss = fs.readFileSync(new URL("../app/team/customer-experience/whatsapp-inbox.module.css", import.meta.url), "utf8");
const customerExperience = fs.readFileSync(new URL("../app/team/customer-experience/page.tsx", import.meta.url), "utf8");
const whatsappTemplates = fs.readFileSync(new URL("../app/team/whatsapp/templates/page.tsx", import.meta.url), "utf8");

function has(pattern, message) {
  assert.match(css, pattern, message);
}

test("control UI keeps a 12px minimum in release overrides", () => {
  has(/control_side[^}]*nav button[^}]*font-size:\s*12\.5px !important/s, "control nav buttons must remain readable");
  has(/control_side[^}]*small,[\s\S]*control_side[^}]*span\s*\{[^}]*font-size:\s*12px !important/s, "control nav supporting text must remain at least 12px");
  has(/control_main[^}]*strong\s*\{[^}]*font-size:\s*max\(12px,\s*0\.78rem\)/s, "control body copy must remain at least 12px");
});

test("all reviewed desktop route families can shrink their minimum content", () => {
  const shrinkGroup = css.match(/\.route-team main,\n[\s\S]*?\.route-regression-lab main \* \{ min-width: 0; box-sizing: border-box; \}/)?.[0];
  assert.ok(shrinkGroup, "reviewed route shrink group must keep the minimum-content declaration");
  for (const route of ["route-team", "route-partner", "route-customer", "route-admin", "route-regression-lab"]) {
    assert.match(shrinkGroup, new RegExp(`\\.${route} main,\\n\\.${route} main \\*(?:,| \\{)`), `${route} must participate in minimum-content shrink rules`);
  }
  has(/route-team main \[style\*="min-width"\],[\s\S]*route-regression-lab main \[style\*="min-width"\]\s*\{ min-width:\s*0 !important; \}/s, "inline minimum widths must not force phone overflow");
});

test("phone grids, flex rows and fixed-width controls adapt instead of hiding overflow", () => {
  has(/@media \(max-width: 760px\)[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) !important/s, "phone grids must stack");
  has(/@media \(max-width: 760px\)[\s\S]*flex-wrap:\s*wrap !important/s, "phone flex rows must wrap");
  has(/@media \(max-width: 760px\)[\s\S]*\[style\*="width"\][\s\S]*max-width:\s*100% !important/s, "inline fixed widths must be bounded");
  has(/table-layout:\s*fixed/s, "reviewed phone tables must fit their container");
  has(/overflow-wrap:\s*anywhere/s, "long labels must wrap rather than push controls off-screen");
  assert.doesNotMatch(css, /(?:html|body|main)[^{]*\{[^}]*overflow-x\s*:\s*hidden/is, "must not hide page overflow to game the release gate");
});

test("provider training source grid can shrink at the 768px tablet closure viewport", () => {
  assert.match(providerTraining, /gridTemplateColumns:\"minmax\(0,\.9fr\) minmax\(0,1\.1fr\)\"/, "provider training columns must use zero intrinsic minimums");
  assert.doesNotMatch(providerTraining, /minmax\(360px,\.9fr\) minmax\(480px,1\.1fr\)/, "provider training must not restore the 856px rigid tablet grid");
});

test("CX inspector collapses before the Operations shell clips it on desktop", () => {
  assert.match(customerExperienceCss, /@media\(max-width:1600px\)/, "the inbox must account for the outer Operations sidebar and workspace padding");
  assert.doesNotMatch(customerExperienceCss, /@media\(max-width:1320px\)/, "the old viewport-only breakpoint clipped the inspector at 1440px");
  assert.match(customerExperienceCss, /\.inspector\{grid-column:2\/4;[^}]*max-height:none\}/, "the collapsed inspector must move below the conversation columns without clipping controls");
});

test("CX status controls cannot advertise an action without a selected conversation", () => {
  assert.match(customerExperience, /disabled=\{busy \|\| !selected\}[\s\S]{0,260}>Await customer<\/Button>/);
  assert.match(customerExperience, /disabled=\{busy \|\| !selected\}[\s\S]{0,260}>Resolve<\/Button>/);
});

test("WhatsApp template Clear is enabled only when the editor has state to clear", () => {
  assert.match(whatsappTemplates, /const draftDirty =/);
  assert.match(whatsappTemplates, /disabled=\{busy \|\| !draftDirty\}[\s\S]{0,160}>Clear<\/Button>/);
});
