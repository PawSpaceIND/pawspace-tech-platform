import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installWorkersHooks, enterWorkersDbScope } from './helpers/module-hooks.mjs';
import { d1 } from './helpers/execution-harness.mjs';
installWorkersHooks('__CUSTOMER_CHECKOUT_WIRING_DB__', '__CUSTOMER_CHECKOUT_WIRING_ENV__');
const sdk = await import('../lib/mobile/razorpay.ts');
const server = await import('../lib/customer-checkout-server.ts');
const { CustomerCheckoutController } = await import('../lib/customer-checkout-client.ts');
const locks = { PAWSPACE_PAYMENT_ENV: 'sandbox', FORBID_PRODUCTION: 'true', PAWSPACE_PAYMENT_LIVE_APPROVED: 'false' };
// Deliberately synthetic keys. All external SDK/network calls below are controlled test doubles.
const env = { ...locks, RAZORPAY_KEY_ID_SANDBOX: 'rzp_test_fixtureOnly', RAZORPAY_KEY_SECRET_SANDBOX: 'checkout-fixture-secret-not-a-credential',
  RAZORPAY_WEBHOOK_SECRET_SANDBOX: 'checkout-fixture-webhook-not-a-credential' };
const opts = { keyId: env.RAZORPAY_KEY_ID_SANDBOX, orderId: 'order_fixture', amountPaise: 49950, currency: 'INR' };
const receipt = { bookingId: 'B1', orderId: 'order_fixture', paymentId: 'pay_fixture',
  signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET_SANDBOX).update('order_fixture|pay_fixture').digest('hex') };
function world(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,status TEXT);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,status TEXT,amount REAL,amount_due_now REAL,currency TEXT);
    CREATE TABLE payment_intents(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,payment_id TEXT,gateway_order_id TEXT,provider TEXT,environment TEXT,amount_paise INTEGER,currency TEXT);
    CREATE TABLE payment_gateway_events(id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,gateway_order_id TEXT,gateway_payment_id TEXT,provider TEXT,environment TEXT,signature_verified INTEGER,processing_status TEXT,event_type TEXT,amount_subunits INTEGER,currency TEXT);
    INSERT INTO canonical_bookings VALUES('B1','C1','confirmed'),('B2','C2','confirmed');
    INSERT INTO booking_payments VALUES('P1','B1','C1','created',499.50,499.50,'INR'),('P2','B2','C2','created',100,100,'INR');
    INSERT INTO payment_intents VALUES('I1','B1','C1','P1','order_fixture','razorpay','sandbox',49950,'INR');`);
  const db = d1(sqlite); enterWorkersDbScope(db); globalThis.__CUSTOMER_CHECKOUT_WIRING_DB__ = db;
  globalThis.__CUSTOMER_CHECKOUT_WIRING_ENV__ = { ...env };
  return { sqlite, db };
}
function event(sqlite, patch = {}) {
  const row = { id: 'EV1', booking_id: 'B1', payment_id: 'P1', gateway_order_id: 'order_fixture', gateway_payment_id: 'pay_fixture',
    provider: 'razorpay', environment: 'sandbox', signature_verified: 1, processing_status: 'processed', event_type: 'payment.captured', amount_subunits: 49950, currency: 'INR', ...patch };
  sqlite.prepare(`INSERT INTO payment_gateway_events (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}
function browser(t, win, document) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = win; if (document) globalThis.document = document;
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
}

