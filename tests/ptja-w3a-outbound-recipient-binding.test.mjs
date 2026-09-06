/**
 * WAVE 3 TIER A - adversarial verification of W2-B3-R02. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "the caller-supplied recipient on POST /api/communications
 * action=dispatch_external_uat cannot be pointed at another customer - the boundary refuses before any
 * outbound call".
 *
 * The dangerous shape: a staff actor with communications.manage enqueues a message for customer A, then
 * dispatches it to a phone number they type in. If that number could be customer B's - or anyone's - the
 * platform becomes a way to send a message about A's booking to B, over a real provider.
 *
 * "Refuses before any outbound call" is the half that matters and the half a status-only assertion
 * cannot see. So globalThis.fetch is replaced with a counting stub that THROWS if reached: a refusal
 * that had already hit the network would fail these cases, not pass them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_COMM_DB__", "__W3A_COMM_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const ALICE = { id: "CUST-A", phone: "9800000001" };
const BOB = { id: "CUST-B", phone: "9845012345" };
const STRANGER = "9111111111";

// A fully "live" UAT dispatch configuration - the most permissive state the boundary can legitimately
// be in. Both Alice's and Bob's numbers are on the allowlist, so the allowlist cannot be what refuses
// the cross-customer case; only the recipient/customer binding can.
const LIVE_UAT_ENV = {
  PAWSPACE_COMMUNICATION_ENV: "uat",
  PAWSPACE_COMMUNICATION_PROVIDER_URL: "https://provider.invalid/send",
  PAWSPACE_COMMUNICATION_PROVIDER_TOKEN: "uat-token",
  PAWSPACE_COMMUNICATION_UAT_ALLOWLIST: `${ALICE.phone},${BOB.phone}`,
};

let sqlite;
let fetchCalls;
const realFetch = globalThis.fetch;

async function commWorld(env = LIVE_UAT_ENV) {
  sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3A_COMM_DB__ = db;
  globalThis.__W3A_COMM_ENV__ = env;

  fetchCalls = 0;
  globalThis.fetch = async (...args) => { fetchCalls += 1; throw new Error(`OUTBOUND CALL REACHED THE NETWORK: ${String(args[0])}`); };

  const { ensureCommunicationTables, enqueueCommunication, setCommunicationPreference } = await import("../lib/communication-engine.ts");
  const { setAdapterReadiness } = await import("../lib/communication-adapters.ts");
  await ensureCommunicationTables(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  for (const c of [ALICE, BOB]) {
    sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(c.id, "blr", c.id, c.phone, `${c.id.toLowerCase()}@example.in`, now, now);
  }
  await setCommunicationPreference(db, { customerId: ALICE.id, serviceUpdates: true, marketing: true, source: "w3a" });
  await setAdapterReadiness(db, { channel: "whatsapp", adapterName: "limechat", status: "sandbox_ready", credentialsStatus: "configured", webhookStatus: "ready", actorId: "w3a" });

  const enqueued = await enqueueCommunication(db, {
    customerId: ALICE.id, cityId: "blr", channel: "whatsapp", purpose: "transactional",
    // bookingId is required: a transactional message without one is hard-suppressed as
    // booking_link_required and never reaches the outbox, which would make every case below vacuous.
    bookingId: "BKG-A", payload: { bookingId: "BKG-A" }, createdBy: "ops.admin@pawspace.test",
    idempotencyKey: `idem-${crypto.randomUUID()}`, templateKey: "booking_update",
  });
  // enqueueCommunication returns { messageId }, not { message } - the duplicate branch is what returns
  // a row. Assert the fixture actually produced a dispatchable message, or every case below is vacuous.
  const messageId = String(enqueued.messageId ?? enqueued.message?.id ?? "");
  const queued = sqlite.prepare("SELECT m.status, o.status outbox FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.id=?").get(messageId);
  assert.equal(queued?.outbox, "queued", `the fixture must produce a dispatchable message, got ${JSON.stringify(queued)}`);
  return { db, messageId };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

async function dispatch(db, messageId, recipient) {
  const { dispatchExternalCommunication } = await import("../lib/communication-provider-boundary.ts");
  return dispatchExternalCommunication(db, globalThis.__W3A_COMM_ENV__, { messageId, adapterName: "limechat", recipient });
}

test("R02-01: the recipient cannot be pointed at ANOTHER customer, even one on the allowlist", async () => {
  const { db, messageId } = await commWorld();
  const result = await dispatch(db, messageId, BOB.phone);
  assert.equal(result.status, "recipient_customer_mismatch",
    `Alice's message must not be dispatchable to Bob: ${JSON.stringify(result)}`);
  assert.equal(result.externalDelivery, false);
  assert.equal(fetchCalls, 0, "the refusal must happen BEFORE the network boundary, not at it");
});

test("R02-02: the recipient cannot be a number belonging to nobody", async () => {
  const { db, messageId } = await commWorld();
  const result = await dispatch(db, messageId, STRANGER);
  assert.equal(result.status, "recipient_not_allowlisted", `an unknown number must be refused: ${JSON.stringify(result)}`);
  assert.equal(fetchCalls, 0, "and must not reach the network");
});

test("R02-03: even the customer's OWN number is refused when it is not allowlisted", async () => {
  const { db, messageId } = await commWorld({ ...LIVE_UAT_ENV, PAWSPACE_COMMUNICATION_UAT_ALLOWLIST: BOB.phone });
  const result = await dispatch(db, messageId, ALICE.phone);
  assert.equal(result.status, "recipient_not_allowlisted", "the allowlist binds independently of ownership");
  assert.equal(fetchCalls, 0, "and must not reach the network");
});

test("R02-04: a formatting variation on another customer's number does not slip through", async () => {
  // recipientBelongsToCustomer canonicalises to digits and +, so the mismatch check must not be
  // defeatable by punctuation - but the allowlist is an exact string match, so this is refused there.
  const { db, messageId } = await commWorld({ ...LIVE_UAT_ENV, PAWSPACE_COMMUNICATION_UAT_ALLOWLIST: `${ALICE.phone},${BOB.phone},+91-98450-12345` });
  const result = await dispatch(db, messageId, "+91-98450-12345");
  assert.equal(result.status, "recipient_customer_mismatch",
    `a punctuated form of Bob's number is still Bob's: ${JSON.stringify(result)}`);
  assert.equal(fetchCalls, 0, "and must not reach the network");
});

test("R02-05: with the customer record table absent the binding fails CLOSED", async () => {
  // The audit's defect class: unknown treated as satisfied. If the lookup cannot be performed, the
  // recipient is not proven to belong to anyone, and that must refuse rather than pass.
  const { db, messageId } = await commWorld();
  sqlite.exec("DROP TABLE canonical_customers");
  const result = await dispatch(db, messageId, ALICE.phone);
  assert.equal(result.status, "recipient_customer_mismatch", "an unverifiable binding must refuse");
  assert.equal(fetchCalls, 0, "and must not reach the network");
});

test("R02-06 (non-vacuity): the customer's OWN allowlisted number DOES reach the provider call", async () => {
  // Without this, every case above would pass on a boundary that refuses every dispatch - which would
  // hide a dead outbound path behind the same green ticks. The stub throws on contact, so reaching the
  // network is observable as an attempt rather than as a delivery.
  const { db, messageId } = await commWorld();
  const result = await dispatch(db, messageId, ALICE.phone);
  assert.equal(fetchCalls, 1,
    `a legitimate dispatch must reach the provider call: ${JSON.stringify(result)}`);
  assert.notEqual(result.status, "recipient_customer_mismatch", "and must not be refused by the binding");
  assert.notEqual(result.status, "recipient_not_allowlisted", "nor by the allowlist");
});
