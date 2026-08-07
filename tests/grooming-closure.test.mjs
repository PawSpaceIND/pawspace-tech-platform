import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Grooming closure uses one canonical transaction across Customer Partner Team and Finance",async()=>{
  const[customer,canonical,change,partnerApi,partnerUi,lifecycle,finance,security]=await Promise.all([
    source("app/page.tsx"),source("app/api/canonical-bookings/route.ts"),source("app/api/grooming-booking-change/route.ts"),source("app/api/partner-grooming-jobs/route.ts"),source("app/partner-app/canonical-grooming-jobs.tsx"),source("app/api/grooming-lifecycle/route.ts"),source("app/api/grooming-finance/route.ts"),source("lib/server-auth.ts"),
  ]);
  assert.match(customer,/createCanonicalLifecycle/);
  assert.match(customer,/reserveUatSchedule/);
  assert.match(canonical,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(canonical,/provider_work_orders/);
  assert.match(canonical,/booking_payments/);
  assert.match(canonical,/booking_subscription_usage/);
  assert.match(canonical,/subscription_reserved/);
  assert.match(change,/booking_cancelled/);
  assert.match(change,/booking_rescheduled/);
  assert.match(change,/capacityRevalidated/);
  assert.match(change,/refund_pending/);
  assert.match(change,/subscriptionReservationReversed/);
  assert.match(partnerApi,/authorize\(request,"bookings\.view"\)/);
  assert.match(partnerApi,/provider_work_orders/);
  assert.match(partnerUi,/\/api\/partner-grooming-jobs/);
  assert.match(partnerUi,/\/api\/grooming-lifecycle/);
  assert.match(lifecycle,/Before photo, after photo and completion checklist are required/);
  assert.match(lifecycle,/booking_invoices/);
  assert.match(lifecycle,/sessions_consumed=1/);
  assert.match(lifecycle,/repeat_booking_tasks/);
  assert.match(finance,/booking_invoices/);
  assert.match(finance,/booking_subscription_usage/);
  assert.match(security,/security_audit_events/);
});

test("Grooming closure keeps live integrations explicitly outside the UAT transaction",async()=>{
  const[lifecycle,finance,plan]=await Promise.all([source("app/api/grooming-lifecycle/route.ts"),source("app/team/finance/page.tsx"),source("docs/GROOMING_CLOSURE_PLAN.md")]);
  assert.match(lifecycle,/uat_sandbox/);
  assert.match(finance,/No live Razorpay/);
  assert.match(plan,/Deliberately still UAT \/ not production-complete/);
  assert.match(plan,/Do not connect live customer data or live payment\/communication integrations/);
});