for (const [label, value] of [['missing', {}], ['empty', { ...locks, PAWSPACE_PAYMENT_ENV: '' }],
  ['live', { ...locks, PAWSPACE_PAYMENT_ENV: 'live' }], ['unknown approval', { ...locks, PAWSPACE_PAYMENT_LIVE_APPROVED: 'later' }],
  ['false production lock', { ...locks, FORBID_PRODUCTION: false }]]) {
  test(`checkout rejects ${label} safety declarations`, () => assert.throws(() => sdk.assertSandboxPaymentLocks(value), /SECURITY LOCK VIOLATION/));
}
for (const value of ['rzp_live_fixture', 'rzp_test_placeholder', 'rzp_test_', 'anything']) {
  test(`checkout rejects invalid/test-placeholder key ${value}`, () => assert.throws(() => sdk.assertSandboxKey(value)));
}
for (const amountPaise of [0, -1, 1.25, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`SDK rejects invalid paise ${amountPaise}`, async () => assert.equal((await sdk.openMobileRazorpayCheckout({ ...opts, amountPaise }, locks)).code, 'INVALID_PARAMETERS'));
}
test('SDK safely reports no browser', async () => { assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'NO_WINDOW_CONTEXT'); });
test('SDK exposes a failed script load and permits a later retry', async t => {
  let attempts = 0;
  const win = {};
  browser(t, win, { createElement: () => ({ remove() {} }), body: { appendChild(script) {
    attempts++; queueMicrotask(() => { if (attempts === 1) script.onerror(); else {
      win.Razorpay = class { constructor(options) { this.options = options; } on() {} open() { this.options.modal.ondismiss(); } };
      script.onload();
    } });
  } } });
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'SDK_UNAVAILABLE');
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'USER_DISMISSED');
  assert.equal(attempts, 2);
});
test('SDK script loading has a bounded timeout', async t => {
  browser(t, {}, { createElement: () => ({ remove() {} }), body: { appendChild() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = sdk.openMobileRazorpayCheckout(opts, locks); t.mock.timers.tick(12_001);
  assert.equal((await result).code, 'SDK_UNAVAILABLE');
});
test('SDK refuses concurrent opens and accepts only a matching complete receipt', async t => {
  let options, count = 0;
  browser(t, { Razorpay: class { constructor(value) { options = value; count++; } on() {} open() {} } });
  const first = sdk.openMobileRazorpayCheckout(opts, locks); await Promise.resolve();
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'CHECKOUT_ALREADY_OPEN');
  options.handler({ razorpay_order_id: receipt.orderId, razorpay_payment_id: receipt.paymentId, razorpay_signature: receipt.signature });
  assert.equal((await first).success, true); assert.equal(count, 1);
});
test('SDK rejects a callback for another order and never fabricates the missing order ID', async t => {
  let callback = { razorpay_payment_id: receipt.paymentId, razorpay_signature: receipt.signature };
  browser(t, { Razorpay: class { constructor(options) { this.options = options; } on() {} open() { this.options.handler(callback); } } });
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'INVALID_RECEIPT');
  callback.razorpay_order_id = 'order_someoneelse';
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'INVALID_RECEIPT');
});
test('payment.failed resolves failure once, closes modal, disables nested SDK retries', async t => {
  let closed = false;
  browser(t, { Razorpay: class { constructor(options) { this.options = options; assert.equal(options.retry.enabled, false); }
    on(event, callback) { assert.equal(event, 'payment.failed'); this.callback = callback; }
    open() { this.callback({ error: { description: 'provider raw details not displayed' } }); }
    close() { closed = true; this.options.modal.ondismiss(); }
  } });
  const result = await sdk.openMobileRazorpayCheckout(opts, locks);
  assert.equal(result.code, 'PAYMENT_FAILED'); assert.equal(closed, true);
  assert.equal(JSON.stringify(result).includes('raw details'), false);
});
test('native plugin and constructor failures are structured and retryable', async t => {
  const win = { RazorpayCheckout: { open() { throw Error('native unavailable'); } } }; browser(t, win);
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'SDK_OPEN_FAILED');
  delete win.RazorpayCheckout; win.Razorpay = class { constructor() { throw Error('bad SDK'); } };
  assert.equal((await sdk.openMobileRazorpayCheckout(opts, locks)).code, 'SDK_OPEN_FAILED');
});

