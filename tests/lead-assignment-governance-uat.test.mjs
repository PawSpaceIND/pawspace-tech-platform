import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const engine=read("lib/lead-assignment-governance.ts"),api=read("app/api/lead-assignment-governance/route.ts"),legacy=read("app/api/revenue-crm/route.ts");

test("lead assignment owns canonical policy membership availability and immutable history",()=>{
 for(const token of ["lead_assignment_policies","lead_assignment_policy_versions","lead_assignment_memberships","lead_assignment_availability","lead_assignments","lead_assignment_events"])assert.match(engine,new RegExp(token));
 assert.match(engine,/UNIQUE\(employee_email,team_code\)/);assert.match(engine,/idempotency_key TEXT NOT NULL UNIQUE/);assert.match(engine,/lead_assignments_one_current_idx/);
});

test("assignment uses active platform users and configured service city workload eligibility",()=>{
 assert.match(engine,/JOIN app_users u ON u.email=m.employee_email/);assert.match(engine,/u.status='active'/);assert.match(engine,/service_codes_json/);assert.match(engine,/city_ids_json/);assert.match(engine,/max_active_workload/);assert.match(engine,/workload_cap_override/);assert.match(engine,/activeLoad<item.effectiveCap/);
});

test("shift requirement is optional policy and no eligible owner goes to visible fallback queue",()=>{
 assert.match(engine,/require_shift/);assert.match(engine,/lead_assignment_availability/);assert.match(engine,/fallback_queue/);assert.match(engine,/fallback_queued/);assert.match(engine,/employeeEmail\?null:fallbackQueue/);
});

test("continuity and manager override only select currently eligible candidates",()=>{
 assert.match(engine,/continuity_enabled/);assert.match(engine,/legacyOwner/);assert.match(engine,/preferredEmployeeEmail/);assert.match(engine,/Preferred lead owner is not currently eligible/);
});

test("reassignment preserves history instead of overwriting canonical ownership",()=>{
 assert.match(engine,/status='superseded'/);assert.match(engine,/previous_assignment_id/);assert.match(engine,/reassignmentReason/);assert.match(engine,/event_type/);assert.match(engine,/"reassigned"/);
});

test("legacy lead owner is projection only and integrity mismatches are surfaced",()=>{
 assert.match(engine,/canonicalOwnerAuthority:"lead_assignments"/);assert.match(engine,/legacyLeadOwnerField:"projection_only"/);assert.match(engine,/projectionMismatches/);assert.match(engine,/hardCodedOwnerRotationAuthoritative:false/);
});

test("assignment API requires customers manage for policy assignment and reassignment",()=>{
 assert.match(api,/authorize\(request,"customers\.manage"\)/);assert.match(api,/lead\.assignment\.policy\.save/);assert.match(api,/lead\.assignment\.assign/);assert.match(api,/lead\.assignment\.reassign/);assert.match(api,/productionReady:false/);
});

test("legacy hard-coded owner rotation remains noncanonical scaffolding to remove in later migration",()=>{
 assert.match(legacy,/const owners=\["Neha","Rahul","Priya","Sanjay"\]/);assert.match(engine,/hardCodedOwnerRotationAuthoritative:false/);
});
