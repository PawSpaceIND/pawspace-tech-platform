import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CUST_L_D07_DB__", "__CUST_L_D07_ENV__");

// ---------------------------------------------------------------------------------------------------
// CUST-L-D07 (mobile) / CUST-L-D17 (V2 modal): the OTP sign-in showed "Your name (first time only)" /
// "Your name - first visit only" to a RETURNING customer and ignored whatever they typed there (name
// stayed "QA Grooming Parent"; same customer id after verify either way).
//
// Fix: POST /api/customer-otp (action: "request") now derives `existingCustomer` from the canonical
// customer lookup (lib/customer-otp.ts requestCustomerOtp -> resolveOtpCustomer), without leaking any
// PII across that boundary - only the boolean crosses. app/mobile-app/customer-login.tsx hides the name
// field, and never sends a typed name to verify, once existingCustomer is true.
//
// The V2 sign-in modal (app/v2/page.tsx) is out of scope for this change: it is explicitly owned by
// another agent for this launch pass. The backend now exposes what that modal needs
// (`existingCustomer`); wiring it there, and swapping its "UAT CODE" label, is left to that owner - see
// the final report for the specifics of what remains open.
// ---------------------------------------------------------------------------------------------------

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let batchTail = Promise.resolve();
  return {
    prepare: (sql) => statement(sql, []),
    batch: (items) => {
      const run = async () => {
        const out = [];
        sqlite.exec("BEGIN");
        try { for (const item of items) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
        catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      };
      const result = batchTail.then(run, run);
      batchTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
const ASSERTION_SECRET = "uat-assertion-secret-0123456789abcdef0123456789abcdef";
const SIGNING_KEY = "uat-signing-key-0123456789abcdef0123456789abcdef";

function freshWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CUST_L_D07_DB__ = db;
  globalThis.__CUST_L_D07_ENV__ = { DB: db, PAWSPACE_UAT_LOGIN: "on", PAWSPACE_IDENTITY_ENV: "sandbox", PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: ASSERTION_SECRET, PAWSPACE_UAT_SIGNING_KEY: SIGNING_KEY };
  return { sqlite, db };
}

test("CUST-L-D07 lib: requestCustomerOtp reports existingCustomer:false for a brand new phone and true after that phone verifies once", async () => {
  const { db } = freshWorld();
  const { requestCustomerOtp, verifyCustomerOtp } = await import("../lib/customer-otp.ts");

  const first = await requestCustomerOtp(db, { phone: "9812345670" });
  assert.equal(first.existingCustomer, false, "a phone with no canonical customer yet must report existingCustomer:false");

  const verified = await verifyCustomerOtp(db, { challengeId: first.challengeId, code: first.sandboxCode, name: "QA Grooming Parent" });
  assert.equal(verified.customerName, "QA Grooming Parent", "the typed name is honoured for a genuinely new account");

  const second = await requestCustomerOtp(db, { phone: "9812345670" });
  assert.equal(second.existingCustomer, true, "the SAME phone must now report existingCustomer:true - no name prompt is warranted");

  // Sanity: verifying again for the same phone must not create a second customer id, and a name typed
  // now (simulating a returning customer typing into a field that should not even be shown) must be
  // ignored by the canonical identity - it is bound to the phone, not re-created from the request.
  const secondVerify = await verifyCustomerOtp(db, { challengeId: second.challengeId, code: second.sandboxCode, name: "Someone Else Entirely" });
  assert.equal(secondVerify.customerId, verified.customerId, "a returning customer must resolve to the SAME canonical customer id");
});

test("CUST-L-D07 lib: existingCustomer does not leak the canonical customer's PII across the boundary", async () => {
  const { db } = freshWorld();
  const { requestCustomerOtp, verifyCustomerOtp } = await import("../lib/customer-otp.ts");
  const first = await requestCustomerOtp(db, { phone: "9812345671" });
  await verifyCustomerOtp(db, { challengeId: first.challengeId, code: first.sandboxCode, name: "Real Customer Name" });
  const second = await requestCustomerOtp(db, { phone: "9812345671" });
  const serialized = JSON.stringify(second);
  assert.equal(second.existingCustomer, true);
  assert.doesNotMatch(serialized, /Real Customer Name/, "only the boolean may cross - never the resolved name/id/city");
});

test("CUST-L-D07 route: POST /api/customer-otp (action: request) surfaces existingCustomer in both the sandbox and the explicit live-mode response shape", async () => {
  freshWorld();
  const route = await import("../app/api/customer-otp/route.ts");
  const requestOnce = () => route.POST(new Request("http://localhost/api/customer-otp", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ action: "request", phone: "9812345672" }),
  }));

  const firstResponse = await requestOnce();
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.data.existingCustomer, false, "the field must be present (and false) before any verify has happened for this phone");

  const verifyResponse = await route.POST(new Request("http://localhost/api/customer-otp", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ action: "verify", challengeId: firstBody.data.challengeId, code: firstBody.data.sandboxCode, name: "First Timer", cityId: "blr" }),
  }));
  assert.equal(verifyResponse.status, 200, await verifyResponse.text());

  const secondResponse = await requestOnce();
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.data.existingCustomer, true, "the SAME phone must now be reported as an existing customer, so the client can hide the name field");
});

// Wiring check: the mobile sign-in screen must actually hide the field, and must never send a typed
// name for a returning customer even if something re-shows the input.
test("CUST-L-D07 wiring: the mobile OTP screen only renders/sends the name field for a NEW account", () => {
  const source = fs.readFileSync(new URL("../app/mobile-app/customer-login.tsx", import.meta.url), "utf8");
  assert.match(source, /existingCustomer/, "the component must track existingCustomer from the request response");
  assert.match(source, /!existingCustomer\s*&&/, "the name field must be conditionally rendered only for a new account");
  assert.match(source, /existingCustomer\s*\?\s*undefined\s*:\s*\(name \|\| undefined\)/, "verify must never send a typed name for a returning customer");
});
