import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(path,"utf8");

test("staff alerts persist one idempotent queue for lead and case escalation",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/CREATE TABLE IF NOT EXISTS staff_alerts/);assert.match(src,/idempotency_key TEXT NOT NULL UNIQUE/);assert.match(src,/lead_sla_breach/);assert.match(src,/lead_manager_escalation/);assert.match(src,/lead_reassignment_due/);assert.match(src,/case_first_response_overdue/);assert.match(src,/case_manager_escalation/);assert.match(src,/case_resolution_overdue/);});

test("alert sweep derives lead thresholds from SLA clocks and never hard-codes a 20 minute business rule",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/c\.due_at/);assert.match(src,/c\.manager_escalation_due_at/);assert.match(src,/c\.reassignment_due_at/);assert.ok(!src.includes("20*60_000"));assert.match(src,/hardcodedTwentyMinuteRule:false/);});

test("manager escalation does not automatically reassign lead ownership",()=>{const src=read("lib/staff-alert-center.ts");assert.match(src,/Reassignment remains a manager decision/);assert.ok(!src.includes("UPDATE lead_assignments SET employee_email"));assert.ok(!src.includes("reassignLead"));});

test("automatic alerts are manager-dashboard heartbeat only until a background scheduler is configured",()=>{const src=read("lib/staff-alert-center.ts"),page=read("app/team/alerts/page.tsx");assert.match(src,/backgroundSchedulerConfigured:false/);assert.match(src,/automaticMode:"manager_dashboard_heartbeat"/);assert.match(src,/externalDelivery:false/);assert.match(page,/setInterval/);assert.match(page,/60_000/);assert.match(page,/Background scheduler:<\/b> not configured yet/);});

test("staff alert API separates read from manager mutation authority and audits actions",()=>{const api=read("app/api/staff-alerts/route.ts");assert.match(api,/authorize\(request,"reports\.view"\)/);assert.match(api,/authorize\(request,"customers\.manage"\)/);assert.match(api,/staff_alert\.sweep/);assert.match(api,/staff_alert\.acknowledge/);assert.match(api,/staff_alert\.resolve/);assert.match(api,/securityAudit/);});

test("manager alert UI exposes CRM and Case Center source drilldown without production claims",()=>{const page=read("app/team/alerts/page.tsx");assert.match(page,/href="\/team\/cases"/);assert.match(page,/href="\/crm"/);assert.match(page,/Acknowledge/);assert.match(page,/Resolve alert/);assert.match(page,/Production ready:<\/b> NO/);});
