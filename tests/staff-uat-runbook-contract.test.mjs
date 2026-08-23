import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("staff UAT runbook documents the canonical cross-role sequence", () => {
  const doc = read("docs/END_TO_END_STAFF_UAT_EXECUTION.md");
  for (const marker of [
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
  ]) assert.match(doc, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