test('server requires explicitly configured sandbox credentials and never returns a secret', () => {
  assert.deepEqual(server.customerCheckoutEnvironment(env), locks);
  assert.throws(() => server.customerCheckoutEnvironment({ ...env, PAWSPACE_PAYMENT_ENV: 'live' }), error => error.status === 503);
  assert.throws(() => server.customerCheckoutEnvironment({ ...env, RAZORPAY_KEY_SECRET_SANDBOX: '' }), error => error.status === 503);
  assert.throws(() => server.customerCheckoutEnvironment({ ...env, RAZORPAY_KEY_ID_SANDBOX: 'rzp_test_placeholder' }), error => error.status === 503);
});
test('both booking and payment ownership are enforced', async t => {
  const { sqlite, db } = world(t);
  await server.assertCustomerCheckoutBooking(db, 'C1', 'B1');
  await assert.rejects(server.assertCustomerCheckoutBooking(db, 'C2', 'B1'), error => error.status === 404);
  sqlite.exec("UPDATE booking_payments SET customer_id='C2' WHERE id='P1'");
  await assert.rejects(server.assertCustomerCheckoutBooking(db, 'C1', 'B1'), error => error.status === 404);
});
for (const bookingStatus of ['cancelled', 'draft', 'rejected', 'unknown']) {
  test(`server refuses new checkout for ${bookingStatus} booking`, async t => {
    const { sqlite, db } = world(t); sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id='B1'").run(bookingStatus);
    await assert.rejects(server.assertCustomerCheckoutBooking(db, 'C1', 'B1'), error => error.status === 409);
  });
}
test('valid receipt before webhook stays pending and changes no financial state', async t => {
  const { sqlite, db } = world(t); const before = sqlite.prepare('SELECT * FROM booking_payments').all();
  const result = await server.verifyCustomerCheckoutReceipt(db, env, 'C1', receipt);
  assert.equal(result.receiptVerified, true); assert.equal(result.status, 'awaiting_confirmation');
  assert.deepEqual(sqlite.prepare('SELECT * FROM booking_payments').all(), before);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM payment_gateway_events').get().n, 0);
});
test('forged, cross-customer and cross-order receipts cannot be confirmed', async t => {
  const { db } = world(t);
  await assert.rejects(server.verifyCustomerCheckoutReceipt(db, env, 'C1', { ...receipt, signature: 'f'.repeat(64) }), error => error.status === 400);
  await assert.rejects(server.verifyCustomerCheckoutReceipt(db, env, 'C2', receipt), error => error.status === 404);
  await assert.rejects(server.verifyCustomerCheckoutReceipt(db, env, 'C1', { ...receipt, orderId: 'order_other' }), error => error.status === 404);
});
for (const [field, value] of Object.entries({ booking_id: 'B2', payment_id: 'P2', gateway_order_id: 'order_previous_instalment',
  gateway_payment_id: 'pay_other', environment: 'live', provider: 'manual', signature_verified: 0,
  processing_status: 'received', event_type: 'payment.authorized', amount_subunits: 49949, currency: 'USD' })) {
  test(`capture evidence mismatch on ${field} is not success`, async t => {
    const { sqlite, db } = world(t); event(sqlite, { [field]: value });
    assert.equal((await server.verifyCustomerCheckoutReceipt(db, env, 'C1', receipt)).status, 'awaiting_confirmation');
  });
}
test('matching processed signed capture confirms exactly that payment, including on replay', async t => {
  const { sqlite, db } = world(t); event(sqlite);
  const before = sqlite.prepare('SELECT * FROM payment_gateway_events').all();
  for (let i = 0; i < 3; i++) assert.equal((await server.verifyCustomerCheckoutReceipt(db, env, 'C1', receipt)).status, 'captured');
  assert.deepEqual(sqlite.prepare('SELECT * FROM payment_gateway_events').all(), before);
});

