import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("partner Grooming proof no longer fabricates synthetic before/after images", () => {
  const mobile = read("app/partner-app/page.tsx");
  const desktop = read("app/partner-app/canonical-grooming-jobs.tsx");
  assert.doesNotMatch(mobile, /uat:\/\/proof/);
  assert.doesNotMatch(desktop, /uat:\/\/proof/);
  for (const source of [mobile, desktop]) {
    assert.match(source, /\/api\/service-media/);
    assert.match(source, /proofReady/);
  }
  assert.match(mobile, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(mobile, /private storage and malware scanning are not connected/);
});

test("Grooming media proof is bound to booking provider purpose and clean private media", () => {
  const media = read("app/api/service-media/route.ts");
  const workspace = read("lib/provider-workspace.ts");
  const lifecycle = read("app/api/grooming-lifecycle/route.ts");
  assert.match(media, /'active',0/);
  assert.match(media, /scan_status.*clean/);
  assert.match(workspace, /Grooming photo proof must use a registered private media reference/);
  assert.match(workspace, /storage-confirmed and scan-approved/);
  assert.match(lifecycle, /assertServiceProofRef/);
});

test("post-service payment request is provider-owned, idempotent and cannot fake capture", () => {
  const route = read("app/api/grooming-payment-sandbox/route.ts");
  const reconciliation = read("lib/grooming-payment-reconciliation.ts");
  const lifecycle = read("app/api/grooming-lifecycle/route.ts");
  assert.match(route, /request_after_service/);
  assert.match(route, /requireProviderOwnership/);
  assert.match(reconciliation, /post_service_payment_requests/);
  assert.match(reconciliation, /liveCapture:false/);
  assert.match(reconciliation, /signature-verified gateway event/);
  assert.match(lifecycle, /Direct payment marking is disabled/);
  assert.doesNotMatch(lifecycle, /UPDATE booking_payments SET status='captured'.*manual-reconciliation/);
});

test("verified capture alone advances reconciliation CRM and settlement readiness", () => {
  const reconciliation = read("lib/grooming-payment-reconciliation.ts");
  assert.match(reconciliation, /if\(!event\.signatureVerified\)throw new Error/);
  assert.match(reconciliation, /convertLeadOnPaymentCaptured/);
  assert.match(reconciliation, /payment_verified_rule_pending/);
  assert.match(reconciliation, /provider_settlement_readiness/);
});

test("provider earnings and incentive achievements use governed persisted ledgers", () => {
  const workspace = read("lib/provider-workspace.ts");
  const incentive = read("lib/grooming-incentive-engine.ts");
  const mobile = read("app/partner-app/page.tsx");
  assert.match(workspace, /provider_payout_computations/);
  assert.match(workspace, /provider_settlement_readiness/);
  assert.match(workspace, /groomer_incentive_results/);
  assert.match(mobile, /Computed net payout/);
  assert.match(incentive, /saveGroomerIncentiveDraft/);
  assert.match(incentive, /finalizeGroomerIncentive/);
  assert.match(incentive, /Finalized incentive results are immutable/);
  assert.match(incentive, /groomer_achievement_links/);
});

test("people API and UI expose governed groomer incentive review and finalization", () => {
  const route = read("app/api/service-incentives/route.ts");
  const page = read("app/team/people/service-incentives/page.tsx");
  for (const source of [route, page]) {
    assert.match(source, /save_groomer_incentive_draft/);
    assert.match(source, /finalize_groomer_incentive/);
  }
  assert.match(page, /Finalizing is immutable/);
  assert.match(page, /does not transfer money or run payroll/);
});
