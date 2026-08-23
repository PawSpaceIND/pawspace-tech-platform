import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Booked, collected, refunded and net are four different numbers, and Finance goes wrong the moment any
// two of them are read as one. The trap is that none of them is a single column:
//
//   booked     canonical_bookings.total_amount        what the customer agreed to pay
//   collected  derived — see lib/collected-funds.ts   what actually changed hands, so far
//   refunded   what has gone back                     bounded above by collected, never by booked
//   net        collected - refunded                   the only one that is money we still hold
//
// Reading booking_payments.amount as "collected" is the specific mistake the refund cap was built to
// stop: a stay paid in half, paid not at all, or whose payment failed would have been refundable for
// its full price. This suite executes each state that pulls the four apart and asserts they stay apart.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const BOOKED = 10000;

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,total_amount REAL,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (booking_id TEXT PRIMARY KEY,amount REAL NOT NULL,amount_due_now REAL NOT NULL,status TEXT NOT NULL,method TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT NOT NULL,customer_id TEXT NOT NULL,total_amount REAL NOT NULL,paid_now_amount REAL NOT NULL,balance_amount REAL NOT NULL,balance_due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending_balance',paid_at INTEGER,payment_ref TEXT)");
  return { sqlite, db };
}

function book(sqlite, { id = "BKG-1", total = BOOKED, paymentStatus, dueNow = total, amount = total } = {}) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,service_code,status,total_amount,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, "CUS-1", "PRV-1", "boarding", "confirmed", total, Date.now());
  if (paymentStatus) {
    sqlite.prepare("INSERT INTO booking_payments (booking_id,amount,amount_due_now,status,method) VALUES (?,?,?,?, 'payment_link')")
      .run(id, amount, dueNow, paymentStatus);
  }
  return id;
}

const split = (sqlite, id, { paidNow, balance, status }) => sqlite
  .prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status) VALUES (?,'boarding','CUS-1',?,?,?,?,?)")
  .run(id, paidNow + balance, paidNow, balance, Date.now() + 86_400_000, status);

const collected = async (db, id) => (await import("../lib/collected-funds.ts")).collectedForBooking(db, id);
const bookedOf = (sqlite, id) => Number(sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(id).total_amount);

// --- the four measures pulled apart -------------------------------------------------------------------

test("prepaid and captured: booked equals collected, refunded is zero, net equals collected", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured" });
  const taken = await collected(db, id);
  assert.equal(bookedOf(sqlite, id), BOOKED);
  assert.equal(taken, BOOKED);
  assert.equal(BOOKED - 0, taken, "net with no refund is the collected figure");
});

test("NEGATIVE: a booking whose payment was only CREATED has booked money but zero collected", async () => {
  // The sharpest collapse. total_amount is 10,000 and a naive read of booking_payments.amount agrees —
  // but nothing was ever taken, so any positive refund would be inventing money.
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "created" });
  assert.equal(bookedOf(sqlite, id), BOOKED, "the booking is still worth its price");
  assert.equal(await collected(db, id), 0, "and none of it has been collected");
});

test("NEGATIVE: a failed payment collects nothing", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "failed" });
  assert.equal(await collected(db, id), 0);
});

test("NEGATIVE: a booking with no payment row at all collects nothing", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, {});
  assert.equal(bookedOf(sqlite, id), BOOKED);
  assert.equal(await collected(db, id), 0);
});

test("a 50/50 split collects only the first instalment until the balance is paid", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured", dueNow: 5000 });
  split(sqlite, id, { paidNow: 5000, balance: 5000, status: "pending_balance" });
  assert.equal(bookedOf(sqlite, id), BOOKED, "booked is the whole stay");
  assert.equal(await collected(db, id), 5000, "collected is only what has been taken");
});

test("once the balance is settled, collected rises to the booked amount", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured", dueNow: 5000 });
  split(sqlite, id, { paidNow: 5000, balance: 5000, status: "paid" });
  assert.equal(await collected(db, id), BOOKED);
});

test("NEGATIVE: a date change that rewrites amount_due_now cannot inflate collected", async () => {
  // The documented trap: the date-change path overwrites booking_payments.amount_due_now with the new
  // full total, so on a split booking that column claims more than was ever taken. The schedule wins.
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured", dueNow: 5000 });
  split(sqlite, id, { paidNow: 5000, balance: 5000, status: "pending_balance" });
  sqlite.prepare("UPDATE booking_payments SET amount_due_now=?, amount=? WHERE booking_id=?").run(14000, 14000, id);
  assert.equal(await collected(db, id), 5000, "still only the instalment that was actually paid");
});

test("NEGATIVE: a deposit taken without a schedule collects the deposit, not the full price", async () => {
  // The bound that matters in the other direction. With no stay_payment_schedules row, the instalment
  // actually taken is amount_due_now; reading booking_payments.amount instead would over-report
  // collections and raise the refund ceiling above the money that was ever received.
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured", dueNow: 3000, amount: BOOKED });
  assert.equal(bookedOf(sqlite, id), BOOKED);
  assert.equal(await collected(db, id), 3000, "only the deposit was taken");
});

test("NEGATIVE: a mutated due-now column cannot report more than the booking is worth", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured", dueNow: 99999, amount: BOOKED });
  assert.equal(await collected(db, id), BOOKED, "collected is bounded by the booking's own amount");
});

// --- refunded and net ---------------------------------------------------------------------------------

test("a refunded booking still counts as having collected money", async () => {
  // 'refunded' does NOT mean nothing was taken — money changed hands and then went back. Treating it as
  // zero collected would under-report real collections and, worse, would let a second refund through.
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "refunded" });
  const taken = await collected(db, id);
  assert.equal(taken, BOOKED, "collections are historical fact, not current balance");
  const refunded = BOOKED;
  assert.equal(taken - refunded, 0, "net after a full refund is zero — which is not the same as never collecting");
});

test("partial refund keeps all four measures distinct", async () => {
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "partially_refunded" });
  const booked = bookedOf(sqlite, id);
  const taken = await collected(db, id);
  const refunded = 2500;
  const net = taken - refunded;
  assert.equal(booked, 10000);
  assert.equal(taken, 10000);
  assert.equal(net, 7500);
  assert.equal(new Set([booked, refunded, net]).size, 3, "three genuinely different numbers");
});

test("the refund ceiling is collected, never booked", async () => {
  // A half-paid stay may not be refunded for the whole stay. This is the invariant the cap exists for.
  const { sqlite, db } = world();
  const id = book(sqlite, { paymentStatus: "captured", dueNow: 5000 });
  split(sqlite, id, { paidNow: 5000, balance: 5000, status: "pending_balance" });
  const ceiling = await collected(db, id);
  assert.equal(ceiling, 5000);
  assert.ok(ceiling < bookedOf(sqlite, id), "refunding the booked amount here would return money never taken");
});

test("the collected-status list is exactly the four states where money moved", async () => {
  const { COLLECTED_PAYMENT_STATUSES } = await import("../lib/collected-funds.ts");
  assert.deepEqual([...COLLECTED_PAYMENT_STATUSES].sort(),
    ["captured", "paid", "partially_refunded", "refunded"].sort());
  for (const state of ["created", "failed", "pending", "cancelled"]) {
    assert.ok(!COLLECTED_PAYMENT_STATUSES.includes(state), `${state} must never count as collected`);
  }
});
