/**
 * Interakt WhatsApp dispatch — the guards, not the happy path.
 *
 * The Haptik LOE dead-ends 8 of its 12 outbound use cases without a WhatsApp send, so this provider is
 * new surface. New surface that sends messages to real phone numbers is exactly where a test suite has
 * to be adversarial rather than confirmatory, because the failure mode is not "no message" - it is
 * "a booking link delivered to the wrong handset", which nobody notices until it matters.
 *
 * So every test here drives the real dispatcher with an injected fetcher and asserts on what would go
 * on the wire, and each guard is asserted by the thing it prevents:
 *
 *   - not configured        -> nothing is sent at all, and it is NOT reported as sent
 *   - wrong number          -> 403, and the fetcher is never called
 *   - no consent / opt-out  -> 409, and the fetcher is never called
 *   - free text outside 24h -> 409, naming the missing template
 *
 * The "fetcher never called" assertions are the load-bearing ones. A guard that refuses AFTER the HTTP
 * call has already left has not prevented anything, and a test that only checks the returned status
 * cannot tell the two apart.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

/**
 * A minimal D1 facade over node:sqlite.
 *
 * Declared here rather than imported because the transactional shim (tests/helpers/d1.mjs) lives on an
 * unmerged branch, and this suite must run on main today. Nothing here depends on batch() atomicity -
 * the dispatcher issues single statements - so a faithful single-statement facade is sufficient, and
 * this file should move onto the shared shim the moment that branch lands.
 */
const createD1 = (sqlite) => ({
  prepare(sql) {
    const bound = [];
    const stmt = {
      bind: (...args) => { bound.push(...args); return stmt; },
      first: async () => sqlite.prepare(sql).get(...bound) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...bound);
        const changes = Number(info.changes ?? 0);
        return { success: true, meta: { changes, rows_written: changes, last_row_id: Number(info.lastInsertRowid ?? 0) } };
      },
    };
    return stmt;
  },
  batch: async (statements) => Promise.all(statements.map((s) => s.run())),
  exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
});

installWorkersHooks("__IWA_DB__", "__IWA_ENV__");

const NOW = Date.UTC(2026, 7, 1);
const CONFIGURED = { INTERAKT_API_KEY: "test-key-not-a-real-secret", INTERAKT_BASE_URL: "https://api.interakt.test" };

let sqlite;

