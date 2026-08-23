import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("staff UAT runbook documents the canonical cross-role sequence, in order", () => {
  const doc = read("docs/END_TO_END_STAFF_UAT_EXECUTION.md");
  // Presence alone would let the runbook be reordered - a provider activated before Ops verification,
  // say - while every marker still appears and CI stays green. The stages are therefore required to
  // appear in this order, which is the claim the test name makes.
  const sequence = [
    "Customer identity and booking",
    "Provider self-service",
    "Ops verification and interview",
    "UAT provider activation",
    "Assignment and provider work",
    "Operations exception/recovery",
    "Finance, GST and accounting",
    "CRM and Revenue Mission",
    "Unified case/escalation",
    "AI engagement",
    "Human handoff",
    "Analytics/reporting",
    "Hosted real-D1 60-booking swarm",
  ];
  let previous = -1, previousMarker = "start of document";
  for (const marker of sequence) {
    const at = doc.indexOf(marker);
    assert.notEqual(at, -1, `the runbook no longer documents "${marker}"`);
    assert.ok(at > previous, `"${marker}" appears before "${previousMarker}"; the canonical sequence is out of order`);
    previous = at; previousMarker = marker;
  }
});

test("staff UAT runbook documents production and provider boundaries as fail closed", () => {
  const doc = read("docs/END_TO_END_STAFF_UAT_EXECUTION.md");
  assert.match(doc, /PRODUCTION READY = FALSE/);
  assert.match(doc, /uat_ready/);
  assert.match(doc, /live=0/);
  assert.match(doc, /marketplaceLive=false/);
  assert.match(doc, /orderEligible=false/);
  assert.match(doc, /provider cannot self-verify, self-approve or self-activate/);
  assert.match(doc, /AI cannot make final provider approval\/rejection/);
  assert.match(doc, /legacy `\/partner-app` synthetic status\/earnings\/activation is never used as UAT evidence/);
});

test("provider integrated runbook reflects implemented self-service and canonical Partner entry", () => {
  const doc = read("docs/PROVIDER_ONBOARDING_INTEGRATED_UAT.md");
  assert.match(doc, /Use `\/partner` as the canonical Partner UAT entry/);
  assert.match(doc, /Provider self-service is implemented/);
  assert.match(doc, /\/api\/identity-session/);
  assert.match(doc, /quarantined synthetic regression prototype/);
  assert.match(doc, /marketplace live = No/);
  assert.match(doc, /order eligible = No/);
});
