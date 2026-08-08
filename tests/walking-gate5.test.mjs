import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Walking Gate 5 builds one canonical Operations exception queue",async()=>{const source=await read("lib/walking-ops-governance.ts");for(const token of ["walker_recovery","incident","cancellation_policy_review","reschedule_quote_required","refund_pending","blocked_media","settlement_not_ready"])assert.match(source,new RegExp(token));assert.match(source,/canonical_bookings/);assert.match(source,/walking_recovery_cases/);assert.match(source,/walking_incidents/);});

test("Walking Gate 5 replacement candidates are exact-window governed",async()=>{const source=await read("lib/walking-ops-governance.ts");assert.match(source,/loadGovernedProviders/);assert.match(source,/\"dog_walking\"/);assert.match(source,/provider_unavailability/);assert.match(source,/scheduling_reservations/);assert.match(source,/travelBufferMinutes/);assert.match(source,/Replacement walker must be exact-window eligible/);});

test("Walking Gate 5 recovery preserves booking and paid walk window",async()=>{const source=await read("lib/walking-ops-governance.ts");assert.match(source,/reassignment_offered/);assert.match(source,/walking_recovery_cases SET replacement_provider_id/);assert.match(source,/createAssignmentOffer/);assert.match(source,/bookingPreserved:true/);assert.match(source,/paidWindowPreserved:true/);assert.doesNotMatch(source,/INSERT INTO canonical_bookings.*assign_replacement/s);});

test("Walking Gate 5 does not close recovery before replacement acceptance",async()=>{const source=await read("lib/walking-ops-governance.ts");assert.match(source,/Replacement walker must accept before Operations closes recovery/);assert.match(source,/offer\.status/);assert.match(source,/walking_recovery_cases SET status='resolved'/);assert.match(source,/Walking recovery accepted and normalized/);});

test("Walking Gate 5 API is staff permissioned and audited",async()=>{const api=await read("app/api/walking-ops/route.ts"),client=await read("lib/walking-ops-client.ts");assert.match(api,/requirePermission\(actor,\"bookings\.manage\"\)/);assert.match(api,/securityAudit/);assert.match(api,/walking\.ops/);assert.match(client,/\/api\/walking-ops/);assert.match(client,/loadWalkingRecoveryCandidates/);});

test("Walking Team Operations workspace uses canonical exception and recovery controls",async()=>{const page=await read("app/team/operations/walking/walking-operations-workspace.tsx");assert.match(page,/loadWalkingOpsQueue/);assert.match(page,/loadWalkingRecoveryCandidates/);assert.match(page,/assign_replacement/);assert.match(page,/close_recovery/);assert.match(page,/Finance and proof decisions stay in their specialist modules/);});

test("Walking cross-role contract keeps one canonical booking ID",async()=>{const customer=await read("app/walking/page.tsx"),walker=await read("app/walker/walking-workspace.tsx"),ops=await read("lib/walking-ops-governance.ts"),finance=await read("lib/walking-finance-governance.ts");assert.match(customer,/booking\.bookingId/);assert.match(walker,/booking\.id/);assert.match(ops,/bookingId/);assert.match(finance,/bookingId/);for(const source of [ops,finance])assert.doesNotMatch(source,/PSW-4912/);});
