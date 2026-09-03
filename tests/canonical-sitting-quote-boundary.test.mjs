import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CANONICAL_SITTING_DB__", "__CANONICAL_SITTING_ENV__");

const ORIGIN = "https://app.pawspace.in";
const CUSTOMER = "CUS-CANONICAL-SITTING-1";
const PROVIDER = "PRV-CANONICAL-SITTING-1";
const SECOND_PROVIDER = "PRV-CANONICAL-SITTING-2";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    sql,
    args,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const item of items) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function sessionCookie(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: "+919999000011",
    subjectType: "customer",
    subjectId: CUSTOMER,
    cityId: "blr",
    verificationState: "verified",
    expiresAt: null,
    metadata: {},
    actorId: "test",
    reason: "canonical Sitting quote boundary",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id),
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: String(binding.principal_key),
    subjectType: "customer",
    subjectId: CUSTOMER,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CANONICAL_SITTING_DB__ = db;
  globalThis.__CANONICAL_SITTING_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.exec(`
    CREATE TABLE scheduling_assignment_decisions (
      group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL DEFAULT 'auto',shortlist_json TEXT NOT NULL DEFAULT '[]',
      selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL
    );
    CREATE TABLE scheduling_reservations (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,
      city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',
      scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,
      occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,
      explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
    );
  `);

  const cookie = await sessionCookie(db);
  const start = new Date(Date.now() + 72 * 60 * 60_000);
  start.setUTCHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60_000);
  return { sqlite, db, cookie, start: start.toISOString(), end: end.toISOString() };
}

function seedSchedule(sqlite, { groupId, start, end, providerId = PROVIDER }) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,selected_provider_id,status,updated_at) VALUES (?,?, 'assigned',?)")
    .run(groupId, providerId, now);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'assigned',?)")
    .run(`RES-${groupId}`, groupId, providerId, "pet_sitting", "blr", "blr-east", CUSTOMER, start, end, now);
}

async function commercial(db, { start, end, paymentMode = "prepaid", paymentKey = crypto.randomUUID() }) {
  const { createSittingQuote } = await import("../lib/sitting-governance.ts");
  const { captureSittingQuoteSandbox } = await import("../lib/sitting-payment-governance.ts");
  const quote = await createSittingQuote(db, {
    packageCode: "sitting-visit-60",
    petCount: 1,
    cityId: "blr",
    zoneId: "blr-east",
    scheduledStart: start,
    scheduledEnd: end,
    paymentMode,
  });
  const capture = await captureSittingQuoteSandbox(db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey,
  });
  return { quote, capture };
}

function payload({ groupId, start, end, quote, key = `BOOK-${groupId}`, overrides = {} }) {
  const base = {
    idempotencyKey: key,
    scheduleGroupId: groupId,
    customer: { id: CUSTOMER, name: "Canonical Sitting Customer", primaryPhone: "+919999000011" },
    pets: [{ sourceId: "sit-pet-1", name: "Milo", species: "dog", vaccinationStatus: "verified" }],
    cityId: "blr",
    zoneId: "blr-east",
    serviceCode: "pet_sitting",
    packageCode: quote?.packageCode ?? "free-plan",
    packageName: quote?.packageName ?? "Free Sitting",
    scheduledStart: start,
    scheduledEnd: end,
    provider: { id: PROVIDER, name: "Canonical Sitter", model: "full_time" },
    totalAmount: quote?.totalAmount ?? 0,
    amountDueNow: quote?.amountDueNow ?? 0,
    payment: { method: "card", mode: quote?.paymentMode ?? "prepaid", status: "captured", detail: "server-attested sandbox capture" },
    pricing: { discount: 0, sittingQuoteId: quote?.quoteId },
  };
  return {
    ...base,
    ...overrides,
    payment: { ...base.payment, ...(overrides.payment ?? {}) },
    pricing: { ...base.pricing, ...(overrides.pricing ?? {}) },
  };
}

async function book(cookie, body) {
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/canonical-bookings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { response, data };
}

function count(sqlite, table, where = "", values = []) {
  try {
    return Number(sqlite.prepare(`SELECT COUNT(*) count FROM ${table}${where ? ` WHERE ${where}` : ""}`).get(...values).count);
  } catch {
    return 0;
  }
}

function bookingState(sqlite) {
  return {
    customers: count(sqlite, "canonical_customers"),
    pets: count(sqlite, "canonical_pets"),
    bookings: count(sqlite, "canonical_bookings"),
    workOrders: count(sqlite, "provider_work_orders"),
    payments: count(sqlite, "booking_payments"),
    lifecycle: count(sqlite, "booking_lifecycle_events"),
    quoteLinks: count(sqlite, "sitting_booking_quote_links"),
  };
}

function quoteState(sqlite, quoteId) {
  return sqlite.prepare("SELECT status,used_at,used_booking_id FROM sitting_commercial_quotes WHERE id=?").get(quoteId);
}

const ZERO_BOOKING_STATE = { customers: 0, pets: 0, bookings: 0, workOrders: 0, payments: 0, lifecycle: 0, quoteLinks: 0 };

