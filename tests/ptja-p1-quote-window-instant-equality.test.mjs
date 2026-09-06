import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F31 (second half) — the QUOTE's window is an instant too.
//
// Every governed vertical re-checks, at booking time, that the window has not changed since the quote
// was priced. Dog Walking and Pet Taxi already compare those windows as instants — lib/walking-
// governance.ts:17 and lib/taxi-governance.ts:17 each carry a private `sameInstant`. Training,
// Boarding and Sitting, written earlier, compared them with `!==` on strings.
//
// Measured by driving the canonical Sitting path with the reservation's UTC spelling in the quote and
// the customer app's IST spelling in the booking — the exact pairing app/training/page.tsx produces:
//     409 {"error":"Sitting care window changed after quote"}
// for two windows that are the same moment. The check answers a question about spelling when it is
// meant to answer one about time.
//
// These drive the REAL exported governance functions against a real SQLite database. Nothing here
// matches source text.
// ---------------------------------------------------------------------------

installWorkersHooks("__QUOTE_WINDOW_DB__", "__QUOTE_WINDOW_ENV__");

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
const freshDb = () => makeD1(new DatabaseSync(":memory:"));

/** The same two moments, spelled the two ways the platform actually produces. */
const UTC_START = "2026-11-04T04:30:00.000Z", UTC_END = "2026-11-04T06:30:00.000Z";
const IST_START = "2026-11-04T10:00:00+05:30", IST_END = "2026-11-04T12:00:00+05:30";
/** A genuinely different moment, spelled the same way as IST_START. The non-vacuity control. */
const OTHER_START = "2026-11-04T11:00:00+05:30", OTHER_END = "2026-11-04T13:00:00+05:30";

/** Runs a governance call and reports what it refused with, without letting a crash read as a pass. */
async function refusal(run) {
  try { return { ok: true, value: await run() }; }
  catch (error) {
    if (!(error instanceof Response)) throw error;   // a real crash must fail the test, not satisfy it
    let message = "";
    try { const body = JSON.parse(await error.clone().text()); message = String(body.error ?? ""); }
    catch { message = await error.clone().text(); }
    return { ok: false, status: error.status, message };
  }
}

// --- Training ---------------------------------------------------------------------------------

async function trainingCase(start) {
  const db = freshDb();
  const { createTrainingQuote, captureTrainingQuoteSandbox, governTrainingBooking } =
    await import("../lib/training-commercial-governance.ts");
  // Priced against the engine's UTC spelling, exactly as a reservation holds it.
  const quote = await createTrainingQuote(db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: UTC_START, paymentMode: "prepaid" });
  await captureTrainingQuoteSandbox(db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: "p1-training-window" });
  return refusal(() => governTrainingBooking(db, {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 1, scheduledStart: start,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
    paymentMode: "prepaid", paymentStatus: "captured", reservationCount: quote.sessions,
  }));
}

test("P1-Q01 Training accepts the quoted window spelled in IST", async () => {
  const result = await trainingCase(IST_START);
  assert.equal(result.ok, true, `the same instant must not read as a changed schedule: ${result.status} ${result.message}`);
});

test("P1-Q02 Training still refuses a genuinely different start", async () => {
  const result = await trainingCase(OTHER_START);
  assert.equal(result.ok, false, "a different instant must still be refused");
  assert.equal(result.message, "Training schedule changed after quote");
  assert.equal(result.status, 409);
});

test("P1-Q03 Training refuses an unreadable start rather than reading it as unchanged", async () => {
  const result = await trainingCase("sometime tomorrow");
  assert.equal(result.ok, false, "an unparseable window is not evidence the window is unchanged");
  assert.equal(result.message, "Training schedule changed after quote");
});

// --- Boarding ---------------------------------------------------------------------------------

async function boardingCase(start, end) {
  const db = freshDb();
  const { createBoardingQuote, governBoardingBooking } = await import("../lib/boarding-governance.ts");
  const quote = await createBoardingQuote(db, { packageCode: "boarding-4h", petCount: 1, scheduledStart: UTC_START, scheduledEnd: UTC_END, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });
  return refusal(() => governBoardingBooking(db, {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 1, scheduledStart: start, scheduledEnd: end,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
    paymentMode: "prepaid", paymentStatus: "captured", reservationCount: 1,
    providerId: "host_maya_rohan", cityId: "blr", zoneId: "blr-east",
    species: ["dog"], vaccinationStatuses: ["verified"],
  }));
}

const BOARDING_WINDOW_MESSAGE = "Boarding stay window changed after quote";

test("P1-Q04 Boarding accepts the quoted stay window spelled in IST", async () => {
  const result = await boardingCase(IST_START, IST_END);
  assert.equal(result.ok, true, `the same instant must not read as a changed stay window: ${result.status} ${result.message}`);
});

test("P1-Q05 Boarding still refuses a genuinely different stay window", async () => {
  assert.equal((await boardingCase(OTHER_START, OTHER_END)).message, BOARDING_WINDOW_MESSAGE, "a different check-in is refused");
  assert.equal((await boardingCase(IST_START, OTHER_END)).message, BOARDING_WINDOW_MESSAGE, "a different check-out is refused");
  assert.equal((await boardingCase("sometime tomorrow", IST_END)).message, BOARDING_WINDOW_MESSAGE, "an unreadable check-in is refused");
});

// --- Sitting ----------------------------------------------------------------------------------

async function sittingCase(start, end) {
  const db = freshDb();
  const { createCapturedCanonicalSittingQuote } = await import("./helpers/canonical-sitting-commercial.mjs");
  const { governSittingBooking } = await import("../lib/sitting-governance.ts");
  const { quote } = await createCapturedCanonicalSittingQuote(db, {
    scheduledStart: UTC_START, scheduledEnd: UTC_END, cityId: "blr", zoneId: "blr-east",
    petCount: 1, paymentMode: "prepaid", paymentKey: "p1-sitting-window",
  });
  return refusal(() => governSittingBooking(db, {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 1, cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: end,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode, paymentStatus: "captured", reservationCount: 1,
  }));
}

const SITTING_WINDOW_MESSAGE = "Sitting care window changed after quote";

test("P1-Q06 Sitting accepts the quoted care window spelled in IST", async () => {
  const result = await sittingCase(IST_START, IST_END);
  assert.equal(result.ok, true, `the same instant must not read as a changed care window: ${result.status} ${result.message}`);
});

test("P1-Q07 Sitting still refuses a genuinely different care window", async () => {
  assert.equal((await sittingCase(OTHER_START, OTHER_END)).message, SITTING_WINDOW_MESSAGE, "a different start is refused");
  assert.equal((await sittingCase(IST_START, OTHER_END)).message, SITTING_WINDOW_MESSAGE, "a different end is refused");
  assert.equal((await sittingCase("sometime tomorrow", IST_END)).message, SITTING_WINDOW_MESSAGE, "an unreadable start is refused");
});
