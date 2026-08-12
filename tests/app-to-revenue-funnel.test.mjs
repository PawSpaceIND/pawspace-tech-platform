import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const funnel = await read("../lib/app-to-revenue-funnel.ts");
const recovery = await read("../lib/payment-recovery-governance.ts");
const attribution = await read("../lib/lead-conversion-attribution.ts");
const reconciliation = await read("../lib/grooming-payment-reconciliation.ts");
const otp = await read("../lib/customer-otp.ts");
const scheduler = await read("../lib/background-scheduler.ts");
const route = await read("../app/api/acquisition-funnel/route.ts");

test("App-to-Revenue funnel: install -> identify -> payment-truthful stages + producers", () => {
  assert.match(funnel, /export async function recordAppInstall/);
  assert.match(funnel, /export async function identifyInstall/);
  assert.match(funnel, /export async function runAppFunnelSweep/);
  assert.match(funnel, /export async function acquisitionFunnelReport/);
  // converted requires a captured payment; booked-but-unpaid is payment_pending
  assert.match(funnel, /WHEN captured>0 THEN 1 ELSE 0 END\) converted/);
  assert.match(funnel, /WHEN captured=0 AND booked>0 THEN 1 ELSE 0 END\) payment_pending/);
  // the sweep feeds the real Sales system (no CRM rebuild): App-Inbound + Payment-Recovery leads
  assert.match(funnel, /'App Inbound'|"App Inbound"/);
  assert.match(funnel, /'Payment Recovery'|"Payment Recovery"/);
  assert.match(funnel, /issueRecoveryEntitlement/);
  // idempotent producers
  assert.match(funnel, /INSERT OR IGNORE INTO funnel_producer_marks/);
});

test("₹300 recovery entitlement is customer-bound, one-use, no-stacking, non-transferable, auto-cancelled", () => {
  assert.match(recovery, /RECOVERY_AMOUNT = 300/);
  assert.match(recovery, /UNIQUE\(customer_id,booking_id\)/);
  assert.match(recovery, /customer_already_has_active_entitlement/);        // no stacking
  assert.match(recovery, /non-transferable \(belongs to another customer\)/); // non-transferable
  assert.match(recovery, /export async function cancelRecoveryEntitlements/);  // auto-cancel on pay
  assert.match(recovery, /export async function runRecoveryExpirySweep/);      // expiry
});

test("conversion is payment-gated (booked+unpaid is not converted) and wired to the payment webhook", () => {
  assert.match(attribution, /const captured=String\(payment\?\.status\|\|""\)==="captured"/);
  assert.match(attribution, /last_outcome='booking_initiated'/);
  assert.match(attribution, /export async function convertLeadOnPaymentCaptured/);
  // payment.captured in the reconciliation engine converts the lead + cancels the ₹300
  assert.match(reconciliation, /convertLeadOnPaymentCaptured/);
  assert.match(reconciliation, /cancelRecoveryEntitlements/);
});

test("funnel is wired into OTP identify, the scheduler, and the reporting route", () => {
  assert.match(otp, /identifyInstall/);                       // install bound at OTP verify
  assert.match(scheduler, /runAppFunnelSweep/);
  assert.match(scheduler, /"appToRevenueFunnel"/);
  assert.match(route, /requirePermission\(actor,"marketing\.view"\)/);
  assert.match(route, /requirePermission\(actor,"marketing\.manage"\)/);
  assert.match(route, /acquisitionFunnelReport/);
  assert.match(route, /paymentRecoveryReport/);
});
