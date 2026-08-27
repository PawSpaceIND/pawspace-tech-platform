import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createCapturedCanonicalSittingQuote } from "./helpers/canonical-sitting-commercial.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F31 — the booking window is an INSTANT, not a string.
//
// MEASURED in a browser against the real app, driving app/training/page.tsx end to end with a real
// customer, pet, address and published trainer roster:
//
//   POST /api/uat-scheduling    -> 200 {"status":"assigned","provider":{"id":"train_kiran"}}
//   POST /api/canonical-bookings-> 409 {"error":"Training booking window does not match the first
//                                        reserved session"}
//
// Two steps of the SAME flow disagreed about the same window. app/training/page.tsx:49 builds
// `${date}T10:00:00+05:30`; backend/src/scheduling.ts:49 stores every occurrence through
// `new Date(v).toISOString()`, so the reservation holds `...T04:30:00.000Z`. Identical instant,
// different spelling — and the three per-vertical guards compared the two with `!==` on strings.
// Every Training booking made from the customer app was refused after its reservation had already
// been committed.
//
// The GENERIC guard immediately above them ([PTJA-P1-F28]) already compared instants, so this is
// three checks disagreeing with the one they sit under, not a policy question. All four now share one
// definition, so they cannot drift apart again.
//
// NOT a finding: the generic guard was already fail-closed on an unreadable window. `NaN !== <number>`
// and `NaN !== NaN` are both true, so it refused rather than treating unparseable as matching. P1-W05
// and P1-W06 below were green before this change and are pinned so the shared helper keeps that
// property — they are regression pins, not refutations.
//
// These drive the REAL exported POST handler against a real SQLite database. Nothing here matches
// source text: every claim is a status and an error the handler returned.
// ---------------------------------------------------------------------------
installWorkersHooks("__WINDOW_EQ_DB__", "__WINDOW_EQ_ENV__");

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

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

const CUSTOMER = "CUS-WINDOWEQ-1", PROVIDER = "PRV-WINDOWEQ-1";
const CITY = "blr", ZONE = "koramangala";

/** Exactly what backend/src/scheduling.ts writes: the engine's canonical UTC spelling. */
const RESERVED_START = "2026-11-04T04:30:00.000Z", RESERVED_END = "2026-11-04T06:30:00.000Z";
/** Exactly what app/training/page.tsx sends: the same two instants, spelled in IST. */
const IST_START = "2026-11-04T10:00:00+05:30", IST_END = "2026-11-04T12:00:00+05:30";

const GENERIC_WINDOW_MESSAGE = "The booking window does not match the scheduling reservation";
const VERTICAL_WINDOW_MESSAGE = {
  dog_training: "Training booking window does not match the first reserved session",
  boarding: "Boarding booking window does not match the continuous stay reservation",
  pet_sitting: "Sitting booking window does not match the canonical care reservation",
};

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__WINDOW_EQ_DB__ = makeD1(sqlite);
  globalThis.__WINDOW_EQ_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  return sqlite;
}

function seedScheduling(sqlite, groupId, serviceCode) {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "balanced", "[]", PROVIDER, "assigned", "test", "seeded", 1);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, PROVIDER, serviceCode, CITY, ZONE, CUSTOMER, "[]", RESERVED_START, RESERVED_END, 1, 1, null, "reserved", "{}", 1);
}

