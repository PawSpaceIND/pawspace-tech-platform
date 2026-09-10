/**
 * Correlated checkout -> authenticated webhook -> customer, partner, Operations and finance.
 * Production handlers + both API authorization gates + transactional SQLite.
 * ONLY the Razorpay HTTP response/delivery, roster, GPS and media inspection are fixtures.
 * No browser success callback or /grooming-payment-sandbox shortcut is used; no external money moves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";

const ORIGIN = "https://checkout-cross-app.pawspace.test";
const API_SECRET = "synthetic-cross-app-api-not-a-credential";
const HOOK_SECRET = "synthetic-cross-app-webhook-not-a-credential";
const ORDER_ID = "order_crossAppFixture", PAYMENT_ID = "pay_crossAppFixture";
const sign = (raw, secret = HOOK_SECRET) => createHmac("sha256", secret).update(raw).digest("hex");

async function setup(t) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  const { db, sqlite } = ctx;
  enterWorkersDbScope(db);
  // D1 batch returns SELECT results as well as committing writes. The legacy journey helper
  // only needed writes; adapt just this isolated world so finance GET executes its real reads.
  const originalPrepare = db.prepare;
  function wrap(statement) {
    const bind = statement.bind;
    statement.bind = (...values) => wrap(bind(...values));
    if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(statement._sql)) {
      statement.run = async () => ({ ...(await statement.all()), success: true, meta: { changes: 0 } });
    }
    return statement;
  }
  db.prepare = sql => wrap(originalPrepare(sql));
  assert.equal((await db.batch([db.prepare("SELECT 42 AS sanity")]))[0].results[0].sanity, 42);
  const runtime = globalThis.__GROOM_GOLDEN_ENV__;
  Object.assign(runtime, { NODE_ENV: "test", APP_ENV: "staging", FORBID_PRODUCTION: "true",
    PAWSPACE_DEPLOYMENT_ENV: "e2e", PAWSPACE_LOCAL_PREVIEW: "off",
    // Simulated trusted staff-dispatch boundary. Customer/provider requests use only issued cookies.
    PAWSPACE_WORKSPACE_IDENTITY_TRUST: "openai-dispatch",
    RAZORPAY_KEY_ID_SANDBOX: "rzp_test_crossAppFixture", RAZORPAY_KEY_SECRET_SANDBOX: API_SECRET,
    RAZORPAY_WEBHOOK_SECRET_SANDBOX: HOOK_SECRET });
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { requestForAuthorization } = await import("../lib/trusted-workspace-identity.ts");
  const calls = [];
  async function request(path, { method = "GET", body, cookie = "", staff = false, headers = {} } = {}) {
    assert.notEqual(path.split("?")[0], "/api/grooming-payment-sandbox", "no simulated-payment shortcut");
    const req = new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}),
      ...(staff ? { "oai-authenticated-user-email": "closure-admin@pawspace.test" } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    const inspection = requestForAuthorization(req, runtime);
    const session = await authorizePlatformSessionRequest(inspection, db);
    const access = session ?? await authorizeApiRequest(inspection, { ...runtime, DB: db });
    let response;
    if (access instanceof Response) response = access;
    else {
      assert.equal(access.actor.preview, false, "no preview superuser may satisfy a cross-app step");
      const route = await import(`../app${new URL(req.url).pathname}/route.ts`);
      response = await route[method](req);
    }
    const result = { status: response.status, body: await response.json() };
    calls.push({ path: path.split("?")[0], method, status: result.status, action: body && typeof body === "object" ? body.action : undefined });
    return result;
  }
  const customerId = "CUS-CHECKOUT-CROSS", petId = "PET-CHECKOUT-CROSS", groupId = "GROUP-CHECKOUT-CROSS";
  await seedOwnedPet(db, customerId, petId, "Milo");
  const customerCookie = await sessionCookie(db, "customer", customerId, `customer:${customerId}`);
  const start = new Date(Date.now() + 5 * 86400000); start.setUTCHours(4, 30, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600000);
  const schedule = await request("/api/uat-scheduling", { method: "POST", cookie: customerCookie, body: {
    clientRequestId: groupId, customerId, petIds: [petId], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east",
    serviceAddress: "Synthetic cross-app service address", servicePincode: "560038",
    scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), preferredProviderId: "groom_arun" } });
  assert.equal(schedule.status, 200, JSON.stringify(schedule));
  const provider = schedule.body.data.provider;
  const booked = await request("/api/canonical-bookings", { method: "POST", cookie: customerCookie, body: {
    idempotencyKey: groupId, scheduleGroupId: groupId,
    customer: { id: customerId, name: "Synthetic Cross Customer", primaryPhone: "+919800009991" },
    pets: [{ sourceId: petId, name: "Milo", species: "dog", breed: "Indie", vaccinationStatus: "vaccinated" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "client-name-not-authority",
    scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), provider, totalAmount: 1899, amountDueNow: 1899,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "Synthetic cross-app verification" }, pricing: { discount: 0 } } });
  assert.equal(booked.status, 201, JSON.stringify(booked));
  const bookingId = booked.body.data.bookingId;
  const canonical = sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(bookingId);
  assert.equal(canonical.package_name, "Bath & Basic");
  const amount = Number(canonical.total_amount), amountPaise = Math.round(amount * 100);
  const providerCookie = await sessionCookie(db, "provider", provider.id, `provider:${provider.id}`);
  let orderCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.razorpay.com/v1/orders", "all unexpected outbound calls are blocked");
    assert.equal(init.method, "POST");
    const data = JSON.parse(init.body); assert.equal(data.amount, amountPaise); assert.equal(data.currency, "INR");
    orderCalls++;
    return Response.json({ id: ORDER_ID, amount: amountPaise, currency: "INR", status: "created" });
  });
  const customer = body => request("/api/customer-checkout", { method: "POST", cookie: customerCookie, body: { bookingId, ...body } });
  const order = await customer({ action: "start", amount: 1, customerId: "not-the-owner" });
  assert.equal(order.status, 201, JSON.stringify(order)); assert.equal(order.body.data.amountPaise, amountPaise);
  assert.equal((await customer({ action: "start" })).body.data.orderId, ORDER_ID); assert.equal(orderCalls, 1);
  const raw = (event, overrides = {}) => JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: {
    id: PAYMENT_ID, order_id: ORDER_ID, amount: amountPaise, currency: "INR", status: event === "payment.authorized" ? "authorized" : "captured",
    notes: { booking_id: bookingId }, ...overrides } } } });
  const deliver = (event, eventId, body = raw(event), secret = HOOK_SECRET) => request("/api/razorpay-webhook", { method: "POST", body,
    headers: { "x-razorpay-event-id": eventId, "x-razorpay-signature": sign(body, secret) } });
  const timeline = () => sqlite.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? AND event_type='payment_captured'").all(bookingId);
  const billing = () => request("/api/customer-billing", { cookie: customerCookie });
  const partner = () => request(`/api/partner-grooming-jobs?providerId=${provider.id}`, { cookie: providerCookie });
  const ops = () => request("/api/booking-command-center", { staff: true });
  const finance = () => request("/api/grooming-finance", { staff: true });
  return { ...ctx, runtime, request, customer, deliver, raw, timeline, billing, partner, ops, finance,
    bookingId, customerId, provider, customerCookie, providerCookie, amount, amountPaise, calls, orderCalls: () => orderCalls };
}

async function verifySurfaces(w) {
  const billing = await w.billing(); assert.equal(billing.status, 200, JSON.stringify(billing));
  assert.equal(billing.body.data.payments.find(p => p.booking_id === w.bookingId).status, "captured");
  const partner = await w.partner(); assert.equal(partner.status, 200, JSON.stringify(partner));
  const job = partner.body.jobs.find(item => item.bookingId === w.bookingId); assert.equal(job.payment.status, "captured");
  const ops = await w.ops(); assert.equal(ops.status, 200, JSON.stringify(ops));
  const operation = ops.body.bookings.find(item => item.id === w.bookingId); assert.equal(operation.payment_status, "captured");
  const finance = await w.finance(); assert.equal(finance.status, 200, JSON.stringify(finance));
  assert.equal(finance.body.summary.collected, w.amount); assert.equal(finance.body.summary.receivable, 0);
  assert.equal(finance.body.summary.reconciled, 1); assert.equal(finance.body.summary.exceptions, 0);
  assert.doesNotMatch(JSON.stringify(job.events), /gatewayPaymentId|gatewayOrderId|synthetic-cross-app-|9800009991|closure-admin@/,
    "timeline projection must not expose gateway references, credentials or raw contact details to partners");
  return { job, operation, finance: finance.body };
}

for (const captureType of ["payment.captured", "order.paid"]) {
  test(`${captureType}: customer checkout without browser callback records the same paid timeline in partner and Operations`, async t => {
    const w = await setup(t);
    assert.equal(w.timeline().length, 0);
    assert.equal((await w.deliver("payment.authorized", "evt_cross_authorized")).status, 200);
    const captured = await w.deliver(captureType, "evt_cross_captured");
    assert.equal(captured.status, 200, JSON.stringify(captured));
    const surfaces = await verifySurfaces(w);
    const settled = await w.customer({ action: "start" });
    assert.equal(settled.status, 200); assert.equal(settled.body.data.status, "nothing_due");
    assert.equal((await w.deliver(captureType, "evt_cross_captured")).status, 200);
    const alias = captureType === "payment.captured" ? "order.paid" : "payment.captured";
    assert.equal((await w.deliver(alias, "evt_cross_alias")).status, 200);
    assert.equal(w.orderCalls(), 1);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND status='POSTED'").get().n, 1);
    t.diagnostic(JSON.stringify({ captureType, bookingId: w.bookingId, billing: "captured", partner: surfaces.job.payment.status,
      operations: surfaces.operation.payment_status, financeCollected: surfaces.finance.summary.collected, paymentTimelineEvents: w.timeline().length,
      browserConfirmationCalls: w.calls.filter(c => c.path === "/api/customer-checkout" && c.action === "confirm").length, boundary: "synthetic provider HTTP + signed delivery" }));
    assert.equal(w.timeline().length, 1, "a captured checkout must produce exactly one canonical payment_captured timeline event");
    assert.equal(surfaces.job.events.filter(e => e.eventType === "payment_captured").length, 1, "partner must receive the same verified payment event");
    assert.equal(surfaces.operation.lifecycle.filter(e => e.event_type === "payment_captured").length, 1, "Operations timeline must not silently omit checkout capture");
  });
}

async function authorizeCapture(w) {
  assert.equal((await w.deliver("payment.authorized", "evt_cross_authorized")).status, 200);
  const captured = await w.deliver("payment.captured", "evt_cross_captured");
  assert.equal(captured.status, 200, JSON.stringify(captured));
  return captured;
}

function captureCounts(w) {
  return {
    timelines: w.timeline().length,
    journals: w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND status='POSTED'").get().n,
    collections: w.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='online_payment_captured'").get().n,
    captured: w.sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records").get().captured_amount,
    orders: w.orderCalls(),
  };
}

test("delayed authorization and invalid signatures cannot publish a paid partner/Operations timeline early", async t => {
  const w = await setup(t);
  const early = await w.deliver("payment.captured", "evt_cross_captured");
  assert.equal(early.status, 503); assert.equal(w.timeline().length, 0);
  const bad = await w.deliver("payment.captured", "evt_cross_bad", w.raw("payment.captured"), "wrong-fixture-signature");
  assert.equal(bad.status, 401); assert.equal(w.timeline().length, 0);
  const unpaid = (await w.partner()).body.jobs.find(j => j.bookingId === w.bookingId);
  assert.equal(unpaid.payment.status, "created");
  assert.equal(unpaid.events.filter(e => e.eventType === "payment_captured").length, 0);
  await authorizeCapture(w);
  await verifySurfaces(w);
  assert.equal(w.timeline().length, 1);
});

test("timeline insertion failure rolls back capture, reconciliation and journal; signed replay recovers once", async t => {
  const w = await setup(t);
  assert.equal((await w.deliver("payment.authorized", "evt_cross_authorized")).status, 200);
  w.sqlite.exec(`CREATE TRIGGER reject_capture_timeline BEFORE INSERT ON booking_lifecycle_events
    WHEN NEW.event_type='payment_captured' BEGIN SELECT RAISE(ABORT,'injected_capture_timeline_failure'); END`);
  const failed = await w.deliver("payment.captured", "evt_cross_captured");
  assert.ok(failed.status >= 400, JSON.stringify(failed));
  assert.equal(w.timeline().length, 0);
  assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments").get().status, "created");
  assert.equal(w.sqlite.prepare("SELECT state FROM payment_intents").get().state, "AUTHORIZED");
  assert.equal(w.sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records").get().captured_amount, 0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE status='POSTED'").get().n, 0);
  assert.equal(w.sqlite.prepare("SELECT processing_status FROM gateway_webhook_events WHERE event_id='evt_cross_captured'").get().processing_status, "FAILED");
  w.sqlite.exec("DROP TRIGGER reject_capture_timeline");
  assert.equal((await w.deliver("payment.captured", "evt_cross_captured")).status, 200);
  await verifySurfaces(w);
  assert.deepEqual(captureCounts(w), { timelines: 1, journals: 1, collections: 1, captured: w.amount, orders: 1 });
});

test("same-event replay repairs a historical missing timeline without reposting money, and recovery itself is retryable", async t => {
  const w = await setup(t);
  await authorizeCapture(w);
  const originalTime = w.timeline()[0].occurred_at;
  const before = captureCounts(w);
  // Reproduce the pre-repair state: durable capture/outbox succeeded but no lifecycle event existed.
  w.sqlite.exec("DELETE FROM booking_lifecycle_events WHERE event_type='payment_captured'");
  w.sqlite.exec(`CREATE TRIGGER reject_capture_repair BEFORE INSERT ON booking_lifecycle_events
    WHEN NEW.event_type='payment_captured' BEGIN SELECT RAISE(ABORT,'injected_timeline_repair_failure'); END`);
  const blocked = await w.deliver("payment.captured", "evt_cross_captured");
  assert.equal(blocked.status, 503, "an unfinished history repair must not claim recovered success");
  assert.equal(blocked.body.captureEffectsRetry, true);
  assert.deepEqual(captureCounts(w), { ...before, timelines: 0 });
  w.sqlite.exec("DROP TRIGGER reject_capture_repair");
  const repaired = await w.deliver("payment.captured", "evt_cross_captured");
  assert.equal(repaired.status, 200, JSON.stringify(repaired));
  assert.equal(repaired.body.duplicate, true);
  assert.equal(repaired.body.captureEffectsRecovered, true);
  assert.deepEqual(captureCounts(w), before);
  assert.equal(w.timeline()[0].occurred_at, originalTime, "history records original processing time, not replay time");
  await verifySurfaces(w);
});

test("historical legacy payment timeline is retained rather than duplicated by signed replay", async t => {
  const w = await setup(t); await authorizeCapture(w);
  w.sqlite.prepare("UPDATE booking_lifecycle_events SET id='legacy-payment-timeline' WHERE event_type='payment_captured'").run();
  const before = w.timeline();
  assert.equal((await w.deliver("payment.captured", "evt_cross_captured")).status, 200);
  assert.equal((await w.deliver("order.paid", "evt_cross_alias")).status, 200);
  assert.deepEqual(w.timeline(), before);
  assert.deepEqual(captureCounts(w), { timelines: 1, journals: 1, collections: 1, captured: w.amount, orders: 1 });
});

test("paid checkout retains customer/provider ownership and staff-only finance boundaries", async t => {
  const w = await setup(t); await authorizeCapture(w);
  const stranger = await sessionCookie(w.db, "provider", "groom_kiran", "provider:groom_kiran");
  const wrongCustomer = await sessionCookie(w.db, "customer", "CUS-OTHER", "customer:CUS-OTHER");
  for (const [path, options, expected] of [
    [`/api/partner-grooming-jobs?providerId=${w.provider.id}`, { cookie: stranger }, 403],
    ["/api/booking-command-center", { cookie: w.customerCookie }, 403],
    ["/api/grooming-finance", { cookie: w.providerCookie }, 403],
    ["/api/customer-checkout", { method: "POST", cookie: wrongCustomer, body: { action: "start", bookingId: w.bookingId } }, 404],
    ["/api/customer-checkout", { method: "POST", cookie: w.providerCookie, body: { action: "start", bookingId: w.bookingId } }, 403],
    ["/api/booking-command-center", {}, 401],
  ]) assert.equal((await w.request(path, options)).status, expected, path);
  assert.deepEqual(captureCounts(w), { timelines: 1, journals: 1, collections: 1, captured: w.amount, orders: 1 });
});

test("without a browser callback: paid grooming reaches provider completion, customer invoice and reconciled Operations/finance", async t => {
  const w = await setup(t); await authorizeCapture(w);
  const initial = await verifySurfaces(w);
  assert.equal(initial.job.events.filter(e => e.eventType === "payment_captured").length, 1);
  const location = await w.request("/api/grooming-service-location", { method: "POST", cookie: w.customerCookie, body: {
    bookingId: w.bookingId, customerId: w.customerId, address: "Synthetic cross-app service address", pincode: "560038", latitude: 12.9716, longitude: 77.5946 } });
  assert.equal(location.status, 201, JSON.stringify(location));
  const lifecycle = (action, extra = {}) => w.request("/api/grooming-lifecycle", { method: "POST", cookie: w.providerCookie, body: { bookingId: w.bookingId, action, ...extra } });
  for (const action of ["accept", "on_the_way", "arrived", "start_service"]) {
    if (action === "arrived") {
      const telemetry = await w.request("/api/grooming-route", { method: "POST", cookie: w.providerCookie, body: {
        bookingId: w.bookingId, providerId: w.provider.id, latitude: location.body.data.latitude, longitude: location.body.data.longitude,
        accuracyMeters: 10, capturedAt: Date.now(), idempotencyKey: "cross-app-fixture-gps" } });
      assert.equal(telemetry.status, 201, JSON.stringify(telemetry));
    }
    const step = await lifecycle(action); assert.equal(step.status, 200, `${action}: ${JSON.stringify(step)}`);
  }
  assert.equal((await lifecycle("complete")).status, 409, "proof-free completion must be refused");
  const media = [];
  for (const [purpose, letter] of [["before_service", "a"], ["after_service", "b"]]) {
    const sha256 = letter.repeat(64);
    const prepared = await w.request("/api/service-media", { method: "POST", cookie: w.providerCookie, body: {
      bookingId: w.bookingId, purpose, mimeType: "image/jpeg", sizeBytes: 128, sha256, fileName: `${purpose}.jpg` } });
    assert.equal(prepared.status, 201, JSON.stringify(prepared));
    const { id, upload, ref } = prepared.body.data;
    const uploaded = await w.request("/api/service-media", { method: "PATCH", staff: true, body: {
      id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey,
      observedSizeBytes: 128, observedSha256: sha256, observedMimeType: "image/jpeg" } });
    assert.ok(uploaded.status < 300, JSON.stringify(uploaded));
    const scanned = await w.request("/api/service-media", { method: "PATCH", staff: true, body: {
      id, action: "record_scan", scanResult: "clean", reason: "Synthetic inspector evidence for route integration only" } });
    assert.ok(scanned.status < 300, JSON.stringify(scanned)); media.push(ref);
  }
  const proof = await lifecycle("add_proof", { beforePhotoRef: media[0], afterPhotoRef: media[1], checklist: ["coat", "nails", "ears"], completionNotes: "Synthetic completed-care evidence" });
  assert.equal(proof.status, 200, JSON.stringify(proof));
  const completed = await lifecycle("complete"); assert.equal(completed.status, 200, JSON.stringify(completed));
  const summary = await w.request(`/api/customer-grooming-summary?bookingId=${w.bookingId}`, { cookie: w.customerCookie });
  assert.equal(summary.status, 200, JSON.stringify(summary)); assert.equal(summary.body.data.status, "completed");
  const invoice = summary.body.data.invoice; assert.equal(invoice.total, w.amount); assert.ok(invoice.tax > 0);
  assert.equal(Math.round((invoice.subtotal + invoice.tax) * 100), w.amountPaise);
  const final = await verifySurfaces(w);
  assert.equal(final.job.status, "completed"); assert.equal(final.job.workOrderStatus, "completed");
  assert.equal(final.operation.status, "completed"); assert.equal(final.finance.summary.completed, 1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_invoices WHERE booking_id=?").get(w.bookingId).n, 1);
  assert.deepEqual(captureCounts(w), { timelines: 1, journals: 1, collections: 1, captured: w.amount, orders: 1 });
  assert.equal(w.calls.filter(c => c.path === "/api/customer-checkout" && c.action === "confirm").length, 0);
  t.diagnostic(JSON.stringify({ bookingId: w.bookingId, customer: "completed with invoice", partner: "completed", operations: "completed",
    financeCollected: final.finance.summary.collected, invoices: 1, paymentTimelineEvents: 1, browserCallback: "not invoked",
    evidence: "real handlers/gates/SQLite; synthetic provider/GPS/media boundaries; not live transport" }));
});
