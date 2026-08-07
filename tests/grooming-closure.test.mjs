import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Grooming closure uses one canonical transaction across Customer Partner Team and Finance",async()=>{
  const[customer,canonical,change,partnerApi,partnerUi,lifecycle,finance,security,governance,mediaSecurity,mediaApi]=await Promise.all([
    source("app/page.tsx"),source("app/api/canonical-bookings/route.ts"),source("app/api/grooming-booking-change/route.ts"),source("app/api/partner-grooming-jobs/route.ts"),source("app/partner-app/canonical-grooming-jobs.tsx"),source("app/api/grooming-lifecycle/route.ts"),source("app/api/grooming-finance/route.ts"),source("lib/server-auth.ts"),source("lib/grooming-governance.ts"),source("lib/service-media-security.ts"),source("app/api/service-media/route.ts"),
  ]);
  assert.match(customer,/createCanonicalLifecycle/);
  assert.match(customer,/reserveUatSchedule/);
  assert.match(canonical,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(canonical,/provider_work_orders/);
  assert.match(canonical,/booking_payments/);
  assert.match(canonical,/booking_subscription_usage/);
  assert.match(canonical,/customer_grooming_subscriptions/);
  assert.match(canonical,/governGroomingBooking/);
  assert.match(canonical,/Grooming subscription purchases must be prepaid and captured/);
  assert.match(canonical,/subscription_reserved/);
  assert.match(change,/booking_cancelled/);
  assert.match(change,/booking_rescheduled/);
  assert.match(change,/capacityRevalidated/);
  assert.match(change,/refund_pending/);
  assert.match(change,/subscriptionSessionsReleased/);
  assert.match(partnerApi,/authorize\(request,"bookings\.view"\)/);
  assert.match(partnerApi,/provider_work_orders/);
  assert.match(partnerUi,/\/api\/partner-grooming-jobs/);
  assert.match(partnerUi,/\/api\/grooming-lifecycle/);
  assert.match(lifecycle,/Before photo, after photo and completion checklist are required/);
  assert.match(lifecycle,/booking_invoices/);
  assert.match(lifecycle,/sessions_consumed=sessions_reserved/);
  assert.match(lifecycle,/customer_grooming_subscriptions/);
  assert.match(lifecycle,/booking_tax_readiness/);
  assert.match(lifecycle,/provider_settlement_readiness/);
  assert.match(lifecycle,/assertServiceProofRef/);
  assert.match(lifecycle,/repeat_booking_tasks/);
  assert.match(mediaSecurity,/Service media asset belongs to another booking/);
  assert.match(mediaSecurity,/Service media asset belongs to another provider/);
  assert.match(mediaSecurity,/Service media asset purpose does not match the proof slot/);
  assert.match(mediaSecurity,/scan_status/);
  assert.match(mediaSecurity,/access_status/);
  assert.match(mediaSecurity,/retention_status/);
  assert.match(mediaApi,/SHA-256 checksum/);
  assert.match(mediaApi,/10 MB/);
  assert.match(mediaApi,/synthetic:true/);
  assert.match(finance,/booking_invoices/);
  assert.match(finance,/booking_subscription_usage/);
  assert.match(security,/security_audit_events/);
  assert.match(governance,/GROOMING_CATALOGUE_VERSION/);
});

test("Grooming governance freezes published UAT prices and validity before live integration",async()=>{
  const governance=await source("lib/grooming-governance.ts");
  for(const [code,price] of [["dog-basic",1899],["dog-makeover",2399],["sub-3-dog",3597],["sub-6",6594],["sub-12",11988],["sub-trim",4197]]){
    assert.match(governance,new RegExp(`code:\\"${code}\\"[\\s\\S]{0,220}singlePrice:${price}`));
  }
  assert.match(governance,/code:"sub-3-dog"[\s\S]{0,260}sessions:3[\s\S]{0,80}validityMonths:4/);
  assert.match(governance,/code:"sub-6"[\s\S]{0,260}sessions:6[\s\S]{0,80}validityMonths:8/);
  assert.match(governance,/code:"sub-12"[\s\S]{0,260}sessions:12[\s\S]{0,80}validityMonths:15/);
  assert.match(governance,/code:"sub-trim"[\s\S]{0,260}sessions:3[\s\S]{0,80}validityMonths:4/);
  assert.match(governance,/petCount<1\|\|petCount>4/);
  assert.match(governance,/reserveSessions:petCount/);
});

test("Grooming closure keeps live integrations explicitly outside the UAT transaction",async()=>{
  const[lifecycle,finance,plan]=await Promise.all([source("app/api/grooming-lifecycle/route.ts"),source("app/team/finance/page.tsx"),source("docs/GROOMING_CLOSURE_PLAN.md")]);
  assert.match(lifecycle,/uat_sandbox/);
  assert.match(lifecycle,/Production GST\/tax rule is not yet approved/);
  assert.match(lifecycle,/Provider payout percentage\/travel\/incentive\/penalty rule must be approved/);
  assert.match(finance,/No live Razorpay/);
  assert.match(plan,/Deliberately still UAT \/ not production-complete/);
  assert.match(plan,/Do not connect live customer data or live payment\/communication integrations/);
});