async function book(sqlite, { key, group, serviceCode, start = IST_START, end = IST_END }) {
  seedScheduling(sqlite, group, serviceCode);
  let sittingQuote = null;
  if (serviceCode === "pet_sitting") {
    // Priced for the reservation's own instants, so the quote can never be what differs.
    ({ quote: sittingQuote } = await createCapturedCanonicalSittingQuote(globalThis.__WINDOW_EQ_DB__, {
      scheduledStart: RESERVED_START, scheduledEnd: RESERVED_END, cityId: CITY, zoneId: ZONE,
      petCount: 1, paymentMode: "prepaid", paymentKey: `window-eq:${key}:${group}`,
    }));
  }
  const body = {
    idempotencyKey: key, scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "Window equality tester", primaryPhone: "+919000000002" },
    pets: [{ sourceId: "weq-pet-1", name: "Bruno", species: "dog" }],
    cityId: CITY, zoneId: ZONE,
    serviceCode,
    packageCode: sittingQuote?.packageCode ?? "training-2-starter",
    packageName: sittingQuote?.packageName ?? "Training",
    scheduledStart: start, scheduledEnd: end,
    provider: { id: PROVIDER, name: "Provider One", model: "full_time" },
    totalAmount: sittingQuote?.totalAmount ?? 1349, amountDueNow: sittingQuote?.amountDueNow ?? 1349,
    payment: { method: "upi", mode: sittingQuote?.paymentMode ?? "prepaid", status: "captured", detail: "customer app" },
    // Non-empty vertical quote ids: without one the handler stops at "a server quote is required"
    // BEFORE the window check, and every case below would pass without ever reaching it.
    pricing: { discount: 0, sittingQuoteId: sittingQuote?.quoteId, trainingQuoteId: "TQ-WINDOW-EQ", boardingQuoteId: "BQ-WINDOW-EQ" },
  };
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("http://localhost/api/canonical-bookings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = JSON.parse(await response.clone().text()); } catch { /* non-JSON body */ }
  return { status: response.status, body: parsed };
}

const VERTICALS = ["dog_training", "boarding", "pet_sitting"];

// --- P1-W01: the same instant, spelled differently, is the same window ------------------------

test("P1-W01 an IST-offset booking window over the engine's UTC reservation is not refused as a mismatch", async () => {
  for (const serviceCode of VERTICALS) {
    const sqlite = freshDb();
    const result = await book(sqlite, { key: `weq-ist-${serviceCode}`, group: `SG-WEQ-IST-${serviceCode}`, serviceCode });

    // The measured production failure, verbatim. This is the assertion that was red.
    assert.notEqual(result.body?.error, VERTICAL_WINDOW_MESSAGE[serviceCode],
      `${serviceCode}: the same instant spelled in IST must not be refused as a different window`);
    assert.notEqual(result.body?.error, GENERIC_WINDOW_MESSAGE,
      `${serviceCode}: nor by the generic window guard`);
    // A 500 also satisfies notEqual, so pin that the handler answered rather than crashed.
    assert.ok(result.status < 500, `${serviceCode}: must not crash (got ${result.status}: ${JSON.stringify(result.body)})`);
  }
});

test("P1-W02 Sitting completes end to end on an IST-offset window", async () => {
  // Sitting is the vertical this harness can carry all the way to a persisted booking, so it proves
  // acceptance rather than only the absence of one refusal.
  const sqlite = freshDb();
  const result = await book(sqlite, { key: "weq-sitting-201", group: "SG-WEQ-SITTING-201", serviceCode: "pet_sitting" });
  assert.equal(result.status, 201, `an IST-spelled window must complete the booking: ${JSON.stringify(result.body)}`);
  const row = sqlite.prepare("SELECT scheduled_start FROM canonical_bookings WHERE idempotency_key=?").get("weq-sitting-201");
  assert.ok(row, "the booking is persisted");
});

// --- P1-W03: NON-VACUITY. A genuinely different instant is still refused ------------------------

test("P1-W03 a genuinely different instant is still refused as a window mismatch", async () => {
  for (const serviceCode of VERTICALS) {
    const sqlite = freshDb();
    // One hour later, spelled in the same IST form. Nothing about the spelling changed — only the
    // instant. If this were green in P1-W01's shape the rule would have been deleted, not fixed.
    const result = await book(sqlite, {
      key: `weq-diff-${serviceCode}`, group: `SG-WEQ-DIFF-${serviceCode}`, serviceCode,
      start: "2026-11-04T11:00:00+05:30", end: "2026-11-04T13:00:00+05:30",
    });
    assert.equal(result.status, 409, `${serviceCode}: a different instant must be refused: ${JSON.stringify(result.body)}`);
    assert.equal(result.body?.error, GENERIC_WINDOW_MESSAGE,
      `${serviceCode}: refused by the window rule specifically`);
  }
});

