/**
 * Verify-first payments — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Four tests that read six files as strings. Its own comments admit what
 * that costs: one assertion "used to pin the condition verbatim, INCLUDING the two mode names it
 * tested for", so when the platform grew a "full" and a "split" mode the guard let them bypass
 * verification entirely "and this assertion passed the whole time, because the source matched the
 * source". Another test proved the reconciler never matches on a phone number with
 * `assert.doesNotMatch(recon, /phone/i)` — a claim about the letters in a file, which the word "phone"
 * appearing in any comment would have broken and which the reconciler ignoring booking ids entirely
 * would not.
 *
 * Now seven EXECUTED tests. Each drives a real function or a real route handler against a real
 * SQLite-backed D1 and asserts on the value returned or the row written.
 *
 * `fetch` is stubbed where the adapter would otherwise reach api.razorpay.com. The stub is not a
 * convenience: two tests assert that a refusal happens WITHOUT any network call, which can only be
 * shown by making a call fail the test.
 *
 * Requests go to https://ops.pawspace.example, not localhost, except where a case genuinely needs the
 * development-preview staff actor — the one such case says so and explains why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__VERIFY_FIRST_DB__", "__VERIFY_FIRST_ENV__");

const razorpay = await import("../lib/razorpay-client.ts");
const engine = await import("../lib/grooming-payment-reconciliation.ts");
const reconRoute = await import("../app/api/payment-reconciliation/route.ts");
const bookingsRoute = await import("../app/api/canonical-bookings/route.ts");

const NOW = Date.now();
const DAY = 86_400_000;
const ORIGIN = "https://ops.pawspace.example";
const FINANCE = "finance.verify@pawspace.test";
const MANAGER = "manager.verify@pawspace.test";
const BOOKING_STAFF = "booking.verify@pawspace.test";

const SANDBOX_KEYS = { RAZORPAY_KEY_ID_SANDBOX: "rzp_test_stub", RAZORPAY_KEY_SECRET_SANDBOX: "stub_secret" };
const LIVE_KEYS = { RAZORPAY_KEY_ID: "rzp_live_stub", RAZORPAY_KEY_SECRET: "stub_live_secret" };

/**
 * Runs `body` with `fetch` replaced. Every test that touches the adapter goes through this, so no test
 * in this file can silently make a real outbound request.
 */
async function withFetch(handler, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  try { return await body(calls); } finally { globalThis.fetch = original; }
}

const forbidNetwork = () => { throw new Error("THE ADAPTER REACHED THE NETWORK"); };

/** The reconciliation world: the tables the engine owns plus the canonical tables it reads. */
function reconWorld(env = { PAWSPACE_PAYMENT_ENV: "sandbox" }) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VERIFY_FIRST_DB__ = db;
  globalThis.__VERIFY_FIRST_ENV__ = env;
  // DDL copied verbatim from the owning sources.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  installFinancialLifecycleSchema(sqlite);
  return { sqlite, db };
}

/** A booking with its payment row. `phone` is explicit so two bookings can share one. */
function seedBooking(sqlite, { id, total = 2000, currency = "INR", customer = `cus_${id}`, phone = "+91-9000000051" }) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customer, "blr", `Customer ${customer}`, phone, `${customer}@example.in`, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,currency,created_by,created_at,updated_at) VALUES (?,?,?,'blr','blr-east','grooming','pkg','Pkg',?,'groom_arun',?,?,?,?,'verify',?,?)")
    .run(id, `k-${id}`, customer, `g-${id}`, new Date(NOW + 3 * DAY).toISOString(), new Date(NOW + 3 * DAY + 3_600_000).toISOString(), total, currency, NOW - DAY, NOW - DAY);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,'upi','prepaid','created',?,?,?)")
    .run(`PAY-${id}`, id, customer, total, total, currency, `pk-${id}`, NOW - DAY, NOW - DAY);
  return `PAY-${id}`;
}

const signedEvent = (extra) => ({
  provider: "razorpay", environment: "sandbox", eventId: `evt-${crypto.randomUUID().slice(0, 8)}`,
  eventType: "payment.captured", amountSubunits: 200_000, currency: "INR", createdAt: NOW,
  signatureVerified: true, payloadHash: `hash-${crypto.randomUUID().slice(0, 8)}`, detail: {}, ...extra,
});

