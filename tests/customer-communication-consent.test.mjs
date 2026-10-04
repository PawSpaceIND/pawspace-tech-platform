/** TEST / LOCAL. Customer-owned central channel consent writer: session subject only, explicit boolean, no default-allow, audited. */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
const ROUTE = "../../app/api/customer-communication-consent/route.ts";

test("only the signed-in customer can write their own consent; values are explicit and attributable", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const me = await sessionCookie(ctx.db, "customer", "CUST-CONSENT-01", "customer:CUST-CONSENT-01");
  const other = await sessionCookie(ctx.db, "customer", "CUST-CONSENT-02", "customer:CUST-CONSENT-02");
  // No customer session (staff headers only) -> 401; never a staff path.
  assert.equal((await routeCall(ROUTE, "POST", "/api/customer-communication-consent", { channel: "voice", allowed: true })).status, 401);
  // Another customer naming me -> 403.
  assert.equal((await routeCall(ROUTE, "POST", "/api/customer-communication-consent", { customerId: "CUST-CONSENT-01", channel: "voice", allowed: true }, other)).status, 403);
  // Non-explicit / invalid inputs -> 400 and no row.
  for (const body of [{ channel: "voice", allowed: "true" }, { channel: "voice", allowed: 1 }, { channel: "voice" }, { channel: "pigeon", allowed: true }, { channel: "voice", allowed: true, source: "staff_console" }]) {
    const r = await routeCall(ROUTE, "POST", "/api/customer-communication-consent", body, me);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='communication_consent'").get().c === 0 ? 0 : ctx.sqlite.prepare("SELECT COUNT(*) c FROM communication_consent").get().c, 0);
  // Explicit allow for ONE channel: other channels stay NULL (unknown), never defaulted to allowed.
  const allowed = await routeCall(ROUTE, "POST", "/api/customer-communication-consent", { channel: "voice", allowed: true, source: "customer_app_settings" }, me);
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body)); assert.equal(allowed.body.data.effectiveAllowed, true); assert.equal(allowed.body.data.updatedBy, "customer:CUST-CONSENT-01");
  let row = ctx.sqlite.prepare("SELECT * FROM communication_consent WHERE customer_id='CUST-CONSENT-01'").get();
  assert.equal(row.voice_allowed, 1); assert.equal(row.whatsapp_allowed, null); assert.equal(row.sms_allowed, null); assert.equal(row.email_allowed, null); assert.equal(row.global_opt_out, 0); assert.equal(row.source, "customer_app_settings");
  // Explicit refusal is persisted as 0, not deleted.
  const refused = await routeCall(ROUTE, "POST", "/api/customer-communication-consent", { channel: "voice", allowed: false }, me);
  assert.equal(refused.status, 201); assert.equal(refused.body.data.effectiveAllowed, false);
  row = ctx.sqlite.prepare("SELECT voice_allowed FROM communication_consent WHERE customer_id='CUST-CONSENT-01'").get(); assert.equal(row.voice_allowed, 0);
  // A global opt-out is never lifted by a channel allow.
  const { recordGlobalOptOut } = await import("../lib/communication-governance.ts");
  await recordGlobalOptOut(ctx.db, { customerId: "CUST-CONSENT-01", source: "test", actorId: "customer:CUST-CONSENT-01" });
  const afterOptOut = await routeCall(ROUTE, "POST", "/api/customer-communication-consent", { channel: "voice", allowed: true }, me);
  assert.equal(afterOptOut.status, 201); assert.equal(afterOptOut.body.data.globalOptOut, true); assert.equal(afterOptOut.body.data.effectiveAllowed, false);
  assert.equal(ctx.sqlite.prepare("SELECT global_opt_out FROM communication_consent WHERE customer_id='CUST-CONSENT-01'").get().global_opt_out, 1);
  // The write is audited with the customer as actor.
  const audits = ctx.sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='communication_consent.channel.record' AND resource_id='CUST-CONSENT-01'").get().c;
  assert.ok(audits >= 3, `audited writes: ${audits}`);
  // The feedback-call prerequisite reads this row: with allow it is explicit, with refusal it is not.
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM communication_consent").get().c, 1);
});
