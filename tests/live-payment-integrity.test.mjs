import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PAY-001. Two live-payment integrity defects, both about money and neither caught by the tests that
// existed — because those tests asserted the SOURCE TEXT of the guard rather than executing it.
//
// Defect 1: recordedPaymentStatus demoted a client-submitted "captured" to "created" in LIVE only when
// payment.mode was exactly "prepaid" or "split_50_50". The platform also uses "full" and "split", so a
// caller could persist a captured online payment in LIVE simply by labelling it differently — or with
// any unrecognised string. Two tests (money-hardening, payment-verify-first) pinned that exact
// condition as a regex, so they passed for the whole time the bypass existed and would have kept
// passing. They now assert the invariant instead.
//
// Defect 2: createBookingPaymentOrder built the Razorpay order from booking_payments.amount — the full
// booking total — ignoring amount_due_now. A customer who chose to pay a 50% deposit was asked for 100%.
//
// These tests execute recordedPaymentStatus's real invariant across the whole mode vocabulary, and run
// the real order-creation function against a real database with a stubbed gateway.
// ---------------------------------------------------------------------------
// The shared installer, not a private copy. `module.registerHooks` only exists from Node 22.15 and CI
// pins 22.13.0, where a feature-detected-but-fallback-less copy quietly registers no resolver at all —
// so `lib/payment-order-intent.ts` importing "./razorpay-client" extensionlessly dies with
// ERR_MODULE_NOT_FOUND before a single assertion runs. Green locally, red on CI.
installWorkersHooks("__PAY001_DB__", "__PAY001_ENV__");

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const bookingRoute = read("app/api/canonical-bookings/route.ts");
const intent = await import("../lib/payment-order-intent.ts");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// ---------------------------------------------------------------------------
// Defect 1. recordedPaymentStatus is module-private, so its exact source is extracted and evaluated.
// This is not a regex assertion: the function BODY runs, and the assertions are about what it returns
// for real inputs. Extracting it is what lets the invariant be tested across the whole mode vocabulary
// without standing up the entire booking POST path.
// ---------------------------------------------------------------------------
function loadRecordedPaymentStatus(source) {
  const online = source.match(/const ONLINE_METHODS=new Set\((\[[^\]]*\])\);/);
  const fn = source.match(/function recordedPaymentStatus\([\s\S]*?\n(?=const |function |async function )/);
  assert.ok(online, "ONLINE_METHODS must be present in the route");
  assert.ok(fn, "recordedPaymentStatus must be present in the route");
  const body = fn[0].replace(/:\s*(boolean|string|number|\{[^}]*\})/g, "");
  return new Function(`const ONLINE_METHODS=new Set(${online[1]});${body};return recordedPaymentStatus;`)();
}
const recordedPaymentStatus = loadRecordedPaymentStatus(bookingRoute);

// Every method label the platform uses, plus values a caller could invent — and the offline one.
const METHODS = ["upi", "card", "netbanking", "payment_link", "cash", "wallet", "crypto", "", "UPI", "CASH", "totally_made_up"];
const MODES = ["prepaid", "split_50_50", "full", "split", "deposit", "pay_after_service", "", "PREPAID", "totally_made_up"];

test("LIVE: a submitted 'captured' is demoted for EVERY method and mode when the server has not authorized an offline collection", () => {
  // The invariant fails CLOSED on the client's labels. Without a server authorization, no method —
  // known, unknown, blank, or the string 'cash' — and no mode keeps a self-declared capture in LIVE.
  for (const method of METHODS) {
    for (const mode of MODES) {
      const recorded = recordedPaymentStatus(true, { method, mode, status: "captured" }, false);
      assert.equal(recorded, "created", `LIVE '${method}' + '${mode}' must be demoted without offline authorization, got '${recorded}'`);
    }
  }
});

test("LIVE: only a server-authorized offline collection keeps 'captured' — the method label never decides", () => {
  // offlineAuthorized is the ONLY input that changes the answer. The very same method that is demoted
  // when unauthorized is kept when authorized, proving the rule keys off the server's authorization and
  // not off any client-controlled method string.
  for (const method of METHODS) {
    assert.equal(recordedPaymentStatus(true, { method, mode: "prepaid", status: "captured" }, true), "captured", `an authorized offline collection keeps captured ('${method}')`);
    assert.equal(recordedPaymentStatus(true, { method, mode: "prepaid", status: "captured" }, false), "created", `the same method is demoted when not authorized ('${method}')`);
  }
});

test("LIVE: an unknown/unsupported method + captured fails closed", () => {
  for (const method of ["crypto", "giftcard", "", "cash ", "bank_transfer", "totally_made_up", "netbanking2"]) {
    assert.equal(recordedPaymentStatus(true, { method, mode: "full", status: "captured" }, false), "created", `unsupported method '${method}' must not preserve captured in LIVE`);
  }
});

test("LIVE: the existing prepaid / split_50_50 protection still holds", () => {
  for (const mode of ["prepaid", "split_50_50"]) {
    assert.equal(recordedPaymentStatus(true, { method: "upi", mode, status: "captured" }, false), "created");
  }
});

