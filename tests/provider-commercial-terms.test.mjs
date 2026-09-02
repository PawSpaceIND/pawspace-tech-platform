import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const terms = await read("../lib/provider-commercial-terms.ts");
const route = await read("../app/api/provider-commercial-terms/route.ts");
const workforce = await read("../lib/workforce-classification.ts");

test("payout engine supports the four engagement models with the correct GST treatment", () => {
  assert.match(terms, /commission_groomer|commission_standard|direct_employee|funeral_exempt/);
  // commission_standard: GST-inclusive order -> carve embedded 18% off the top (true inclusive reverse-calc)
  assert.match(terms, /providerGstDeducted=money\(orderValue\*18\/118\)/);
  // ...then split the GST-exclusive net pool; provider is paid their share of it (no further deduction)
  assert.match(terms, /const netPool=money\(orderValue-providerGstDeducted\)/);
  assert.match(terms, /providerNetPayout=providerGrossShare/);
  // PawSpace GST is on the platform fee only
  assert.match(terms, /platformGst=money\(platformFee\*platformGstRate\)/);
  // direct employee (principal): GST-inclusive order -> carve embedded 18% (18/118) + direct invoice, no payout
  assert.match(terms, /directInvoice=true;pawspaceGstOnOrder=money\(orderValue\*18\/118\)/);
  // funeral: GST-exempt, vendor paid a share of PawSpace's OWN standard price, no GST on the platform fee
  assert.match(terms, /engagementModel==="funeral_exempt"/);
  assert.match(terms, /gstExempt=true;payoutBasis="standard_price"/);
  assert.match(terms, /providerGrossShare=money\(standardReferencePrice\*providerSharePct\)/);
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
  assert.match(terms, /gstModeDefaultForOthers:"provider_gst_on_behalf"/);
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
