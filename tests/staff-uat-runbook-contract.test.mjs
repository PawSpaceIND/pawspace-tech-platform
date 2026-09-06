import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("staff UAT runbook documents the canonical cross-role sequence, in order", () => {
  const doc = read("docs/END_TO_END_STAFF_UAT_EXECUTION.md");
  // Presence alone would let the runbook be reordered - a provider activated before Ops verification,
  // say - while every marker still appears and CI stays green. The stages are therefore required to
  // appear in this order, which is the claim the test name makes.
  // All 18 numbered stages, in the runbook's own order. The list previously held 13 and silently
  // skipped stages 2, 7, 8, 9 and 12, so those five could be reordered or dropped while this test
  // stayed green - and stage 9 (service lifecycle and proof) sitting between replacement governance
  // and exception recovery is exactly the kind of ordering the sequence exists to hold.
  const sequence = [
    "Customer identity and booking",              //  1
    "Provider onboarding configuration",          //  2
    "Provider self-service",                      //  3
    "Ops verification and interview",             //  4
    "UAT provider activation",                    //  5
    "Assignment and provider work",               //  6
    "GPS / ETA / lateness recovery",              //  7
    "Replacement and accountability governance",  //  8
    "Service lifecycle and proof",                //  9
    "Operations exception/recovery",              // 10
    "Finance, GST and accounting",                // 11
    "Partner settlement / reconciliation",        // 12
    "CRM and Revenue Mission",                    // 13
    "Unified case/escalation",                    // 14
    "AI engagement",                              // 15
    "Human handoff",                              // 16
    "Analytics/reporting",                        // 17
    "Hosted real-D1 60-booking swarm",            // 18
  ];
  assert.equal(sequence.length, 18, "the runbook has 18 numbered stages; every one must be order-protected");
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
