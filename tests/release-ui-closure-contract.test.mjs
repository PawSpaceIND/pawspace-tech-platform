import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync(new URL("../scripts/release-ui-closure.mjs", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../.github/workflows/release-ui-closure.yml", import.meta.url), "utf8");
const stagingLogin = fs.readFileSync(new URL("../app/api/staging-login/route.ts", import.meta.url), "utf8");
const classifier = fs.readFileSync(new URL("../scripts/release-ui-control-classifier.mjs", import.meta.url), "utf8");

test("release UI closure covers representative roles and responsive viewports", () => {
  for (const marker of ["founder@pawspace.in", "anjali.finance33@tkpetcare.in", "jyoti.manager39@tkpetcare.in", "asha.groomer1@tkpetcare.in", "anita.associate17@tkpetcare.in"]) {
    assert.match(script, new RegExp(marker.replaceAll(".", "\\.")));
  }
  for (const width of ["390", "768", "1440"]) assert.match(script, new RegExp(`width: ${width}`));
  assert.match(script, /guest_customer/);
});

test("release UI associate identity uses a defined platform role", () => {
  assert.match(stagingLogin, /email:"anita\.associate17@tkpetcare\.in",name:"Anita Associate",role:"associate"/);
  assert.doesNotMatch(stagingLogin, /email:"anita\.associate17@tkpetcare\.in"[^\n]*role:"sales"/);
});

test("release UI closure blocks mutations while probing controls", () => {
  assert.match(script, /MUTATING_METHODS = new Set\(\["POST", "PUT", "PATCH", "DELETE"\]\)/);
  assert.match(script, /routeHandle\.abort\("blockedbyclient"\)/);
  assert.match(script, /mutationsExecuted: 0/);
  // The wiring verdicts now live in the classifier module the harness imports, so assert them
  // where they are defined rather than where they are consumed.
  assert.match(script, /classifyControl/);
  assert.match(classifier, /wired_mutation_blocked/);
});

test("release UI closure checks visual failures instead of screenshot-only evidence", () => {
  assert.match(script, /horizontalOverflow/);
  assert.match(script, /brokenImages/);
  assert.match(script, /clippedControls/);
  assert.match(script, /pageErrors/);
  assert.match(script, /apiFailures/);
});

test("release UI closure distinguishes horizontally scrollable rails from clipped controls", () => {
  assert.match(script, /insideHorizontalScroller/);
  assert.match(script, /\["auto", "scroll"\]\.includes\(style\.overflowX\)/);
  assert.match(script, /parent\.scrollWidth <= parent\.clientWidth \+ 2/);
  assert.match(script, /!insideHorizontalScroller\(el\)/);
});

test("release UI closure returns visual findings before expensive control probing", () => {
  assert.match(script, /stopped after visual phase/);
  assert.match(script, /Control probing was intentionally skipped/);
  assert.match(script, /writeReport\(baseReport\(\)\)/);
});

test("release UI closure treats explicit links as wiring without reloading for every anchor", () => {
  assert.match(script, /function linkWiringResult/);
  assert.match(script, /if \(target\.tag !== "a"\) return null/);
  assert.match(script, /new URL\(href, BASE\)/);
});

test("release UI closure observes DOM mutations for button wiring", () => {
  assert.match(script, /MutationObserver/);
  assert.match(script, /__pawspaceUiMutationCount/);
  assert.match(script, /domMutations > 0/);
});

test("release UI closure no longer waits for networkidle on every route/control", () => {
  assert.match(script, /waitUntil: "domcontentloaded"/);
  assert.doesNotMatch(script, /waitForLoadState\("networkidle"/);
});

test("manual workflow is isolated-environment only and exact-SHA bound", () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /target_environment/);
  assert.match(workflow, /pawspace-release-preview/);
  assert.match(workflow, /pawspace-staging/);
  assert.match(workflow, /environment: \$\{\{ github\.event\.inputs\.target_environment \}\}/);
  assert.match(workflow, /expected_sha/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /workers\\\.dev/);
  assert.match(workflow, /PAWSPACE_UAT_ACCESS_CODE/);
  assert.doesNotMatch(workflow, /wrangler deploy/);
  assert.doesNotMatch(workflow, /d1 migrations apply/);
});