test("P1-W04 a matching start with a different end is still refused", async () => {
  for (const serviceCode of VERTICALS) {
    const sqlite = freshDb();
    const result = await book(sqlite, {
      key: `weq-end-${serviceCode}`, group: `SG-WEQ-END-${serviceCode}`, serviceCode,
      start: IST_START, end: "2026-11-04T14:00:00+05:30",
    });
    assert.equal(result.status, 409, `${serviceCode}: a stretched window must be refused: ${JSON.stringify(result.body)}`);
    assert.equal(result.body?.error, GENERIC_WINDOW_MESSAGE, `${serviceCode}: refused by the window rule specifically`);
  }
});

// --- P1-W05: unreadable is not "satisfied" -----------------------------------------------------

test("P1-W05 an unparseable booking window is refused by the window guard, not read as matching", async () => {
  for (const serviceCode of VERTICALS) {
    const sqlite = freshDb();
    const result = await book(sqlite, {
      key: `weq-nan-${serviceCode}`, group: `SG-WEQ-NAN-${serviceCode}`, serviceCode,
      start: "sometime tomorrow", end: IST_END,
    });
    assert.equal(result.status, 409, `${serviceCode}: an unreadable window must be refused: ${JSON.stringify(result.body)}`);
    // The service-wide guard is what stops it, for every vertical alike. Green before this change too:
    // pinned so the shared helper's explicit Number.isFinite gate keeps the behaviour it replaced.
    assert.equal(result.body?.error, GENERIC_WINDOW_MESSAGE,
      `${serviceCode}: the service-wide guard must be what refuses an unreadable window`);
  }
});

test("P1-W06 an unparseable RESERVED window is refused too", async () => {
  const sqlite = freshDb();
  seedScheduling(sqlite, "SG-WEQ-BADRES", "pet_sitting");
  sqlite.prepare("UPDATE scheduling_reservations SET scheduled_start=? WHERE group_id=?").run("not-a-date", "SG-WEQ-BADRES");
  const { quote } = await createCapturedCanonicalSittingQuote(globalThis.__WINDOW_EQ_DB__, {
    scheduledStart: RESERVED_START, scheduledEnd: RESERVED_END, cityId: CITY, zoneId: ZONE,
    petCount: 1, paymentMode: "prepaid", paymentKey: "window-eq:badres",
  });
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("http://localhost/api/canonical-bookings", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "weq-badres", scheduleGroupId: "SG-WEQ-BADRES",
      customer: { id: CUSTOMER, name: "Window equality tester", primaryPhone: "+919000000002" },
      pets: [{ sourceId: "weq-pet-1", name: "Bruno", species: "dog" }],
      cityId: CITY, zoneId: ZONE, serviceCode: "pet_sitting",
      packageCode: quote.packageCode, packageName: quote.packageName,
      scheduledStart: IST_START, scheduledEnd: IST_END,
      provider: { id: PROVIDER, name: "Provider One", model: "full_time" },
      totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
      payment: { method: "upi", mode: quote.paymentMode, status: "captured", detail: "customer app" },
      pricing: { discount: 0, sittingQuoteId: quote.quoteId },
    }),
  }));
  const body = JSON.parse(await response.clone().text());
  assert.equal(response.status, 409, `an unreadable stored window must be refused: ${JSON.stringify(body)}`);
  assert.equal(body.error, GENERIC_WINDOW_MESSAGE, "refused by the window rule specifically");
});