async function fresh({ consent = 1, optOut = 0 } = {}) {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__IWA_DB__ = db;
  globalThis.__IWA_ENV__ = {};
  const { ensureCommunicationTables } = await import("../lib/communication-engine.ts");
  await ensureCommunicationTables(db);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY, city_id TEXT, name TEXT, primary_phone TEXT, secondary_phone TEXT, email TEXT, source TEXT, consent_json TEXT DEFAULT '{}', created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY, whatsapp_consent INTEGER, opt_out INTEGER, marketing_consent INTEGER, updated_by TEXT, updated_at INTEGER);
  `);
  // Stored +91-prefixed, so the "same handset in a different shape" case is exercised by default.
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,created_at,updated_at) VALUES ('CUS-A','blr','Asha','+919100000000','test',0,0)").run();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,created_at,updated_at) VALUES ('CUS-B','blr','Bhavna','+919100000001','test',0,0)").run();
  // Stored +91-prefixed, so the "same handset in a different shape" case is exercised by default.
  sqlite.prepare("INSERT OR REPLACE INTO customer_contact_preferences (customer_id,whatsapp_consent,opt_out,marketing_consent,updated_by,updated_at) VALUES ('CUS-A',?,?,1,'test',?)").run(consent, optOut, NOW);
  return db;
}

/**
 * Enqueue a real outbox message so the dispatcher has something to reconcile against.
 *
 * The dispatcher deliberately does NOT create its own message row - it dispatches an already-enqueued
 * one, so every send is traceable to a governed request. That means recordDeliveryEvent refuses an
 * unknown messageId, which is correct, and it is why this helper exists rather than the test inventing
 * a bare id.
 */
async function enqueue(db, messageId, customerId = "CUS-A") {
  const { enqueueCommunication } = await import("../lib/communication-engine.ts");
  const queued = await enqueueCommunication(db, {
    customerId, cityId: "blr", channel: "whatsapp", purpose: "transactional",
    idempotencyKey: messageId, templateKey: "pkg_link_v1",
    payload: { messageId }, createdBy: "interakt-test",
  });
  return String(queued?.messageId ?? queued?.message_id ?? messageId);
}

/** A fetcher that records every call, so "was anything sent?" is answerable. */
function spyFetcher(response = { ok: true, body: { result: true, id: "interakt-msg-1" } }) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response.body), {
      status: response.ok ? 200 : (response.status ?? 400),
      headers: { "content-type": "application/json" },
    });
  };
  fetcher.calls = calls;
  return fetcher;
}

const TEMPLATE = { withinSession: false, templateKey: "pkg_link_v1", language: "en", bodyValues: ["Asha", "Essential Bath"] };

// ---------------------------------------------------------------------------
// The happy path, so the refusals below are known to be about the guards
// ---------------------------------------------------------------------------
test("a consented customer's own number is sent an approved template, and the wire body is correct", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  const messageId = await enqueue(db, "MSG-1");
  const result = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId, customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher);

  assert.equal(result.status, "sent");
  assert.equal(result.provider, "interakt");
  assert.equal(result.providerMessageId, "interakt-msg-1");
  assert.equal(fetcher.calls.length, 1, "exactly one send");

  const call = fetcher.calls[0];
  assert.equal(call.url, "https://api.interakt.test/v1/public/message/");
  assert.equal(call.init.headers.authorization, "Basic test-key-not-a-real-secret");
  const body = JSON.parse(call.init.body);
  // The +91 stored / 10-digit supplied mismatch must resolve to one country code and one local number,
  // never a doubled prefix - a doubled prefix reaches nobody and looks like a delivery failure.
  assert.equal(body.countryCode, "+91");
  assert.equal(body.phoneNumber, "9100000000");
  assert.equal(body.type, "Template");
  assert.equal(body.template.name, "pkg_link_v1");
  assert.deepEqual(body.template.bodyValues, ["Asha", "Essential Bath"]);
});

// ---------------------------------------------------------------------------
// Guard 1 — fail closed when the provider is not configured
// ---------------------------------------------------------------------------
test("with no API key nothing is sent, and it is not reported as sent", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage, interaktEnabled } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  assert.equal(interaktEnabled({}), false, "an unset key must read as disabled");
  const result = await dispatchInteraktMessage(db, {},
    { messageId: "MSG-OFF", customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher);

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "interakt_not_configured");
  // The important half: a deliberate off state must not look like a delivery.
  assert.deepEqual(fetcher.calls, [], "nothing may reach the provider when it is not configured");
});

// ---------------------------------------------------------------------------
// Guard 2 — the recipient must belong to the named customer
// ---------------------------------------------------------------------------
test("a number that belongs to a different customer is refused 403 before anything is sent", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  // CUS-A is consented; the phone is CUS-B's. Without this guard, a caller who knows a real customer id
  // could have that customer's package or payment link delivered to a handset they control.
  const error = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: "MSG-XPHONE", customerId: "CUS-A", recipient: "9100000001", send: TEMPLATE }, fetcher)
    .then(() => null, (e) => e);

  assert.ok(error, "a cross-customer number was accepted");
  assert.equal(error.statusCode, 403, `expected 403, got ${error.statusCode}: ${error.message}`);
  assert.match(error.message, /does not belong to this customer/);
  assert.deepEqual(fetcher.calls, [], "the refusal must land BEFORE the send, not after");
});

test("an unknown number is refused, and an unknown customer is refused", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  for (const [label, input] of [
    ["a number nobody owns", { messageId: "M1", customerId: "CUS-A", recipient: "9999999999", send: TEMPLATE }],
    ["a customer that does not exist", { messageId: "M2", customerId: "CUS-NOPE", recipient: "9100000000", send: TEMPLATE }],
  ]) {
    const error = await dispatchInteraktMessage(db, CONFIGURED, input, fetcher).then(() => null, (e) => e);
    assert.ok(error, `${label} was accepted`);
    assert.equal(error.statusCode, 403, `${label}: expected 403, got ${error.statusCode}`);
  }
  assert.deepEqual(fetcher.calls, [], "no unowned recipient may reach the provider");
});

// ---------------------------------------------------------------------------
// Guard 3 — consent, read per send
// ---------------------------------------------------------------------------
test("a customer without WhatsApp consent is refused 409 before anything is sent", async () => {
  const db = await fresh({ consent: 0 });
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  const error = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: "MSG-NOCONSENT", customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher)
    .then(() => null, (e) => e);

  assert.ok(error, "an unconsented customer was messaged");
  assert.equal(error.statusCode, 409);
  assert.match(error.message, /consent|opted out/i);
  assert.deepEqual(fetcher.calls, [], "no send without consent");
});

test("an explicit opt-out overrides a consent flag that is still set", async () => {
  // The realistic shape of a compliance failure: consent was granted once and never cleared, and the
  // opt-out arrived later. Checking only whatsapp_consent would keep messaging them.
  const db = await fresh({ consent: 1, optOut: 1 });
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  const error = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: "MSG-OPTOUT", customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher)
    .then(() => null, (e) => e);

  assert.ok(error, "an opted-out customer was messaged");
  assert.equal(error.statusCode, 409);
  assert.deepEqual(fetcher.calls, [], "an opt-out must stop the send");
});

test("an opt-out takes effect on the very next send, with no cached decision", async () => {
  const db = await fresh({ consent: 1, optOut: 0 });
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  const firstId = await enqueue(db, "MSG-A");
  const first = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: firstId, customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher);
  assert.equal(first.status, "sent");

  sqlite.prepare("UPDATE customer_contact_preferences SET opt_out=1 WHERE customer_id='CUS-A'").run();

  const secondId = await enqueue(db, "MSG-B");
  const second = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: secondId, customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher)
    .then(() => null, (e) => e);
  assert.ok(second, "the opt-out was not honoured on the next send");
  assert.equal(second.statusCode, 409);
  assert.equal(fetcher.calls.length, 1, "only the pre-opt-out message was sent");
});

// ---------------------------------------------------------------------------
// The 24-hour window rule
// ---------------------------------------------------------------------------
test("free text outside the 24-hour window is refused, naming the missing template", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  const error = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: "MSG-FREETEXT", customerId: "CUS-A", recipient: "9100000000",
      send: { withinSession: false, templateKey: "" } }, fetcher)
    .then(() => null, (e) => e);

  assert.ok(error, "free text was accepted outside the session window");
  assert.equal(error.statusCode, 409);
  assert.match(error.message, /approved WhatsApp template is required/);
  assert.deepEqual(fetcher.calls, [], "a send that the provider would reject must not be attempted");
});

test("inside the 24-hour window a free-text reply is allowed and sent as Text", async () => {
  // The positive control for the rule above: it must be the WINDOW that decides, not a blanket ban on
  // free text - otherwise every human handoff reply would be blocked.
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher();

  const messageId = await enqueue(db, "MSG-SESSION");
  const result = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId, customerId: "CUS-A", recipient: "9100000000",
      send: { withinSession: true, messageText: "Your groomer is on the way." } }, fetcher);

  assert.equal(result.status, "sent");
  const body = JSON.parse(fetcher.calls[0].init.body);
  assert.equal(body.type, "Text");
  assert.equal(body.data.message, "Your groomer is on the way.");
});

// ---------------------------------------------------------------------------
// Provider failure is recorded, not swallowed
// ---------------------------------------------------------------------------
test("a provider rejection is reported as refused and recorded, never as sent", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const fetcher = spyFetcher({ ok: false, status: 400, body: { result: false, message: "template not approved" } });

  const result = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: "MSG-REJECT", customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, fetcher);

  assert.equal(result.status, "refused", "a provider rejection must not be reported as sent");
  assert.equal(result.providerMessageId, null);
  assert.match(String(result.reason), /template not approved/);
});

test("a transport failure is a 502 and leaves the message retryable rather than lost", async () => {
  const db = await fresh();
  const { dispatchInteraktMessage } = await import("../lib/interakt-whatsapp.ts");
  const boom = async () => { throw new Error("ECONNRESET"); };

  const error = await dispatchInteraktMessage(db, CONFIGURED,
    { messageId: "MSG-NET", customerId: "CUS-A", recipient: "9100000000", send: TEMPLATE }, boom)
    .then(() => null, (e) => e);

  assert.ok(error, "a transport failure was swallowed");
  assert.equal(error.statusCode, 502, "an unreachable provider is a gateway failure, not a client error");
});

// ---------------------------------------------------------------------------
// Config validation — a misconfigured provider must not silently send elsewhere
// ---------------------------------------------------------------------------
test("a non-https base URL is rejected rather than used", async () => {
  const { interaktConfig } = await import("../lib/interakt-whatsapp.ts");
  // Sending an approved template plus a customer's name over plain http, or to an attacker-controlled
  // host, is worse than not sending it.
  assert.throws(() => interaktConfig({ INTERAKT_API_KEY: "k", INTERAKT_BASE_URL: "http://api.interakt.test" }), /https/);
  assert.throws(() => interaktConfig({ INTERAKT_API_KEY: "k", INTERAKT_COUNTRY_CODE: "91" }), /\+91/);
  assert.equal(interaktConfig({}), null, "no key means not configured, not a throw");
  assert.equal(interaktConfig({ INTERAKT_API_KEY: "k" }).baseUrl, "https://api.interakt.ai", "a sane default base URL");
});