function client(patches = {}) {
  const states = [], requests = [], opened = [];
  const order = { connected: true, environment: 'sandbox', bookingId: 'B1', ...opts, locks, ...patches.order };
  let confirmationStatus = 'awaiting_confirmation', failConfirmation = false;
  const controller = new CustomerCheckoutController('B1', value => states.push(value), {
    fetch: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body);
      assert.equal(init.credentials, 'same-origin'); assert.equal('amountPaise' in body, false); assert.equal('customerId' in body, false);
      if (body.action === 'start') return Response.json({ data: order });
      if (failConfirmation) throw Error('lost response');
      return Response.json({ data: { bookingId: 'B1', orderId: opts.orderId, receiptVerified: true, environment: 'sandbox', status: confirmationStatus } });
    },
    open: async (options, runtime) => { opened.push(options); assert.deepEqual(runtime, locks); return patches.result ?? { success: true, environment: 'sandbox', ...receipt }; },
  });
  return { controller, states, requests, opened, setStatus(value) { confirmationStatus = value; }, setFailure(value) { failConfirmation = value; } };
}
test('customer click opens server-priced SDK once; callback alone stays pending', async () => {
  const c = client(); await Promise.all([c.controller.start(), c.controller.start(), c.controller.start()]);
  assert.equal(c.opened.length, 1); assert.equal(c.opened[0].amountPaise, 49950);
  assert.deepEqual(c.requests.map(r => r.action), ['start', 'confirm']);
  assert.equal(c.states.at(-1).phase, 'pending'); assert.equal(c.states.at(-1).canCheck, true);
  c.setStatus('captured'); await c.controller.start(); await c.controller.start();
  assert.deepEqual(c.requests.map(r => r.action), ['start', 'confirm', 'confirm']);
  assert.equal(c.opened.length, 1); assert.equal(c.states.at(-1).phase, 'captured');
});
test('lost confirmation retries same receipt rather than reopening payment', async () => {
  const c = client(); c.setFailure(true); await c.controller.start();
  assert.equal(c.states.at(-1).phase, 'error'); assert.equal(c.states.at(-1).canCheck, true);
  c.setFailure(false); await c.controller.start();
  assert.deepEqual(c.requests[1], c.requests[2]); assert.equal(c.opened.length, 1);
});
for (const [field, value] of Object.entries({ environment: 'live', keyId: 'rzp_live_fixture', bookingId: 'B2', currency: 'USD', amountPaise: 499.5, connected: false, locks: {} })) {
  test(`customer controller refuses unsafe order ${field}`, async () => {
    const c = client({ order: { [field]: value } }); await c.controller.start();
    assert.equal(c.opened.length, 0); assert.equal(c.states.at(-1).phase, 'error');
  });
}
test('dismissed checkout neither confirms nor invents a paid state', async () => {
  const c = client({ result: { success: false, environment: 'sandbox', code: 'USER_DISMISSED', description: 'Checkout closed' } });
  await c.controller.start(); assert.equal(c.requests.length, 1); assert.equal(c.states.at(-1).phase, 'error');
});

