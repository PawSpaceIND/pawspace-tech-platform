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