const exceptions = async (db) => (await db.prepare("SELECT id,booking_id,payment_id,event_id,exception_type,status FROM payment_reconciliation_exceptions ORDER BY created_at").all()).results.map((row) => ({ ...row }));

async function refusal(promise) {
  try { await promise; return null; }
  catch (error) {
    if (error instanceof Response) return { status: error.status, body: await error.json().catch(() => null) };
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
test("The Razorpay adapter refuses every unconfigured state without touching the network", async () => {
  // AN UNDECLARED ENVIRONMENT. The old test asserted the string "RAZORPAY_KEY_ID_SANDBOX" appeared in
  // the file. What actually matters is that an unset PAWSPACE_PAYMENT_ENV is reported as
  // `unconfigured` in the governed refusal shape — the outbox saga reads `connected:false` to move the
  // row to RETRY, and an exception thrown past it left the row leased, silent and stuck.
  await withFetch(forbidNetwork, async (calls) => {
    const undeclared = await razorpay.createPaymentOrderPaise({}, { bookingId: "B1", paymentId: "P1", amountPaise: 100_000, currency: "INR" });
    assert.equal(undeclared.connected, false);
    assert.equal(undeclared.environment, "unconfigured", "an absent declaration is never guessed as sandbox");
    assert.match(String(undeclared.reason), /PAWSPACE_PAYMENT_ENV/);

    // A DECLARED environment with no credentials: refused, and named as sandbox rather than unconfigured.
    const noKeys = await razorpay.createPaymentOrderPaise({ PAWSPACE_PAYMENT_ENV: "sandbox" }, { bookingId: "B1", paymentId: "P1", amountPaise: 100_000, currency: "INR" });
    assert.equal(noKeys.connected, false);
    assert.equal(noKeys.environment, "sandbox");
    assert.match(String(noKeys.reason), /sandbox API credentials are not configured/);

    // LIVE with full credentials but no approval flag: refused. Credentials are not consent.
    const liveUnapproved = await razorpay.createPaymentOrderPaise({ PAWSPACE_PAYMENT_ENV: "live", ...LIVE_KEYS }, { bookingId: "B1", paymentId: "P1", amountPaise: 100_000, currency: "INR" });
    assert.equal(liveUnapproved.connected, false);
    assert.match(String(liveUnapproved.reason), /must equal "true"/);
    // And the flag is exact: "1" is not "true".
    const liveLoose = await razorpay.createPaymentOrderPaise({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "1", ...LIVE_KEYS }, { bookingId: "B1", paymentId: "P1", amountPaise: 100_000, currency: "INR" });
    assert.equal(liveLoose.connected, false, "a truthy-looking value is not the approval flag");

    // A non-positive amount is refused before any request is built.
    const zero = await razorpay.createPaymentOrderPaise({ PAWSPACE_PAYMENT_ENV: "sandbox", ...SANDBOX_KEYS }, { bookingId: "B1", paymentId: "P1", amountPaise: 0, currency: "INR" });
    assert.equal(zero.connected, false);
    assert.match(String(zero.reason), /positive integer paise amount/);

    // Payment LINKS are locked to sandbox: a live deployment cannot create one at all.
    const liveLink = await razorpay.createSandboxPaymentLink({ PAWSPACE_PAYMENT_ENV: "live", ...LIVE_KEYS }, { bookingId: "B1", paymentId: "P1", referenceId: "R1", customerId: "C1", amount: 100, currency: "INR", expiresAt: NOW + DAY });
    assert.equal(liveLink.connected, false);
    assert.match(String(liveLink.reason), /locked to Razorpay sandbox/);
    const undeclaredLink = await razorpay.createSandboxPaymentLink({}, { bookingId: "B1", paymentId: "P1", referenceId: "R1", customerId: "C1", amount: 100, currency: "INR", expiresAt: NOW + DAY });
    assert.equal(undeclaredLink.environment, "unconfigured", "an undeclared link request is refused in the same shape");

    // NOT ONE of the refusals above made an outbound request. This is the assertion the source-text
    // version could not express at all.
    assert.deepEqual(calls, [], "every refusal must happen before the adapter reaches api.razorpay.com");
  });

  // publicKeyId is a configuration READ, so it throws rather than returning a refusal shape — the two
  // conventions are deliberate and both are asserted.
  assert.match(String((await refusal(Promise.resolve().then(() => razorpay.publicKeyId({}))))?.message), /PAWSPACE_PAYMENT_ENV/);
  assert.equal(razorpay.publicKeyId({ PAWSPACE_PAYMENT_ENV: "sandbox", ...SANDBOX_KEYS }), "rzp_test_stub");
  assert.equal(razorpay.paymentEnvironment({ PAWSPACE_PAYMENT_ENV: "live" }), "live");
});

// ---------------------------------------------------------------------------------------------
test("Rupee amounts reach the gateway as exact paise, and the API base cannot be redirected", async () => {
  const env = { PAWSPACE_PAYMENT_ENV: "sandbox", ...SANDBOX_KEYS };
  const ok = (url) => (String(url).endsWith("/v1/orders")
    ? new Response(JSON.stringify({ id: "order_STUB123", amount: 1 }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404 }));

  // Rs 1,234.56 must arrive as 123456 paise. Floating-point multiplication gives 123455.99999999999,
  // and the truncation of that is a paisa the books never see again.
  await withFetch(ok, async (calls) => {
    const created = await razorpay.createPaymentOrder(env, { bookingId: "B1", paymentId: "PAY-EXACT", amount: 1234.56, currency: "INR" });
    assert.equal(created.connected, true, `the stubbed order must be accepted: ${JSON.stringify(created)}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.razorpay.com/v1/orders", "and it goes to the real Razorpay host");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.amount, 123_456, "1234.56 rupees is exactly 123456 paise");
    assert.equal(sent.currency, "INR");
    assert.equal(sent.notes.pawspace_environment, "sandbox", "and the environment travels with the order");
    // 0.005 of a rupee cannot be expressed in paise, so it is refused rather than silently rounded.
    const tooPrecise = await razorpay.createPaymentOrder(env, { bookingId: "B1", paymentId: "P1", amount: 10.005, currency: "INR" });
    assert.equal(tooPrecise.connected, false);
    assert.match(String(tooPrecise.reason), /at most two decimal places/);
    // An order id that is not an order id is refused rather than stored as one.
    assert.equal(calls.length, 1, "the refused amount is rejected in the rupee conversion, before any request is built");
  });

  // A gateway that answers with something other than an order id is a failure, not a success.
  await withFetch(() => new Response(JSON.stringify({ id: "pay_NOTANORDER" }), { status: 200, headers: { "content-type": "application/json" } }), async () => {
    const wrong = await razorpay.createPaymentOrder(env, { bookingId: "B1", paymentId: "P1", amount: 100, currency: "INR" });
    assert.equal(wrong.connected, false);
    assert.match(String(wrong.reason), /did not return an order id/);
  });
  await withFetch(() => new Response(JSON.stringify({ error: { description: "key not found" } }), { status: 401, headers: { "content-type": "application/json" } }), async () => {
    const rejected = await razorpay.createPaymentOrder(env, { bookingId: "B1", paymentId: "P1", amount: 100, currency: "INR" });
    assert.equal(rejected.connected, false);
    assert.match(String(rejected.reason), /order create failed \(401\): key not found/);
  });

  // THE API BASE OVERRIDE is a contract-test affordance, and it is fenced: it needs the sandbox
  // environment, the explicit contract-test flag, AND a loopback host. Each refusal below is thrown out
  // of providerRequest, so an exfiltration attempt via a config variable never reaches fetch.
  await withFetch(forbidNetwork, async (calls) => {
    // The override refusal is thrown inside providerRequest and reported in the adapter's own governed
    // shape, so it is read from `reason` rather than caught — the same convention as every other
    // refusal here.
    const offHost = await razorpay.createPaymentOrder({ ...env, PAWSPACE_RAZORPAY_API_BASE_URL: "https://attacker.example", PAWSPACE_PAYMENT_CONTRACT_TEST: "true" }, { bookingId: "B1", paymentId: "P1", amount: 100, currency: "INR" });
    assert.equal(offHost.connected, false);
    assert.match(String(offHost.reason), /must use a loopback HTTP\(S\) server/);
    const noFlag = await razorpay.createPaymentOrder({ ...env, PAWSPACE_RAZORPAY_API_BASE_URL: "http://127.0.0.1:9/x" }, { bookingId: "B1", paymentId: "P1", amount: 100, currency: "INR" });
    assert.match(String(noFlag.reason), /allowed only in the sandbox contract-test environment/);
    const liveOverride = await razorpay.createPaymentOrder({ PAWSPACE_PAYMENT_ENV: "live", ...LIVE_KEYS, PAWSPACE_RAZORPAY_API_BASE_URL: "http://127.0.0.1:9/x", PAWSPACE_PAYMENT_CONTRACT_TEST: "true" }, { bookingId: "B1", paymentId: "P1", amount: 100, currency: "INR" });
    assert.match(String(liveOverride.reason), /must equal "true"|not approved/i);
    assert.deepEqual(calls, [], "no redirected request is ever attempted");
  });
});

// ---------------------------------------------------------------------------------------------
test("Verify-first: SANDBOX keeps the submitted status and an undeclared environment does not", async () => {
  /*
   * The LIVE demotion — a client-claimed "captured" recorded as "created" — is executed across five
   * method/mode pairs in tests/live-payment-canonical-route-runtime.test.mjs, which must run on
   * localhost because its offline-cash case needs the development-preview staff actor to hold
   * payments.manage. This test covers the two sides that suite does not: the SANDBOX branch, and an
   * UNDECLARED environment, which used to resolve to "sandbox" and exempt the booking from
   * verification altogether.
   */
  const bookingWorld = async (groupId, env) => {
    const sqlite = freshSqlite();
    const db = makeD1(sqlite);
    globalThis.__VERIFY_FIRST_DB__ = db;
    globalThis.__VERIFY_FIRST_ENV__ = env;
    // The route requires scheduling.book AND ownership of the customer, so on a real hostname it needs
    // a real identity — `admin` holds scheduling.book and customers.manage and, deliberately, NOT
    // payments.manage, so it cannot server-authorize an offline collection.
    const { ensureSecurityTables } = await import("../lib/server-auth.ts");
    await ensureSecurityTables(db);
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)")
      .run("U-VF-BOOK", BOOKING_STAFF, "Booking Staff", NOW, NOW);
    sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)");
    sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
    sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(groupId, "balanced", "[]", "PRV-VF-1", "assigned", "verify-first-test", "seeded", NOW);
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`RES-${groupId}`, groupId, "PRV-VF-1", "grooming", "blr", "koramangala", "CUS-VF-1", "[]", "2026-11-12T09:00:00.000Z", "2026-11-12T11:00:00.000Z", 1, 1, null, "reserved", "{}", NOW);
    return { sqlite, db };
  };

  const submit = async (index, env, status) => {
    const groupId = `SG-VF-${index}`;
    const { sqlite } = await bookingWorld(groupId, env);
    const response = await bookingsRoute.POST(new Request(`${ORIGIN}/api/canonical-bookings`, {
      method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": BOOKING_STAFF },
      body: JSON.stringify({
        idempotencyKey: `idem-vf-${index}`, scheduleGroupId: groupId,
        customer: { id: "CUS-VF-1", name: "Verify payer", primaryPhone: "+919000000012" },
        pets: [{ sourceId: "PET-VF-1", name: "Rex", species: "dog", breed: "Labrador" }],
        cityId: "blr", zoneId: "koramangala", serviceCode: "grooming",
        packageCode: "dog-bath", packageName: "Essential Bath",
        scheduledStart: "2026-11-12T09:00:00.000Z", scheduledEnd: "2026-11-12T11:00:00.000Z",
        provider: { id: "PRV-VF-1", name: "Verify Groomer", model: "full_time" },
        totalAmount: 1349, amountDueNow: 1349,
        payment: { method: "upi", mode: "prepaid", status, detail: "verify-first boundary" },
        pricing: { discount: 0 },
      }),
    }));
    const body = await response.json().catch(() => null);
    // The route creates booking_payments itself; when it refuses before that point the table may not
    // exist at all, which is the same statement as "no payment was recorded".
    let row = null;
    try { row = sqlite.prepare("SELECT status,method,mode FROM booking_payments LIMIT 1").get() ?? null; } catch { row = null; }
    return { status: response.status, body, row };
  };

  // SANDBOX: an explicitly declared sandbox is a money-test environment, so the submitted status is
  // kept as submitted. This is the non-vacuity control for the demotion below — without it, "the
  // status was demoted" could just mean "the route always writes created".
  const sandbox = await submit(1, { PAWSPACE_PAYMENT_ENV: "sandbox" }, "captured");
  assert.equal(sandbox.status, 201, `the sandbox booking must be accepted: ${JSON.stringify(sandbox.body)}`);
  assert.equal(String(sandbox.row.status), "captured", "an explicit sandbox keeps the submitted status");

  // UNDECLARED: no PAWSPACE_PAYMENT_ENV at all. The sandbox exemption must NOT apply — the booking is
  // either refused or recorded unpaid, and in no case may a client-claimed capture stand. An absent
  // variable resolving to "sandbox" was the defect; either outcome closes it, and asserting the
  // disjunction rather than one branch is deliberate: this test must not pin an implementation choice
  // it does not own.
  const undeclared = await submit(2, {}, "captured");
  if (undeclared.status === 201) {
    assert.equal(String(undeclared.row.status), "created",
      `an undeclared environment must not honour a client-claimed capture: ${JSON.stringify(undeclared.body)}`);
  } else {
    assert.ok(undeclared.status >= 400, `an undeclared environment must refuse rather than exempt: ${JSON.stringify(undeclared)}`);
    assert.equal(undeclared.row, null, "and must record no payment at all");
  }

  // A status that was never a capture claim is untouched in either environment.
  assert.equal(String((await submit(3, { PAWSPACE_PAYMENT_ENV: "sandbox" }, "failed")).row.status), "failed");
});

// ---------------------------------------------------------------------------------------------
test("Reconciliation matches by gateway identity, never by customer phone", async () => {
  const { sqlite, db } = reconWorld();
  // TWO bookings, ONE phone number — the same customer books twice, which is the ordinary case that
  // makes phone matching dangerous. Only the second is linked to the gateway order.
  const firstPayment = seedBooking(sqlite, { id: "bkg_vf_first", total: 2000, customer: "cus_shared_a", phone: "+91-9000000099" });
  const secondPayment = seedBooking(sqlite, { id: "bkg_vf_second", total: 2000, customer: "cus_shared_b", phone: "+91-9000000099" });
  await engine.linkGatewayOrder(db, { bookingId: "bkg_vf_second", paymentId: secondPayment, provider: "razorpay", environment: "sandbox", gatewayOrderId: "order_VF_SECOND", expectedAmount: 2000, currency: "INR" });

  // An event carrying ONLY the order id must land on the linked booking.
  const byOrder = await engine.processGatewayEvent(db, signedEvent({ gatewayOrderId: "order_VF_SECOND" }));
  assert.equal(byOrder.status, "processed", `an order-linked capture must reconcile: ${JSON.stringify(byOrder)}`);
  const secondRecord = await db.prepare("SELECT booking_id,captured_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(secondPayment).first();
  assert.equal(String(secondRecord.booking_id), "bkg_vf_second");
  assert.equal(Number(secondRecord.captured_amount), 2000);
  // And the other booking on the same phone collected nothing. This is the assertion
  // `assert.doesNotMatch(recon, /phone/i)` was standing in for.
  assert.equal(await db.prepare("SELECT * FROM payment_reconciliation_records WHERE payment_id=?").bind(firstPayment).first(), null,
    "a booking sharing the customer's phone must not be credited with someone else's payment");
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(firstPayment).status), "created");

  // An event carrying NEITHER a booking id nor a known gateway reference is unplaceable — it is raised,
  // not attached to the nearest booking by any other attribute.
  const stranger = await engine.processGatewayEvent(db, signedEvent({ gatewayOrderId: "order_VF_UNKNOWN", gatewayPaymentId: "pay_VF_UNKNOWN" }));
  assert.equal(stranger.reason, "unmatched_gateway_event");
  assert.deepEqual((await exceptions(db)).map((row) => row.exception_type), ["unmatched_gateway_event"]);

  // A capture is only ever applied on a signature-verified event.
  const unsigned = await refusal(engine.processGatewayEvent(db, signedEvent({ gatewayOrderId: "order_VF_SECOND", signatureVerified: false })));
  assert.match(String(unsigned?.message), /signature is not verified/);
});

// ---------------------------------------------------------------------------------------------
test("Finance can attach an unmatched payment to a booking, but only a matching one", async () => {
  const { sqlite, db } = reconWorld();
  seedBooking(sqlite, { id: "bkg_vf_target", total: 2000 });
  seedBooking(sqlite, { id: "bkg_vf_expensive", total: 9000 });
  seedBooking(sqlite, { id: "bkg_vf_usd", total: 2000, currency: "USD" });

  // A Rs 2,000 capture the system cannot place raises an open exception.
  const orphan = signedEvent({ gatewayOrderId: "order_VF_ORPHAN", gatewayPaymentId: "pay_VF_ORPHAN" });
  await engine.processGatewayEvent(db, orphan);
  const [raised] = await exceptions(db);
  assert.equal(String(raised.exception_type), "unmatched_gateway_event");
  assert.equal(String(raised.status), "open");
  // listPaymentExceptions is the finance console's own reader, executed rather than named.
  const open = await engine.listPaymentExceptions(db, {});
  assert.deepEqual(open.map((row) => [row.type, row.status]), [["unmatched_gateway_event", "open"]]);
  assert.deepEqual(await engine.listPaymentExceptions(db, { status: "resolved" }), [], "and it really filters by status");

  const exceptionId = String(raised.id);
  // THE GUARDS, each executed. A note is mandatory and must say something.
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId, action: "attach_to_booking", bookingId: "bkg_vf_target", actorId: FINANCE, note: "ok" })))?.message), /resolution note is required/);
  // The action vocabulary is closed.
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId, action: "just_capture_it", bookingId: "bkg_vf_target", actorId: FINANCE, note: "attaching this payment" })))?.message), /Unknown resolution action/);
  // A target booking is required.
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId, action: "attach_to_booking", actorId: FINANCE, note: "attaching this payment" })))?.message), /target booking is required/);
  // The AMOUNT must match: Rs 2,000 cannot be attached to a Rs 9,000 booking, which would report the
  // booking as paid in full.
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId, action: "attach_to_booking", bookingId: "bkg_vf_expensive", actorId: FINANCE, note: "attaching this payment" })))?.message), /Amount mismatch: booking expects 9000, payment is 2000/);
  // And so must the CURRENCY.
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId, action: "attach_to_booking", bookingId: "bkg_vf_usd", actorId: FINANCE, note: "attaching this payment" })))?.message), /Currency mismatch/);
  // Nothing above moved any money.
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get("PAY-bkg_vf_expensive").status), "created");
  assert.equal(String((await exceptions(db))[0].status), "open", "and the exception is still open");

  // THE MATCHING ATTACH succeeds and captures the payment.
  const attached = await engine.resolvePaymentException(db, { exceptionId, action: "attach_to_booking", bookingId: "bkg_vf_target", actorId: FINANCE, note: "matched by order id in the gateway console" });
  assert.equal(attached.status, "resolved");
  assert.equal(attached.bookingId, "bkg_vf_target");
  assert.equal(attached.amount, 2000);
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get("PAY-bkg_vf_target").status), "captured");
  const record = await db.prepare("SELECT captured_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id=?").bind("PAY-bkg_vf_target").first();
  assert.deepEqual({ captured: Number(record.captured_amount), status: String(record.reconciliation_status) }, { captured: 2000, status: "matched" });

  // A resolved exception cannot be resolved again — otherwise one gateway payment could be attached to
  // several bookings in turn.
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId, action: "attach_to_booking", bookingId: "bkg_vf_target", actorId: FINANCE, note: "attaching this payment again" })))?.message), /already been resolved/);

  // ONLY an unmatched payment may be attached. An exception of a different kind — here a short capture
  // against a booking the system already matched — must not be resolvable by attaching it somewhere
  // else, which would report the shortfall as paid in full.
  seedBooking(sqlite, { id: "bkg_vf_short", total: 2000 });
  await engine.linkGatewayOrder(db, { bookingId: "bkg_vf_short", paymentId: "PAY-bkg_vf_short", provider: "razorpay", environment: "sandbox", gatewayOrderId: "order_VF_SHORT", expectedAmount: 2000, currency: "INR" });
  const short = await engine.processGatewayEvent(db, signedEvent({ gatewayOrderId: "order_VF_SHORT", amountSubunits: 150_000 }));
  assert.equal(short.reason, "capture_amount_mismatch", `the short capture must raise a mismatch: ${JSON.stringify(short)}`);
  const mismatch = (await exceptions(db)).find((row) => String(row.exception_type) === "capture_amount_mismatch");
  assert.match(String((await refusal(engine.resolvePaymentException(db, { exceptionId: String(mismatch.id), action: "attach_to_booking", bookingId: "bkg_vf_target", actorId: FINANCE, note: "trying to attach a short capture" })))?.message),
    /Only an unmatched gateway payment can be attached to a booking/);
  assert.equal(String((await exceptions(db)).find((row) => String(row.exception_type) === "capture_amount_mismatch").status), "open",
    "and it stays open for Finance to resolve properly");

  // The non-attach actions change status without touching money, and `investigate` deliberately records
  // no resolver: it is not a resolution.
  const second = signedEvent({ gatewayOrderId: "order_VF_ORPHAN_2", gatewayPaymentId: "pay_VF_ORPHAN_2" });
  await engine.processGatewayEvent(db, second);
  const pending = (await exceptions(db)).find((row) => String(row.status) === "open");
  const investigating = await engine.resolvePaymentException(db, { exceptionId: String(pending.id), action: "investigate", actorId: FINANCE, note: "asked the gateway for the payer" });
  assert.equal(investigating.status, "investigating");
  const investigated = await db.prepare("SELECT status,resolved_by,resolved_at FROM payment_reconciliation_exceptions WHERE id=?").bind(String(pending.id)).first();
  assert.equal(String(investigated.status), "investigating");
  assert.equal(investigated.resolved_by, null, "investigating is not resolving, so no resolver is recorded");
  // Which means it can still be resolved afterwards.
  const dismissed = await engine.resolvePaymentException(db, { exceptionId: String(pending.id), action: "dismiss", actorId: FINANCE, note: "duplicate of the attached payment" });
  assert.equal(dismissed.status, "dismissed");
});

// ---------------------------------------------------------------------------------------------
test("The reconciliation console reads with finance.view and resolves with finance.manage", async () => {
  const { sqlite, db } = reconWorld();
  seedBooking(sqlite, { id: "bkg_vf_route", total: 2000 });
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  staff.run("U-VF-FIN", FINANCE, "Finance Verify", "finance", now, now);
  // `manager` holds no finance permission, which is what makes both gates below real gates rather than
  // "any signed-in staff member".
  staff.run("U-VF-MGR", MANAGER, "Manager Verify", "manager", now, now);
  await engine.processGatewayEvent(db, signedEvent({ gatewayOrderId: "order_VF_ROUTE", gatewayPaymentId: "pay_VF_ROUTE" }));
  const [raised] = await exceptions(db);

  const get = async (actorEmail) => {
    const headers = actorEmail ? { "oai-authenticated-user-email": actorEmail } : {};
    const response = await reconRoute.GET(new Request(`${ORIGIN}/api/payment-reconciliation?status=open`, { headers }));
    return { status: response.status, body: await response.json().catch(() => null), cacheControl: response.headers.get("cache-control") };
  };
  const post = async (actorEmail, body, extraHeaders = {}) => {
    const headers = { "content-type": "application/json", ...extraHeaders, ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
    const response = await reconRoute.POST(new Request(`${ORIGIN}/api/payment-reconciliation`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // READ: finance.view is allowed, no identity and the wrong role are not.
  const authorised = await get(FINANCE);
  assert.equal(authorised.status, 200, `finance.view must read the exception queue: ${JSON.stringify(authorised)}`);
  assert.equal(authorised.body?.data?.exceptions?.length, 1, "and sees the real queue");
  assert.equal(authorised.cacheControl, "no-store");
  assert.equal((await get(MANAGER)).status, 403, "a role without finance.view is refused");
  assert.ok([401, 403].includes((await get("")).status), "and so is an anonymous caller");

  // WRITE: finance.manage is required, and a refused write must not resolve the exception.
  const resolveBody = { exceptionId: String(raised.id), action: "dismiss", note: "duplicate gateway notification" };
  assert.equal((await post(MANAGER, resolveBody)).status, 403, "a role without finance.manage cannot resolve");
  assert.ok([401, 403].includes((await post("", resolveBody)).status));
  // A cross-origin write is blocked before any of this.
  assert.equal((await post(FINANCE, resolveBody, { origin: "https://evil.example" })).status, 403, "cross-origin reconciliation writes are blocked");
  assert.equal(String((await exceptions(db))[0].status), "open", "none of the refusals resolved anything");
  // An incomplete body is a 400, not a partial resolution.
  assert.equal((await post(FINANCE, { exceptionId: String(raised.id), action: "dismiss" })).status, 400);

  const resolved = await post(FINANCE, resolveBody);
  assert.equal(resolved.status, 200, `finance.manage must be allowed through: ${JSON.stringify(resolved)}`);
  assert.equal(resolved.body?.data?.status, "dismissed");
  assert.equal(String((await exceptions(db))[0].status), "dismissed");
  // The actor recorded is the AUTHENTICATED one, never a body field.
  const audited = await db.prepare("SELECT resolved_by FROM payment_reconciliation_exceptions WHERE id=?").bind(String(raised.id)).first();
  assert.equal(String(audited.resolved_by), FINANCE);
});

// ---------------------------------------------------------------------------------------------
test("A customer payment order never records a capture, and never opens another customer's booking", async () => {
  const { sqlite, db } = reconWorld({ PAWSPACE_PAYMENT_ENV: "sandbox" });
  const paymentId = seedBooking(sqlite, { id: "bkg_vf_intent", total: 2000, customer: "cus_vf_owner" });
  const intent = await import("../lib/payment-order-intent.ts");

  // CROSS-CUSTOMER: a different customer id is refused 403 before any gateway work happens.
  await withFetch(forbidNetwork, async (calls) => {
    const cross = await refusal(intent.createBookingPaymentOrder(db, { PAWSPACE_PAYMENT_ENV: "sandbox" }, { bookingId: "bkg_vf_intent", customerId: "cus_vf_intruder", actorId: "cus_vf_intruder" }));
    assert.equal(cross?.status, 403, `paying for someone else's booking must be refused: ${JSON.stringify(cross)}`);
    assert.match(String(cross?.body?.error), /only pay for your own booking/);
    assert.deepEqual(calls, [], "and no order is opened at the gateway");
  });

  // NO CREDENTIALS: the intent fails closed with connected:false and a reason. The payment must still
  // be uncollected — "we could not reach the gateway" is never "the customer paid".
  await withFetch(forbidNetwork, async () => {
    const unconfigured = await intent.createBookingPaymentOrder(db, { PAWSPACE_PAYMENT_ENV: "sandbox" }, { bookingId: "bkg_vf_intent", customerId: "cus_vf_owner", actorId: "cus_vf_owner" });
    assert.equal(unconfigured.connected, false, `an unconfigured gateway must fail closed: ${JSON.stringify(unconfigured)}`);
    assert.match(String(unconfigured.reason), /credentials are not configured|not connected/);
  });
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status), "created",
    "a failed order attempt leaves the payment uncollected");
  assert.equal(await db.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first().then((row) => row && Number(row.captured_amount)).catch(() => null) || 0, 0,
    "and collects nothing");

  // WITH a gateway that answers: the order is opened and the booking is AWAITING payment, not paid.
  const orderStub = (url) => (String(url).endsWith("/v1/orders")
    ? new Response(JSON.stringify({ id: "order_VF_INTENT", amount: 200_000 }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404 }));
  await withFetch(orderStub, async () => {
    const opened = await intent.createBookingPaymentOrder(db, { PAWSPACE_PAYMENT_ENV: "sandbox", ...SANDBOX_KEYS }, { bookingId: "bkg_vf_intent", customerId: "cus_vf_owner", actorId: "cus_vf_owner" });
    assert.equal(opened.connected, true, `the order must open: ${JSON.stringify(opened)}`);
    assert.equal(opened.status, "awaiting_payment", "opening an order is never a capture");
    assert.equal(opened.orderId, "order_VF_INTENT");
    assert.equal(opened.amountPaise, 200_000, "and the amount is exact paise");
  });
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status), "created",
    "the canonical payment is still uncollected after the order is opened");
  const linked = await db.prepare("SELECT gateway_status,captured_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first();
  assert.equal(String(linked.gateway_status), "order_linked", "the reconciliation record says linked, not captured");
  assert.equal(Number(linked.captured_amount), 0);

  // Only a signed gateway event moves it to captured — the same order id, now arriving as a webhook.
  const captured = await engine.processGatewayEvent(db, signedEvent({ gatewayOrderId: "order_VF_INTENT" }));
  assert.equal(captured.status, "processed");
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status), "captured",
    "verify-first: the capture comes from the verified event, never from the checkout call");
});
