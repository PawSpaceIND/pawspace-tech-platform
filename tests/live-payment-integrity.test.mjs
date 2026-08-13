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

/** Every payment-mode label this platform is known to use, plus values a caller could invent. */
const MODES = ["prepaid", "split_50_50", "full", "split", "deposit", "pay_after_service", "", "PREPAID", "totally_made_up", "undefined"];
const ONLINE = ["upi", "card", "netbanking", "payment_link"];

test("LIVE: a submitted 'captured' online payment is demoted for EVERY payment mode", () => {
  // The invariant: in LIVE, an online payment cannot assert its own capture. The mode label is
  // client-controlled metadata and must not decide whether verification applies.
  for (const mode of MODES) {
    for (const method of ONLINE) {
      const recorded = recordedPaymentStatus(true, { method, mode, status: "captured" });
      assert.equal(recorded, "created", `LIVE ${method} + mode '${mode}' must be demoted to 'created', got '${recorded}'`);
    }
  }
});

test("LIVE: mode 'full' with submitted captured cannot persist as captured", () => {
  assert.equal(recordedPaymentStatus(true, { method: "upi", mode: "full", status: "captured" }), "created");
});

test("LIVE: mode 'split' with submitted captured cannot persist as captured", () => {
  assert.equal(recordedPaymentStatus(true, { method: "upi", mode: "split", status: "captured" }), "created");
});

test("LIVE: the existing 'prepaid' protection still holds", () => {
  assert.equal(recordedPaymentStatus(true, { method: "upi", mode: "prepaid", status: "captured" }), "created");
});

test("LIVE: the existing 'split_50_50' protection still holds", () => {
  assert.equal(recordedPaymentStatus(true, { method: "upi", mode: "split_50_50", status: "captured" }), "created");
});

test("LIVE: an unknown mode string cannot bypass verification", () => {
  for (const mode of ["totally_made_up", "", "PREPAID", "prepaid ", "split-50-50"]) {
    assert.equal(recordedPaymentStatus(true, { method: "card", mode, status: "captured" }), "created", `mode '${mode}' must not be a bypass`);
  }
});

test("LIVE: a cash payment is unaffected — the gate is about gateway money, not all money", () => {
  // Cash is recorded by staff at the service; there is no gateway to verify against, so demoting it
  // would break legitimate collection.
  assert.equal(recordedPaymentStatus(true, { method: "cash", mode: "pay_after_service", status: "captured" }), "captured");
});

test("LIVE: statuses other than 'captured' pass through untouched", () => {
  for (const status of ["created", "pending", "failed", "awaiting_payment"]) {
    assert.equal(recordedPaymentStatus(true, { method: "upi", mode: "full", status }), status);
  }
});

// ---------------------------------------------------------------------------
// UAT/internal capture must stay environment-gated: the whole point of the gate is that it is LIVE-only.
// ---------------------------------------------------------------------------
test("UAT/internal capture behaviour does not become available in LIVE", () => {
  // Sandbox keeps the submitted status — that is the UAT mechanism, and it must remain reachable.
  for (const mode of MODES) {
    assert.equal(recordedPaymentStatus(false, { method: "upi", mode, status: "captured" }), "captured", `sandbox must keep the submitted status for mode '${mode}'`);
  }
  // And the LIVE gate is driven by the environment, not by anything a caller sends.
  assert.match(bookingRoute, /PAWSPACE_PAYMENT_ENV/, "the environment is read from the Worker env");
  assert.doesNotMatch(bookingRoute, /payment\.mode==="prepaid"\|\|payment\.mode==="split_50_50"/, "financial truth must not depend on a mode spelling");
});

// ---------------------------------------------------------------------------
// PAY-002 defect 1. The demotion carried an `!isSubscription` exemption, so a LIVE subscription purchase
// could self-declare "captured" — and be granted its sessions — with nothing verified.
//
// The invariant is executed, not pinned: the extracted function is called with a third argument, which is
// what the exemption used to consume. It must make no difference. Asserting only that the source no
// longer contains "!isSubscription" would pass again the moment someone spelled the same carve-out
// differently.
// ---------------------------------------------------------------------------
test("LIVE: a subscription purchase cannot self-declare capture either", () => {
  for (const method of ONLINE) {
    assert.equal(recordedPaymentStatus(true, { method, mode: "prepaid", status: "captured" }), "created", `a LIVE ${method} subscription purchase must await verification`);
    // Whatever a caller (or a future refactor) passes as an extra flag, the answer must not change.
    for (const flag of [true, 1, "subscription", {}]) {
      assert.equal(recordedPaymentStatus(true, { method, mode: "prepaid", status: "captured" }, flag), "created", `no third argument may re-enable LIVE self-capture (${String(flag)})`);
    }
  }
  assert.doesNotMatch(bookingRoute, /!isSubscription/, "the subscription exemption must be gone from the demotion rule");
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