test("LIVE: statuses other than 'captured' pass through untouched", () => {
  for (const status of ["created", "pending", "failed", "awaiting_payment"]) {
    assert.equal(recordedPaymentStatus(true, { method: "upi", mode: "full", status }, false), status);
    assert.equal(recordedPaymentStatus(true, { method: "cash", mode: "full", status }, true), status);
  }
});

test("UAT/sandbox keeps the submitted status regardless — the gate is LIVE-only", () => {
  for (const method of METHODS) for (const mode of MODES) {
    assert.equal(recordedPaymentStatus(false, { method, mode, status: "captured" }, false), "captured", `sandbox must keep the submitted status ('${method}' / '${mode}')`);
  }
});

test("the demotion keys off server authorization, not a client-controlled label", () => {
  assert.match(bookingRoute, /PAWSPACE_PAYMENT_ENV/, "the environment is read from the Worker env");
  assert.doesNotMatch(bookingRoute, /payment\.mode==="prepaid"\|\|payment\.mode==="split_50_50"/, "no mode allowlist may decide financial truth");
  assert.doesNotMatch(bookingRoute, /!isSubscription/, "no subscription carve-out");
  // The bug was that the demotion gated on ONLINE_METHODS.has(payment.method): an off-list method
  // slipped through. The security decision must not depend on the method allowlist any more.
  assert.doesNotMatch(bookingRoute, /liveMode&&ONLINE_METHODS\.has\(payment\.method\)&&payment\.status==="captured"/, "the demotion must not gate on the online-method allowlist");
  assert.match(bookingRoute, /payment\.status==="captured"&&!offlineAuthorized\)return "created"/, "the demotion keys off status + server authorization");
  // And authorization is a server permission plus the offline method, never a client flag alone.
  assert.match(bookingRoute, /OFFLINE_METHODS\.has\(input\.payment\.method\)&&hasPermission\(actor\.permissions,"payments\.manage"\)/, "offline authorization requires payments.manage");
});

// ---------------------------------------------------------------------------
// Defect 2. The gateway order must charge the amount due at this stage.
// ---------------------------------------------------------------------------
function paymentsDb({ amount, amountDueNow, status = "created" }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAY001_DB__ = db;
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?)").run("BK-1", "CUS-1");
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,?,?)").run("PAY-1", "BK-1", "CUS-1", amount, amountDueNow, "INR", status);
  return { sqlite, db };
}

/** A gateway that records what it was asked to charge, instead of calling Razorpay. */
function stubGateway() {
  const calls = [];
  return {
    calls,
    env: {
      RAZORPAY_KEY_ID_SANDBOX: "rzp_test_stub",
      RAZORPAY_KEY_SECRET_SANDBOX: "stub-secret",
      PAWSPACE_PAYMENT_ENV: "sandbox",
      __fetch: (amount) => calls.push(amount),
    },
  };
}

test("real execution: a split booking creates a gateway order for amount_due_now, not the total", async () => {
  const { db } = paymentsDb({ amount: 3600, amountDueNow: 1800 });
  const gateway = stubGateway();
  // Intercept the outbound order creation so the amount actually requested can be observed.
  const realFetch = globalThis.fetch;
  let requestedSubunits = null;
  globalThis.fetch = async (url, init) => {
    requestedSubunits = JSON.parse(String(init?.body || "{}")).amount;
    return new Response(JSON.stringify({ id: "order_stub_split" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await intent.createBookingPaymentOrder(db, gateway.env, { bookingId: "BK-1", customerId: "CUS-1", actorId: "test" });
    assert.equal(result.connected, true, `expected a connected order, got ${JSON.stringify(result)}`);
    assert.equal(result.amount, 1800, "the order must be for the ₹1800 due now, not the ₹3600 total");
    assert.equal(result.bookingTotal, 3600, "and it should still report the booking total for display");
    assert.equal(requestedSubunits, 180000, "Razorpay is charged 1800 rupees in subunits");
  } finally { globalThis.fetch = realFetch; }
});

test("real execution: a full-payment booking creates a gateway order for the full amount", async () => {
  const { db } = paymentsDb({ amount: 1299, amountDueNow: 1299 });
  const gateway = stubGateway();
  const realFetch = globalThis.fetch;
  let requestedSubunits = null;
  globalThis.fetch = async (url, init) => {
    requestedSubunits = JSON.parse(String(init?.body || "{}")).amount;
    return new Response(JSON.stringify({ id: "order_stub_full" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await intent.createBookingPaymentOrder(db, gateway.env, { bookingId: "BK-1", customerId: "CUS-1", actorId: "test" });
    assert.equal(result.amount, 1299, "a full payment must still charge the whole amount");
    assert.equal(requestedSubunits, 129900);
  } finally { globalThis.fetch = realFetch; }
});

test("the order intent still never self-captures", () => {
  const intentSource = read("lib/payment-order-intent.ts");
  assert.match(intentSource, /status: "awaiting_payment"/, "capture remains the webhook's job");
  assert.match(intentSource, /if \(!created\.connected\) return \{ connected: false/, "and it fails closed without credentials");
});
