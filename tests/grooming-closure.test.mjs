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
  assert.match(partnerApi,/requirePermission\(actor,"bookings\.view"\)/);
  assert.match(partnerApi,/requireProviderOwnership\(db,actor,providerId\)/);
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

test("Grooming Gate 3 governs provider capacity acceptance and same-booking recovery",async()=>{
  const[capacity,scheduler,scheduling,recovery,partner,operations,gateway]=await Promise.all([
    source("lib/provider-capacity-governance.ts"),source("app/api/uat-scheduling/route.ts"),source("backend/src/scheduling.ts"),source("app/api/provider-assignment-recovery/route.ts"),source("app/partner-app/canonical-grooming-jobs.tsx"),source("app/api/booking-operations/route.ts"),source("lib/api-gateway.ts"),
  ]);
  const control=await source("app/api/provider-capacity-control/route.ts");
  assert.match(capacity,/provider_capacity_profiles/);
  assert.match(capacity,/travel_buffer_minutes/);
  assert.match(capacity,/max_daily_jobs/);
  assert.match(capacity,/acceptance_timeout_minutes/);
  assert.match(capacity,/provider_assignment_offers/);
  assert.match(capacity,/provider_recovery_cases/);
  assert.match(capacity,/provider_performance_events/);
  assert.match(capacity,/provider_unavailability/);
  assert.match(scheduler,/loadGovernedProviders/);
  assert.match(scheduler,/createAssignmentOffer/);
  assert.match(scheduling,/Existing booking conflicts with travel\/service buffer/);
  assert.match(scheduling,/Daily job limit/);
  assert.match(control,/"set_availability"\|"block_time"\|"unblock_time"/);
  assert.match(control,/"provider_unavailable"/);
  assert.match(control,/capacityLocked:true/);
  assert.match(control,/UPDATE scheduling_reservations SET status='cancelled'/);
  assert.match(recovery,/"accept"\|"decline"\|"timeout"\|"unavailable"\|"no_show"/);
  assert.match(recovery,/UPDATE canonical_bookings SET provider_id=\?/);
  assert.match(recovery,/UPDATE provider_work_orders SET provider_id=\?/);
  assert.match(recovery,/provider_replacement_selected/);
  assert.match(recovery,/ops_escalation/);
  assert.match(recovery,/recordProviderPerformance/);
  assert.match(recovery,/booking ID and scheduled slot remain unchanged/);
  assert.match(partner,/\/api\/provider-assignment-recovery/);
  assert.match(partner,/Decline job/);
  assert.match(operations,/"running_late"/);
  assert.match(operations,/"vehicle_issue"/);
  assert.match(operations,/rebookingAvailable/);
  assert.match(gateway,/\/api\/provider-capacity-control/);
  assert.match(gateway,/\/api\/provider-assignment-recovery/);
});

test("Grooming production-readiness policy is city-configurable, frozen per booking and observe-first",async()=>{
  const[policy,control,canonical,change,gateway]=await Promise.all([
    source("lib/grooming-policy-governance.ts"),source("app/api/grooming-commercial-policy/route.ts"),source("app/api/canonical-bookings/route.ts"),source("app/api/grooming-booking-change/route.ts"),source("lib/api-gateway.ts"),
  ]);
  assert.match(policy,/grooming_commercial_policies/);
  assert.match(policy,/cancellation_cutoff_minutes/);
  assert.match(policy,/refund_percent_before_cutoff/);
  assert.match(policy,/refund_percent_after_cutoff/);
  assert.match(policy,/reschedule_cutoff_minutes/);
  assert.match(policy,/max_reschedules/);
  assert.match(policy,/reschedule_fee_type/);
  assert.match(policy,/no_show_refund_percent/);
  assert.match(policy,/multi_pet_max/);
  assert.match(policy,/enforcement_mode TEXT NOT NULL DEFAULT 'observe'/);
  assert.match(policy,/grooming_commercial_policy_audit/);
  assert.match(policy,/ORDER BY CASE WHEN zone_id=\? THEN 0 ELSE 1 END,version DESC/);
  assert.match(policy,/Observe mode: policy would block this change but UAT behavior is preserved/);
  assert.match(control,/pricing\.manage/);
  assert.match(control,/'observe','enforce'/);
  assert.match(canonical,/resolveGroomingPolicy/);
  assert.match(canonical,/commercialPolicy:commercialPolicy\?policySnapshot/);
  assert.match(canonical,/commercialPolicyVersion/);
  assert.match(change,/parsePolicySnapshot/);
  assert.match(change,/evaluateBookingChange/);
  assert.match(change,/refundAmount/);
  assert.match(change,/rescheduleFeeAmount/);
  assert.match(gateway,/\/api\/grooming-commercial-policy/);
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
