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
  assert.match(canonical,/grooming_subscription_purchase_snapshots/);
  assert.match(canonical,/governGroomingBooking/);
  assert.match(canonical,/cityId:input\.cityId,zoneId:input\.zoneId/);
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

test("Grooming subscription commercial rules are city-configurable with audited defaults",async()=>{
  const[governance,plansApi,gateway]=await Promise.all([source("lib/grooming-governance.ts"),source("app/api/grooming-subscription-plans/route.ts"),source("lib/api-gateway.ts")]);
  assert.match(governance,/CREATE TABLE IF NOT EXISTS grooming_subscription_plans/);
  assert.match(governance,/city_id TEXT NOT NULL/);
  assert.match(governance,/zone_id TEXT/);
  assert.match(governance,/session_count INTEGER NOT NULL/);
  assert.match(governance,/validity_value INTEGER NOT NULL/);
  assert.match(governance,/validity_unit TEXT NOT NULL/);
  assert.match(governance,/credits_per_pet INTEGER NOT NULL/);
  assert.match(governance,/family_wallet INTEGER NOT NULL/);
  assert.match(governance,/pause_days INTEGER NOT NULL/);
  assert.match(governance,/grace_days INTEGER NOT NULL/);
  assert.match(governance,/renewal_window_days INTEGER NOT NULL/);
  assert.match(governance,/effective_from TEXT NOT NULL/);
  assert.match(governance,/grooming_subscription_plan_audit/);
  for(const [code,price,sessions,validity] of [["sub-3-dog",3597,3,4],["sub-6",6594,6,8],["sub-12",11988,12,15],["sub-trim",4197,3,4]]){
    assert.match(governance,new RegExp(`planCode:\\"${code}\\"[\\s\\S]{0,180}price:${price}[\\s\\S]{0,80}sessions:${sessions}[\\s\\S]{0,80}validityValue:${validity}`));
  }
  assert.match(governance,/resolveGroomingSubscriptionPlan/);
  assert.match(governance,/ORDER BY CASE WHEN zone_id=\? THEN 0 ELSE 1 END,version DESC/);
  assert.match(governance,/reserveSessions=petCount\*\(item\.creditsPerPet\?\?1\)/);
  assert.match(plansApi,/"price","currency","session_count","validity_value","validity_unit"/);
  assert.match(plansApi,/"max_pets_per_booking","credits_per_pet","family_wallet","pause_days","grace_days","renewal_window_days"/);
  assert.match(plansApi,/pricing\.manage/);
  assert.match(gateway,/\/api\/grooming-subscription-plans/);
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
