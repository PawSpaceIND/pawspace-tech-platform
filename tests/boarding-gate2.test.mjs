import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("Boarding Gate 2 owns stay acceptance capacity and idempotency",()=>{
  const source=read("lib/boarding-stay-lifecycle.ts");
  assert.match(source,/boarding_stay_action_keys/);
  assert.match(source,/boarding_capacity_locks/);
  assert.match(source,/idx_boarding_capacity_overlap/);
  assert.match(source,/one_family_only/);
  assert.match(source,/used\+Number\(stay\.pet_count\)>max/);
  assert.match(source,/provider_unavailability/);
  assert.match(source,/Host acceptance offer expired/);
  assert.match(source,/status='accepted'/);
  assert.match(source,/duplicatePrevented:true/);
});

test("Boarding Gate 2 requires care plan before check in and records canonical care events",()=>{
  const source=read("lib/boarding-stay-lifecycle.ts");
  assert.match(source,/care_plan_status/);
  assert.match(source,/emergency contact and vet details/);
  assert.match(source,/A ready care plan is required before check-in/);
  assert.match(source,/status='in_progress'/);
  for(const event of ["meal","walk","medication","photo_update","general_update","incident"])assert.match(source,new RegExp(`\\"${event}\\"`));
  assert.match(source,/boarding_stay_events/);
});

test("Boarding Gate 2 keeps extension commercial truth blocked and preserves the paid stay window",()=>{
  const source=read("lib/boarding-stay-lifecycle.ts");
  assert.match(source,/boarding_extension_requests/);
  assert.match(source,/commercial_quote_required/);
  assert.match(source,/stayWindowUnchanged:true/);
  assert.doesNotMatch(source,/UPDATE boarding_stays SET check_out_at=.*request_extension/s);
});

test("Boarding Gate 2 escalates decline unavailable and no show without losing the booking",()=>{
  const source=read("lib/boarding-stay-lifecycle.ts");
  assert.match(source,/boarding_recovery_cases/);
  assert.match(source,/ops_escalation/);
  assert.match(source,/recovery_pending/);
  assert.match(source,/reassignment_needed/);
  assert.match(source,/bookingPreserved:true/);
  assert.match(source,/releaseCapacity/);
  assert.match(source,/booking_customer_notifications/);
});