test("canonical Pet Sitting refuses a caller-priced booking when no governed quote is supplied", async () => {
  const { sqlite, db, cookie, start, end } = await world();
  const { quote } = await commercial(db, { start, end, paymentKey: "missing-quote-control" });
  const groupId = "SIT-MISSING-QUOTE";
  seedSchedule(sqlite, { groupId, start, end });

  const beforeQuote = quoteState(sqlite, quote.quoteId);
  const result = await book(cookie, payload({
    groupId,
    start,
    end,
    quote: null,
    overrides: { totalAmount: 1, amountDueNow: 1, pricing: { sittingQuoteId: undefined } },
  }));

  assert.equal(result.response.status, 409, JSON.stringify(result.data));
  assert.match(result.data.error, /server Sitting quote is required/i);
  assert.deepEqual(bookingState(sqlite), ZERO_BOOKING_STATE, "a missing quote must create no canonical bundle");
  assert.deepEqual(quoteState(sqlite, quote.quoteId), beforeQuote, "an unrelated open quote and its capture remain unchanged");
});

test("canonical Pet Sitting refuses invented packages and caller-controlled amounts without consuming the quote", async () => {
  const { sqlite, db, cookie, start, end } = await world();
  const { quote } = await commercial(db, { start, end, paymentKey: "mismatch-quote-control" });
  const groupId = "SIT-MISMATCHED-QUOTE";
  seedSchedule(sqlite, { groupId, start, end });

  const result = await book(cookie, payload({
    groupId,
    start,
    end,
    quote,
    overrides: { packageCode: "free-plan", packageName: "Free Sitting", totalAmount: 1, amountDueNow: 1 },
  }));

  assert.equal(result.response.status, 409, JSON.stringify(result.data));
  assert.match(result.data.error, /sandbox capture|package|amount.*server quote/i);
  assert.deepEqual(bookingState(sqlite), ZERO_BOOKING_STATE);
  assert.deepEqual({ ...quoteState(sqlite, quote.quoteId) }, { status: "open", used_at: null, used_booking_id: null });
  assert.equal(count(sqlite, "sitting_quote_payment_attestations", "quote_id=?", [quote.quoteId]), 1, "the server capture remains available for a corrected request");
});

test("canonical Pet Sitting derives money and package truth from the governed quote, consumes it once, and replays idempotently", async () => {
  const { sqlite, db, cookie, start, end } = await world();
  const { quote, capture } = await commercial(db, { start, end, paymentKey: "valid-quote-control" });
  const groupId = "SIT-GOVERNED-QUOTE";
  seedSchedule(sqlite, { groupId, start, end });
  const body = payload({ groupId, start, end, quote });

  const created = await book(cookie, body);
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const bookingId = created.data.data.bookingId;
  assert.ok(bookingId);

  const booking = sqlite.prepare("SELECT package_code,package_name,total_amount,pricing_json FROM canonical_bookings WHERE id=?").get(bookingId);
  assert.equal(booking.package_code, quote.packageCode);
  assert.equal(booking.package_name, quote.packageName);
  assert.equal(Number(booking.total_amount), quote.totalAmount);
  const pricing = JSON.parse(booking.pricing_json);
  assert.equal(pricing.sittingQuoteId, quote.quoteId);
  assert.equal(pricing.sittingCommercial.quoteId, quote.quoteId);
  assert.equal(pricing.sittingPaymentReference, capture.reference);

  const payment = sqlite.prepare("SELECT amount,amount_due_now,status,detail_json FROM booking_payments WHERE booking_id=?").get(bookingId);
  assert.equal(Number(payment.amount), quote.totalAmount);
  assert.equal(Number(payment.amount_due_now), quote.amountDueNow);
  assert.equal(payment.status, "captured");
  assert.equal(JSON.parse(payment.detail_json).sittingQuoteId, quote.quoteId);

  const used = quoteState(sqlite, quote.quoteId);
  assert.equal(used.status, "used");
  assert.equal(used.used_booking_id, bookingId);
  assert.ok(Number(used.used_at) > 0);
  assert.equal(count(sqlite, "sitting_booking_quote_links", "quote_id=? AND booking_id=?", [quote.quoteId, bookingId]), 1);

  const beforeReplay = bookingState(sqlite);
  const replay = await book(cookie, body);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.data.bookingId, bookingId);
  assert.equal(replay.data.data.duplicatePrevented, true);
  assert.deepEqual(bookingState(sqlite), beforeReplay, "idempotent replay must not create a second booking or quote link");

  const secondGroup = "SIT-QUOTE-REUSE";
  seedSchedule(sqlite, { groupId: secondGroup, start, end, providerId: SECOND_PROVIDER });
  const reused = await book(cookie, payload({
    groupId: secondGroup,
    start,
    end,
    quote,
    key: "BOOK-SIT-QUOTE-REUSE",
    overrides: { provider: { id: SECOND_PROVIDER, name: "Canonical Sitter Two", model: "full_time" } },
  }));
  assert.equal(reused.response.status, 409, JSON.stringify(reused.data));
  assert.match(reused.data.error, /already linked|already been used|booking write conflict/i);
  assert.deepEqual(bookingState(sqlite), beforeReplay, "the same quote cannot fund a second canonical bundle");
});
