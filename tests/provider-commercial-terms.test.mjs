import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const terms = await read("../lib/provider-commercial-terms.ts");
const route = await read("../app/api/provider-commercial-terms/route.ts");
const workforce = await read("../lib/workforce-classification.ts");

test("payout engine supports the four engagement models with the correct GST treatment", () => {
  assert.match(terms, /commission_groomer|commission_standard|direct_employee|funeral_exempt/);
  // owner decision 2 (26 Sept 2026): nothing is carved off the paid amount before the split
  assert.match(terms, /providerGstDeducted:0/);
  // ...the provider's share is taken of the amount paid (or of an explicit funeral standard price); no further deduction
  assert.match(terms, /providerGrossShare=money\(\(reference\|\|paid\)\*input\.providerSharePct\)/);
  assert.match(terms, /providerNetPayout:split\.providerGrossShare/);
  // PawSpace GST is on its commission only, through the one GST helper
  assert.match(terms, /gstBreakdown\(platformFee,input\.gstPolicy\)/);
  // own supply (decision 3): GST from the one setting on the full paid amount, direct invoice, no payout
  assert.match(terms, /if\(input\.ownSupply\)\{const g=input\.gstExempt\?exempt\(paid\):gstBreakdown\(paid,input\.gstPolicy\)/);
  // funeral (decision 4): GST-exempt everywhere; a share of an explicit standard price only when a caller passes one
  assert.match(terms, /engagementModel==="funeral_exempt"/);
  assert.match(terms, /payoutBasis:reference\?"standard_price"/);
  assert.match(terms, /FUNERAL_SERVICE_CODES\.has\(serviceCode\)/);
  // fail-closed: no active term refuses rather than guessing a split
  assert.match(terms, /configuration_required: no active commercial term/);
});

test("terms are versioned, maker/checker governed, and overridable per provider and per order", () => {
  assert.match(terms, /export async function saveCommercialTerm/);
  assert.match(terms, /the drafter cannot activate their own commercial term/);       // maker/checker
  assert.match(terms, /export async function setOrderCommercialOverride/);            // order-wise
  assert.match(terms, /termSource:"provider"/);                                       // provider beats service default
  assert.match(terms, /onboarding_fee|renewal_fee|renewal_months/);                   // onboarding + renewal fee
  assert.match(terms, /export async function cashCollectionAllowed/);                 // cash gate
});

test("the default GST treatment for other services is a flip-able config, not hard-coded margin", () => {
  assert.match(terms, /"provider_gst_on_behalf"/);
  assert.match(terms, /"platform_retained"/);                                         // the switch exists
  assert.match(terms, /gstModeDefaultForOthers:"none"/);                             // carve modes retired (owner decision 2)
});

test("the route is finance-gated and blocks cross-origin writes", () => {
  assert.match(route, /authorize\(request,"finance\.view"\)/);
  assert.match(route, /requirePermission\(actor,"finance\.manage"\)/);
  assert.match(route, /Cross-origin commercial-terms write blocked/);
  for (const a of ["save_term", "activate_term", "order_override", "compute_payout"]) assert.match(route, new RegExp(`"${a}"`));
});

test("workforce classification gates surfaces for direct / contract / commission workers", () => {
  assert.match(workforce, /export type EngagementKind="direct"\|"contract"\|"commission"/);
  assert.match(workforce, /surface:"employee_portal"/);
  assert.match(workforce, /surface:"partner_app"/);
  assert.match(workforce, /surface:"commission_dashboard"/);
  // commission workers get no payslip/leave/advance, only their booking dashboard + assignments
  assert.match(workforce, /return\{payslip:false,leave:false,attendance:false,advance:false/);
});
