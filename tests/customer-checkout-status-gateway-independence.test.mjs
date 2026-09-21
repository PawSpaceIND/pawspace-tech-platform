import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
installWorkersHooks("__CUSTOMER_CHECKOUT_GATEWAY_DB__", "__CUSTOMER_CHECKOUT_GATEWAY_ENV__");

// CUST-L-D04 / CUST-L-D11: POST /api/customer-checkout called customerCheckoutEnvironment(runtime) —
// the Razorpay sandbox-key configuration gate — unconditionally, before even looking at body.action.
// {action:"status"} is a pure read of PawSpace's own canonical_bookings/booking_payments record; it
// opens no gateway order and needs no Razorpay key. Gating it behind the SAME check as {action:"start"}
// meant a missing/placeholder Razorpay key 503'd every booking-status read too, which is what emptied
// /v2/booking (View booking & payment, reached from /v2/activity) and the /v2/training?bookingId=
// recovery screen down to the gateway error alone. The booking record must render from PawSpace's own
// data regardless of gateway configuration; only actually starting a payment needs the gateway.

const ORIGIN = "https://checkout-gateway.pawspace.test";
const UNCONFIGURED_ENV = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" }; // no Razorpay keys at all

function world(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT DEFAULT 'dog_training',package_code TEXT DEFAULT 'training-programme',package_name TEXT DEFAULT 'Training programme',provider_id TEXT DEFAULT 'TRN1',scheduled_start TEXT DEFAULT '2026-09-20T03:30:00.000Z',scheduled_end TEXT DEFAULT '2026-09-20T05:30:00.000Z',total_amount REAL DEFAULT 3499,currency TEXT DEFAULT 'INR',updated_at INTEGER DEFAULT 1);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,status TEXT,amount REAL,amount_due_now REAL,currency TEXT,mode TEXT DEFAULT 'prepaid');
    CREATE TABLE provider_work_orders(id TEXT PRIMARY KEY,booking_id TEXT,provider_name TEXT,provider_model TEXT,status TEXT);
    INSERT INTO canonical_bookings(id,customer_id,status) VALUES('BK-GW-1','CUST-GW-1','payment_pending');
    INSERT INTO booking_payments(id,booking_id,customer_id,status,amount,amount_due_now,currency) VALUES('PAY-GW-1','BK-GW-1','CUST-GW-1','created',3499,3499,'INR');
    INSERT INTO provider_work_orders VALUES('WO-GW-1','BK-GW-1','Priya Trainer','full_time','assigned');`);
  const db = d1(sqlite);
  enterWorkersDbScope(db);
  globalThis.__CUSTOMER_CHECKOUT_GATEWAY_DB__ = db;
  globalThis.__CUSTOMER_CHECKOUT_GATEWAY_ENV__ = { ...UNCONFIGURED_ENV };
  return { sqlite, db };
}

async function cookie(db, subjectId = "CUST-GW-1") {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${subjectId}`,
    subjectType: "customer", subjectId, actorId: "checkout-gateway-independence-test", reason: "regression fixture",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: binding.id, identitySource: "customer_otp", principalType: "identity_subject",
    principalKey: `customer:${subjectId}`, subjectType: "customer", subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

function request(body, session) {
  return new Request(`${ORIGIN}/api/customer-checkout`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: session },
    body: JSON.stringify(body),
  });
}

test("status reads the owned booking record even with no Razorpay sandbox key configured", async (t) => {
  const { db } = world(t);
  const session = await cookie(db);
  const { POST } = await import("../app/api/customer-checkout/route.ts");
  const response = await POST(request({ action: "status", bookingId: "BK-GW-1" }, session));
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.data.confirmation.bookingId, "BK-GW-1");
  assert.equal(body.data.confirmation.serviceCode, "dog_training");
  assert.equal(body.data.confirmation.bookingStatus, "payment_pending");
  assert.equal(body.data.confirmation.providerName, "Priya Trainer");
  assert.equal(body.data.confirmation.totalAmount, 3499);
});

test("start still refuses with the honest gateway-configuration message when Razorpay is unconfigured", async (t) => {
  const { db } = world(t);
  const session = await cookie(db);
  const { POST } = await import("../app/api/customer-checkout/route.ts");
  const response = await POST(request({ action: "start", bookingId: "BK-GW-1" }, session));
  const raw = await response.text();
  assert.equal(response.status, 503, raw);
  assert.match(JSON.parse(raw).error, /Razorpay test checkout is not configured/);
});
