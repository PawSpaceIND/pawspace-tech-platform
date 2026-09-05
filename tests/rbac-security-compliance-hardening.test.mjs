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

/*
 * The PROPERTY under test is unchanged: nothing the caller says may decide its own reveal. The
 * MECHANISM is #448's, which landed first (main 64cc52a) and is the stricter of the two.
 *
 * This PR originally kept assignedTo/status/scheduledStart/completedAt on RevealInput and rejected a
 * body carrying them at runtime (client_assignment_not_accepted). #448 instead DELETES those four
 * fields from the type, so there is no code path that can read them even if a caller sends them - a
 * removed field cannot be forgotten about, where a runtime rejection has to be maintained. The
 * assertions below therefore pin the absence, which is what actually makes the guarantee.
 */
test("PII reveal authority is resolved from canonical D1 state, not request assignment fields",()=>{
  // The four deciding attributes are absent from the wire type entirely.
  const revealInput=reveal.match(/type RevealInput=\{[^}]*\}[^;]*;/)?.[0]??"";
  assert.ok(revealInput,"RevealInput type must be declared");
  for(const field of ["assignedTo","status","scheduledStart","completedAt"]){
    assert.doesNotMatch(revealInput,new RegExp(field),`RevealInput must not accept ${field} from the caller`);
  }
  // `assignment` survives only as a pointer: which record, nothing more.
  assert.match(revealInput,/assignment\?:\{type\?:"lead"\|"booking";id\?:string\}\|null/);
  // Every deciding attribute is read from the database instead.
  assert.match(reveal,/SELECT id,owner,stage FROM crm_contacts WHERE id=\?/);
  assert.match(reveal,/FROM communication_threads WHERE booking_id=\? AND customer_id=\?/);
  assert.match(reveal,/SELECT customer_id,status,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=\?/);
  // A record belonging to a different customer justifies nothing.
  assert.match(reveal,/if\(booking&&String\(booking\.customer_id\?\?""\)!==customerId\)return null/);
  assert.ok(reveal.indexOf("resolvedAssignment(db")<reveal.indexOf("mayReveal(accessActor"),"server assignment must be resolved before mayReveal");
  // And the resolved assignment is what the audit trail records, not the claimed one.
  assert.match(reveal,/assignmentType:assignment\?\.type\?\?null,assignmentId:assignment\?\.id\?\?null/);
});

/*
 * Same property, #448's mechanism again, and here the difference is substantive rather than stylistic.
 *
 * This PR blocked the self-directed case explicitly (self_role_change_blocked) on top of a delegation
 * check. #448 argues - persuasively, and it landed first - that a self-check is the wrong guard: it
 * leaves the identical escalation available through a second account the same actor controls, and it
 * wrongly permits handing a COLLEAGUE authority the actor cannot exercise. unheldGrants() asks about
 * the grant rather than the recipient, so it holds for self, colleague and new account alike, which
 * SUBSUMES the self case rather than dropping it. That is why there is no self_role_change_blocked
 * assertion here any more: the escalation it named is closed by a broader rule.
 */
test("administrators cannot delegate grants they do not hold, to anyone including themselves",()=>{
  assert.match(governance,/function unheldGrants\(/);
  assert.match(governance,/insufficient_clearance/);
  assert.match(governance,/current\.permissions\.includes\("\*"\)/);
  assert.match(governance,/requested\.filter\(grant=>!held\.has\(grant\)\)/);
  // Applied to every writer of authority, not just the one the report happened to name.
  for(const action of ["create_user","update_user","save_role"]){
    const at=governance.indexOf(`action==="${action}"`);
    assert.ok(at>=0,`${action} branch must exist`);
    const branch=governance.slice(at,governance.indexOf("return Response.json({ok:true})",at));
    assert.match(branch,/unheldGrants\(current,/,`${action} must apply the clearance rule`);
  }
  // The self-directed case is still identifiable in the trail even though it is not the guard.
  assert.match(governance,/selfDirected:normaliseCode\(target\?\.email\)===normaliseCode\(current\.email\)/);
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
