import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync(new URL("../scripts/release-ui-closure.mjs", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../.github/workflows/release-ui-closure.yml", import.meta.url), "utf8");

test("release UI closure covers representative roles and responsive viewports", () => {
  for (const marker of ["founder@pawspace.in", "anjali.finance33@tkpetcare.in", "jyoti.manager39@tkpetcare.in", "asha.groomer1@tkpetcare.in", "anita.associate17@tkpetcare.in"]) {
    assert.match(script, new RegExp(marker.replaceAll(".", "\\.")));
  }
  for (const width of ["390", "768", "1440"]) assert.match(script, new RegExp(`width: ${width}`));
  assert.match(script, /guest_customer/);
});

test("release UI closure blocks mutations while probing controls", () => {
  assert.match(script, /MUTATING_METHODS = new Set\(\["POST", "PUT", "PATCH", "DELETE"\]\)/);
  assert.match(script, /routeHandle\.abort\("blockedbyclient"\)/);
  assert.match(script, /mutationsExecuted: 0/);
  assert.match(script, /wired_mutation_blocked/);
});

test("release UI closure checks visual failures instead of screenshot-only evidence", () => {
  assert.match(script, /horizontalOverflow/);
  assert.match(script, /brokenImages/);
  assert.match(script, /clippedControls/);
  assert.match(script, /pageErrors/);
  assert.match(script, /apiFailures/);
});

test("manual workflow is isolated-preview only and exact-SHA bound", () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: pawspace-release-preview/);
  assert.match(workflow, /expected_sha/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /workers\\\.dev/);
  assert.match(workflow, /PAWSPACE_UAT_ACCESS_CODE/);
  assert.doesNotMatch(workflow, /wrangler deploy/);
  assert.doesNotMatch(workflow, /d1 migrations apply/);
});
