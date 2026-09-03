import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const reveal=read("app/api/customer-data-reveal/route.ts");
const governance=read("app/api/platform-governance/route.ts");
const auth=read("lib/server-auth.ts");
const onboarding=read("app/api/provider-onboarding/route.ts");
const reconciliation=read("app/api/payment-reconciliation/route.ts");
const subscriptionAdmin=read("app/api/subscription-billing-admin/route.ts");

test("PII reveal authority is resolved from canonical D1 state, not request assignment fields",()=>{
  assert.match(reveal,/client_assignment_not_accepted/);
  assert.match(reveal,/Object\.prototype\.hasOwnProperty\.call\(body,"assignment"\)/);
  assert.match(reveal,/Object\.prototype\.hasOwnProperty\.call\(body,"assignedTo"\)/);
  assert.match(reveal,/SELECT id,customer_id,owner,status FROM lead_work_items WHERE id=\?/);
  assert.match(reveal,/SELECT id,customer_id,provider_id,status,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=\?/);
  assert.match(reveal,/Assignment does not belong to this customer/);
  assert.ok(reveal.indexOf("canonicalAssignment(db")<reveal.indexOf("mayReveal(accessActor"),"server assignment must be resolved before mayReveal");
});

test("administrators cannot self-switch roles or delegate grants they do not hold",()=>{
  assert.match(governance,/self_role_change_blocked/);
  assert.match(governance,/delegation_exceeds_actor_grants/);
  assert.match(governance,/actorMayGrantPermissions/);
  assert.match(governance,/current\.permissions\.includes\("\*"\)/);
  assert.match(governance,/permissions\.every\(permission=>held\.has\(permission\)\)/);
});

test("user and custom-role mutations batch state and central audit together",()=>{
  assert.match(governance,/db\.batch\(\[\s*db\.prepare\("INSERT INTO app_users/);
  assert.match(governance,/db\.batch\(\[\s*db\.prepare\("UPDATE app_users/);
  assert.match(governance,/db\.batch\(\[\s*db\.prepare\("UPDATE role_definitions/);
  assert.match(governance,/securityAuditStatement\(db,current,"update_user"/);
  assert.match(governance,/securityAuditStatement\(db,current,"save_role"/);
});

test("encapsulated privileged mutations reserve a durable audit before state change",()=>{
  assert.match(auth,/CREATE TABLE IF NOT EXISTS security_audit_outbox/);
  assert.match(auth,/export async function reserveSecurityAudit/);
  assert.match(auth,/export async function completeReservedSecurityAudit/);
  assert.ok(onboarding.indexOf("reserveSecurityAudit(db,actor,auditAction")<onboarding.indexOf("recordProviderHumanDecision(db"),"provider approval must reserve audit before mutation");
  assert.ok(reconciliation.indexOf("reserveSecurityAudit(db,actor,auditAction")<reconciliation.indexOf("resolvePaymentException(db"),"finance override must reserve audit before mutation");
  assert.ok(subscriptionAdmin.indexOf("reserveSecurityAudit(db,actor,auditAction")<subscriptionAdmin.indexOf("approveSubscriptionRefundAgainstUnusedEntitlement(db"),"refund approval must reserve audit before mutation");
  assert.ok(subscriptionAdmin.lastIndexOf("reserveSecurityAudit(db,actor,auditAction")<subscriptionAdmin.indexOf("executeSubscriptionRefund(db"),"refund execution must reserve audit before mutation");
});

test("audit completion writes central event and outbox completion in one D1 batch",()=>{
  const start=auth.indexOf("export async function completeReservedSecurityAudit");
  const end=auth.indexOf("export function authError",start);
  const body=auth.slice(start,end);
  assert.match(body,/await db\.batch\(\[/);
  assert.match(body,/securityAuditStatement\(/);
  assert.match(body,/UPDATE security_audit_outbox SET status=/);
});