async function cookie(db, subjectId = 'C1', subjectType = 'customer') {
  const { upsertIdentityBinding } = await import('../lib/identity-binding.ts');
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import('../lib/platform-session.ts');
  const identitySource = subjectType === 'customer' ? 'customer_otp' : 'partner_otp';
  const binding = await upsertIdentityBinding(db, { identitySource, principalType: 'identity_subject', principalKey: `${subjectType}:${subjectId}`,
    subjectType, subjectId, actorId: 'checkout-wiring-20260909', reason: 'Synthetic authenticated checkout regression fixture' });
  const issued = await issuePlatformSession(db, { bindingId: binding.id, identitySource, principalType: 'identity_subject',
    principalKey: `${subjectType}:${subjectId}`, subjectType, subjectId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
const origin = 'https://checkout-wiring.pawspace.test';
function request(body, session = '', extraHeaders = {}) {
  return new Request(`${origin}/api/customer-checkout`, { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: session, ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}
test('production session gateway admits a real customer session and refuses a provider', async t => {
  const { db } = world(t);
  const { authorizePlatformSessionRequest } = await import('../lib/session-api-gateway.ts');
  const access = await authorizePlatformSessionRequest(request({ action: 'start', bookingId: 'B1' }, await cookie(db)), db);
  assert.equal(access.permission, 'scheduling.book'); assert.equal(access.actor.roleCode, 'customer'); assert.equal(access.actor.preview, false);
  const denied = await authorizePlatformSessionRequest(request({ action: 'start', bookingId: 'B1' }, await cookie(db, 'PRV1', 'provider')), db);
  assert.equal(denied.status, 403);
});
test('actual confirmation route uses session ownership and returns no secret', async t => {
  const { db } = world(t); const session = await cookie(db); const { POST } = await import('../app/api/customer-checkout/route.ts');
  const response = await POST(request({ action: 'confirm', ...receipt, customerId: 'C2' }, session));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text(); assert.equal(text.includes(env.RAZORPAY_KEY_SECRET_SANDBOX), false);
  assert.equal(text.includes(receipt.signature), false); assert.equal(JSON.parse(text).data.status, 'awaiting_confirmation');
});
test('route rejects cross-account receipt even when body forges customerId', async t => {
  const { db } = world(t); const { POST } = await import('../app/api/customer-checkout/route.ts');
  const response = await POST(request({ action: 'confirm', ...receipt, customerId: 'C1' }, await cookie(db, 'C2')));
  assert.equal(response.status, 404);
});
test('route blocks cross-origin and missing-origin writes before touching the database', async () => {
  const { POST } = await import('../app/api/customer-checkout/route.ts');
  assert.equal((await POST(request({}, '', { origin: 'https://attacker.example' }))).status, 403);
  const req = request({}); req.headers.delete('origin'); assert.equal((await POST(req)).status, 403);
});
test('route refuses unauthenticated, provider and revoked sessions', async t => {
  const { db, sqlite } = world(t); const { POST } = await import('../app/api/customer-checkout/route.ts');
  assert.equal((await POST(request({ action: 'start', bookingId: 'B1' }))).status, 401);
  assert.equal((await POST(request({ action: 'start', bookingId: 'B1' }, await cookie(db, 'PRV1', 'provider')))).status, 401);
  const session = await cookie(db); sqlite.exec("UPDATE platform_identity_sessions SET status='revoked'");
  assert.equal((await POST(request({ action: 'start', bookingId: 'B1' }, session))).status, 401);
});
test('route rejects malformed JSON, oversized chunked body and unsupported action', async t => {
  const { db } = world(t); const session = await cookie(db); const { POST } = await import('../app/api/customer-checkout/route.ts');
  assert.equal((await POST(request('not json', session))).status, 400);
  const huge = request(' '.repeat(4097), session); assert.equal(huge.headers.has('content-length'), false);
  assert.equal((await POST(huge)).status, 413);
  assert.equal((await POST(request({ action: 'mark_paid', ...receipt }, session))).status, 400);
  assert.equal((await POST(request({}, session, { 'content-type': 'text/plain' }))).status, 415);
});
test('route refuses cancelled and fully settled bookings without provider calls', async t => {
  const { db, sqlite } = world(t); const session = await cookie(db); const { POST } = await import('../app/api/customer-checkout/route.ts');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('payment provider must not be called'));
  sqlite.exec("UPDATE canonical_bookings SET status='cancelled' WHERE id='B1'");
  assert.equal((await POST(request({ action: 'start', bookingId: 'B1' }, session))).status, 409);
  sqlite.exec("UPDATE canonical_bookings SET status='confirmed'; UPDATE booking_payments SET status='captured' WHERE id='P1'");
  const result = await POST(request({ action: 'start', bookingId: 'B1' }, session));
  assert.equal(result.status, 200); assert.equal((await result.json()).data.status, 'nothing_due');
});
test('real order route persists one server-priced intent and reuses it across retries', async t => {
  const { db, sqlite } = world(t); const session = await cookie(db); const { POST } = await import('../app/api/customer-checkout/route.ts');
  // Exercise the production finance schema and real saga, not the minimal receipt-read fixture.
  sqlite.exec('DROP TABLE payment_intents; DROP TABLE payment_gateway_events;');
  const { ensureFinancialRuntimeTables } = await import('../lib/financial-runtime-schema.ts');
  await ensureFinancialRuntimeTables(db);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.razorpay.com/v1/orders'); assert.equal(init.method, 'POST');
    const data = JSON.parse(init.body); assert.equal(data.amount, 49950); assert.equal(data.currency, 'INR');
    calls++; return Response.json({ id: 'order_fixture', amount: data.amount, currency: data.currency, status: 'created' });
  });
  const payload = { action: 'start', bookingId: 'B1', amountPaise: 1, customerId: 'C2', paymentStatus: 'captured' };
  for (let i = 0; i < 2; i++) {
    const response = await POST(request(payload, session));
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.data.orderId, 'order_fixture'); assert.equal(body.data.amountPaise, 49950); assert.deepEqual(body.data.locks, locks);
  }
  assert.equal(calls, 1); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM payment_intents').get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='P1'").get().status, 'created');
  assert.equal(sqlite.prepare('SELECT gateway_order_id FROM payment_gateway_links').get().gateway_order_id, 'order_fixture');
});

test('a settled booking shows nothing due without opening the SDK or claiming a new capture', async () => {
  const c = client({ order: { connected: false, status: 'nothing_due' } }); await c.controller.start();
  assert.equal(c.opened.length, 0); assert.equal(c.states.at(-1).phase, 'settled');
  assert.equal(c.requests.length, 1);
});
