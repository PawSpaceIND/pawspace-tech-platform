import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Grooming security uses explicit gateway permissions and trusted identity ownership",async()=>{
  const[gateway,auth,binding,bindingApi,change,lifecycle,partner]=await Promise.all([
    source("lib/api-gateway.ts"),
    source("lib/server-auth.ts"),
    source("lib/identity-binding.ts"),
    source("app/api/identity-bindings/route.ts"),
    source("app/api/grooming-booking-change/route.ts"),
    source("app/api/grooming-lifecycle/route.ts"),
    source("app/api/partner-grooming-jobs/route.ts"),
  ]);
  assert.match(gateway,/\/api\/identity-bindings/);
  assert.match(gateway,/\/api\/partner-grooming-jobs/);
  assert.match(gateway,/\/api\/grooming-booking-change/);
  assert.match(gateway,/\/api\/grooming-finance/);
  assert.match(gateway,/body\.action==="mark_paid"\?"payments\.manage":"bookings\.view"/);
  assert.match(auth,/ensureIdentityBindingTables/);
  assert.match(auth,/findIdentityBinding/);
  assert.match(auth,/customer_identity_links/);
  assert.match(auth,/provider_identity_links/);
  assert.match(auth,/requireCustomerOwnership/);
  assert.match(auth,/requireProviderOwnership/);
  assert.match(binding,/CREATE TABLE IF NOT EXISTS identity_bindings/);
  assert.match(binding,/verification_state='verified'/);
  assert.match(binding,/identity_binding_audit/);
  assert.match(binding,/status='revoked'/);
  assert.match(bindingApi,/requirePermission\(actor,"users\.manage"\)/);
  assert.match(bindingApi,/"workspace","customer_otp","partner_otp","migration"/);
  assert.match(change,/resolveActor\(request\)/);
  assert.match(change,/requireCustomerOwnership\(db,actor,input\.customerId\)/);
  assert.match(change,/securityAudit/);
  assert.doesNotMatch(change,/actor_id=\?,reason=.*bind\(input\.customerId/);
  assert.match(lifecycle,/requirePermission\(actorIdentity,"payments\.manage"\)/);
  assert.match(lifecycle,/requireProviderOwnership\(db,actorIdentity,String\(work\.provider_id\)\)/);
  assert.match(lifecycle,/const actor=actorIdentity\.email/);
  assert.match(lifecycle,/securityAudit/);
  assert.match(partner,/resolveActor\(request\)/);
  assert.match(partner,/requirePermission\(actor,"bookings\.view"\)/);
  assert.match(partner,/requireProviderOwnership\(db,actor,providerId\)/);
});
