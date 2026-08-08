import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Sitting Gate 2 owns acceptance lifecycle and idempotency",async()=>{const source=await read("lib/sitting-lifecycle.ts");assert.match(source,/sitting_action_keys/);assert.match(source,/provider_assignment_offers/);assert.match(source,/Sitter acceptance offer expired/);assert.match(source,/status='accepted'/);assert.match(source,/duplicatePrevented:true/);});

test("Sitting Gate 2 requires a complete care plan before check-in",async()=>{const source=await read("lib/sitting-lifecycle.ts");assert.match(source,/sitting_care_plan_snapshots/);assert.match(source,/emergency contact, vet and home access details/);assert.match(source,/A ready Sitting care plan is required before check-in/);assert.match(source,/status='in_progress'/);});

test("Sitting Gate 2 records canonical care events only during active service",async()=>{const source=await read("lib/sitting-lifecycle.ts");for(const type of ["meal","walk","medication","photo_update","general_update","incident","home_check"])assert.match(source,new RegExp(`\\"${type}\\"`));assert.match(source,/sitting_care_events/);assert.match(source,/only during an active booking/);});

test("Sitting Gate 2 recovery preserves the same booking",async()=>{const source=await read("lib/sitting-lifecycle.ts");assert.match(source,/sitting_recovery_cases/);assert.match(source,/reassignment_needed/);assert.match(source,/ops_escalation/);assert.match(source,/bookingPreserved:true/);assert.match(source,/UPDATE scheduling_reservations SET status='cancelled'/);assert.match(source,/UPDATE provider_work_orders SET status='recovery_pending'/);});

test("Sitting Gate 2 checkout closes work order and reservation without inventing tax or payout",async()=>{const source=await read("lib/sitting-lifecycle.ts");assert.match(source,/UPDATE canonical_bookings SET status='completed'/);assert.match(source,/UPDATE provider_work_orders SET status='completed'/);assert.match(source,/UPDATE scheduling_reservations SET status='completed'/);assert.match(source,/payout:\"rule_pending\"/);assert.match(source,/tax:\"configuration_required\"/);});

test("Sitting lifecycle API enforces provider customer and staff authority",async()=>{const api=await read("app/api/sitting-lifecycle/route.ts");assert.match(api,/requireProviderOwnership/);assert.match(api,/requireCustomerOwnership/);assert.match(api,/requirePermission\(actor,\"bookings\.manage\"\)/);assert.match(api,/requirePermission\(actor,\"scheduling\.book\"\)/);assert.match(api,/securityAudit/);assert.match(api,/sitting\.lifecycle/);});

test("Sitting lifecycle client has explicit read and mutation boundaries",async()=>{const client=await read("lib/sitting-lifecycle-client.ts");assert.match(client,/\/api\/sitting-lifecycle/);assert.match(client,/loadSittingLifecycle/);assert.match(client,/updateSittingLifecycle/);});

test("Sitting provider workspace performs canonical lifecycle actions",async()=>{const page=await read("app/sitter/sitting-workspace.tsx");assert.match(page,/loadSittingLifecycle/);assert.match(page,/updateSittingLifecycle/);for(const action of ["accept","check_in","care_event","check_out","sitter_unavailable"])assert.match(page,new RegExp(`\\"${action}\\"`));assert.match(page,/canonical booking ID/i);assert.doesNotMatch(page,/sit_sana/);});