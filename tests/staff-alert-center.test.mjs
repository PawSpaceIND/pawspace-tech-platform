import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(path,"utf8");

test("staff alerts persist one idempotent queue for lead and case escalation",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/CREATE TABLE IF NOT EXISTS staff_alerts/);assert.match(src,/idempotency_key TEXT NOT NULL UNIQUE/);assert.match(src,/lead_sla_breach/);assert.match(src,/lead_manager_escalation/);assert.match(src,/lead_reassignment_due/);assert.match(src,/case_first_response_overdue/);assert.match(src,/case_manager_escalation/);assert.match(src,/case_resolution_overdue/);});

test("alert sweep derives lead thresholds from governed SLA clocks and never hard-codes a 20 minute rule",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/c\.due_at/);assert.match(src,/c\.manager_escalation_due_at/);assert.match(src,/c\.reassignment_due_at/);assert.ok(!src.includes("20*60_000"));assert.match(src,/hardcodedTwentyMinuteRule:false/);});

test("manager escalation alert does not itself execute reassignment - that lives in the separate SLA governance sweep",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/automatically reassigned to the next eligible agent/);assert.ok(!src.includes("UPDATE lead_assignments SET employee_email"));assert.ok(!src.includes("reassignLead"));});

test("customer case escalation notices use canonical communication outbox without live provider delivery",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/enqueueCommunication/);assert.match(src,/channel:"chat"/);assert.match(src,/purpose:"service_recovery"/);assert.match(src,/case:\$\{caseId\}:customer:\$\{item\.kind\}/);assert.match(src,/customerNotificationTransport:"canonical_chat_outbox"/);assert.match(src,/externalDelivery:false/);});

test("governed runner replaces dashboard heartbeat as the scheduler boundary",()=>{const src=read("lib/staff-alert-center.ts"),page=read("app/team/alerts/page.tsx"),runner=read("app/api/staff-alert-runner/route.ts");assert.match(src,/automaticMode:"governed_runner_available"/);assert.match(src,/runnerBoundary:"\/api\/staff-alert-runner"/);assert.match(src,/backgroundSchedulerConfigured:false/);assert.ok(!page.includes("setInterval"));assert.match(page,/governed runner boundary available/);assert.match(page,/canonical chat outbox only/);assert.match(runner,/authorize\(request,"settings\.manage"\)/);assert.match(runner,/staff_alert\.runner/);assert.match(runner,/securityAudit/);assert.match(runner,/externalDelivery:false/);});

test("staff alert API separates read from manager mutation authority and audits actions",()=>{const api=read("app/api/staff-alerts/route.ts");assert.match(api,/authorize\(request,"reports\.view"\)/);assert.match(api,/authorize\(request,"customers\.manage"\)/);assert.match(api,/staff_alert\.sweep/);assert.match(api,/`staff_alert\.\$\{action\}`/);assert.match(api,/action==="acknowledge"\|\|action==="resolve"/);assert.match(api,/securityAudit/);});

test("gateway has explicit authority for case alert and runner routes",()=>{const gateway=read("lib/api-gateway.ts");assert.match(gateway,/url\.pathname==="\/api\/unified-cases"/);assert.match(gateway,/url\.pathname==="\/api\/staff-alerts"/);assert.match(gateway,/url\.pathname==="\/api\/staff-alert-runner"/);assert.match(gateway,/method==="GET"\?"bookings\.view":"bookings\.manage"/);assert.match(gateway,/method==="GET"\?"reports\.view":"customers\.manage"/);assert.match(gateway,/return "settings\.manage"/);});

test("manager alert UI exposes CRM and Case Center source drilldown without production claims",()=>{const page=read("app/team/alerts/page.tsx");assert.match(page,/href="\/team\/cases"/);assert.match(page,/href="\/crm"/);assert.match(page,/Acknowledge/);assert.match(page,/Resolve alert/);assert.match(page,/Production ready:<\/b> NO/);});