test("Boarding Gate 2 checkout closes capacity but leaves tax and payout policy un-invented",()=>{
  const source=read("lib/boarding-stay-lifecycle.ts");
  assert.match(source,/check_out/);
  assert.match(source,/status='completed'/);
  assert.match(source,/UPDATE scheduling_reservations SET status='completed'/);
  assert.match(source,/payout:\"rule_pending\"/);
  assert.match(source,/tax:\"configuration_required\"/);
});

test("Boarding stay API enforces provider customer and staff ownership boundaries",()=>{
  const api=read("app/api/boarding-stays/route.ts"),gateway=read("lib/api-gateway.ts");
  assert.match(api,/requireProviderOwnership/);
  assert.match(api,/requireCustomerOwnership/);
  assert.match(api,/requirePermission\(actor,\"bookings\.manage\"\)/);
  assert.match(api,/requirePermission\(actor,\"scheduling\.book\"\)/);
  assert.match(api,/securityAudit/);
  assert.match(gateway,/url\.pathname===\"\/api\/boarding-stays\"/);
  assert.match(gateway,/\[\"submit_care_plan\",\"request_extension\"\]/);
  assert.match(gateway,/action===\"no_show\"/);
});

test("Boarding Host workspace resolves trusted provider identity and governed city scope",()=>{
  const api=read("app/api/boarding-stays/route.ts"),client=read("lib/boarding-stay-client.ts"),page=read("app/host/page.tsx");
  assert.match(api,/findIdentityBinding/);
  assert.match(api,/ownProviderId/);
  assert.match(api,/providerScope/);
  assert.match(api,/city_id,zone_id FROM boarding_host_profiles/);
  assert.match(client,/loadOwnBoardingStays/);
  assert.match(client,/cityId/);
  assert.match(client,/zoneId/);
  assert.match(page,/loadOwnBoardingStays/);
  assert.match(page,/loadBoardingCommercial/);
  assert.doesNotMatch(page,/host_maya_rohan/);
});

test("Boarding Host workspace performs canonical stay actions instead of fixture toasts",()=>{
  const page=read("app/host/page.tsx");
  assert.match(page,/updateBoardingStay/);
  for(const action of ["accept","decline","check_in","care_event","host_unavailable","check_out"])assert.match(page,new RegExp(`\\"${action}\\"`));
  assert.match(page,/care_plan_status/);
  assert.match(page,/extension_status/);
  assert.match(page,/Canonical Care Card/);
  assert.match(page,/Stay timeline/);
  assert.match(page,/Settlement not calculated/);
});

test("Boarding Host workspace does not restore unapproved commercial or dated fixtures",()=>{
  const page=read("app/host/page.tsx");
  for(const stale of ["Flexible offer allowed","Send price offer","48 hrs after checkout","₹28,740","₹18,420","MONDAY · 3 AUGUST","AUGUST 2026"])assert.doesNotMatch(page,new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(page,/Host price override/);
  assert.match(page,/Disabled/);
  assert.match(page,/Rule pending/);
  assert.match(page,/Config required/);
  assert.match(page,/new Intl\.DateTimeFormat/);
});

test("Boarding customer stay read is booking-scoped and ownership checked",()=>{
  const api=read("app/api/boarding-stays/route.ts"),gateway=read("lib/api-gateway.ts"),client=read("lib/boarding-stay-client.ts");
  assert.match(api,/scope\)===\"customer\"|scope\)==\"customer\"|scope\)==='customer'|scope\)===\'customer\'/);
  assert.match(api,/Customer Boarding stay reads require only a booking ID/);
  assert.match(api,/listBoardingStays\(db,\{bookingId\}\)/);
  assert.match(api,/requireCustomerOwnership\(db,actor,ownedCustomerId\)/);
  assert.match(gateway,/url\.searchParams\.get\(\"scope\"\)===\"customer\"\?\"scheduling\.book\":\"bookings\.view\"/);
  assert.match(client,/loadCustomerBoardingStay/);
  assert.match(client,/scope=customer&bookingId=/);
});

test("Boarding customer care plan and extension use canonical stay actions",()=>{
  const panel=read("app/mobile-app/boarding-customer-stay-panel.tsx");
  assert.match(panel,/loadCustomerBoardingStay/);
  assert.match(panel,/action:\"submit_care_plan\"/);
  assert.match(panel,/action:\"request_extension\"/);
  assert.match(panel,/emergencyContact/);
  assert.match(panel,/vet/);
  assert.match(panel,/commercial quote required/i);
  assert.match(panel,/paid checkout does not move/i);
  assert.match(panel,/stay\.events/);
  assert.match(panel,/not live in Boarding UAT/);
});

test("Boarding customer journey is truthful before host acceptance",()=>{
  const flow=read("app/mobile-app/stay-flow.tsx"),status=read("app/mobile-app/boarding-customer-stay-status.tsx");
  assert.match(flow,/BoardingCustomerStayPanel/);
  assert.match(flow,/BoardingCustomerStayStatus/);
  assert.match(flow,/Server-priced verified Boarding hosts/);
  assert.match(flow,/Hosts cannot send a different Boarding price/);
  assert.match(flow,/BOARDING BOOKING CREATED/);
  assert.match(flow,/Awaiting host/);
  assert.match(flow,/Host acceptance follows the canonical booking request/);
  assert.match(status,/awaiting_host_acceptance/);
  assert.match(status,/Awaiting host acceptance/);
  assert.doesNotMatch(flow,/2026-08-24/);
  assert.doesNotMatch(flow,/2026-08-31/);
  assert.match(flow,/useState\(\(\) => dateOffset\(3\)\)/);
  assert.match(flow,/useState\(\(\) => dateOffset\(10\)\)/);
});

test("Boarding keeps split payment and coupons disabled while Pet Sitting fixtures remain isolated",()=>{
  const flow=read("app/mobile-app/stay-flow.tsx");
  assert.match(flow,/splitEligible = mode !== \"boarding\"/);
  assert.match(flow,/mode === \"boarding\" \? boardingQuote\?\.amountDueNow\?\?0/);
  assert.match(flow,/Boarding coupons are disabled until a canonical coupon policy is configured/);
  assert.match(flow,/Long-stay split payment remains disabled until a Boarding payment policy is explicitly configured/);
  assert.match(flow,/mode === \"boarding\" \? \(/);
  assert.match(flow,/Verified commission partners receive the request, review the Care Card and send an acceptance or flexible offer/);
});
