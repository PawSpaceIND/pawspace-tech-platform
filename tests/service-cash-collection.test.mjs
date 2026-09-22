/*
 * Owner decision 2026-09-22 (decision 7 of 10) — a pay-after-service job cannot be completed until the
 * collection is recorded, unless Operations authorises it with a stored reason, and that override does
 * not release the payout.
 *
 * The gap: completion wrote a `provider_settlement_readiness` row at status 'accrued' — the provider's
 * money, owed — and the only thing in the codebase that creates a payment link for a pay-after-service
 * booking (lib/grooming-payment-reconciliation.ts, createPostServicePaymentRequest) refuses to run until
 * that booking is ALREADY completed. The accrual was therefore recorded first and the money asked for
 * afterwards, with nothing in between. A job that was completed and never paid for accrued a payout all
 * the same.
 *
 * Every case drives the real route against a real database and reads the rows back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";

installWorkersHooks("__CASH_DB__", "__CASH_ENV__");

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

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CASH_DB__ = db;
  globalThis.__CASH_ENV__ = env;
  return { sqlite, db };
}

const STAFF = {
  "oai-authenticated-user-email": "ops.admin@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20admin",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const FINANCE = {
  "oai-authenticated-user-email": "finance.manager@pawspace.test",
  "oai-authenticated-user-full-name": "Finance%20manager",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

async function groomingWorld({ paymentMode = "pay_after_service" } = {}) {
  // PAWSPACE_SCHEDULING_ENV="uat" lets ensureExplicitUatCommercialTerm seed a term, so completion can
  // reach its finance resolution and the only thing standing in the way is the gate under test.
  const { sqlite, db } = world({ PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_SCHEDULING_ENV: "uat" });
  const now = Date.now();
  sqlite.exec(`
CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
`);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUS-SESS','blr','Ananya Sharma','9999900601','ananya@example.test',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('BK-SESS','ik-sess','CUS-SESS','[\"PET-1\"]','[\"SRC-1\"]','blr','blr-east','grooming','dog-basic','Bath & Basic','GRP-SESS','PRV-GROOM-A','2026-08-22T04:30:00.000Z','2026-08-22T06:30:00.000Z','in_service',1899,'seed',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-SESS','BK-SESS','GRP-SESS','PRV-GROOM-A','Arun Groomer','full_time','grooming','2026-08-22T04:30:00.000Z','2026-08-22T06:30:00.000Z','in_service',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('PAY-SESS','BK-SESS','CUS-SESS',1899,0,'cash',?,'created','pik-sess',?,?)").run(paymentMode, now, now);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-MKT','ops.admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();
  // Two actors on purpose. 'admin' runs the provider-side job updates; only 'finance' holds
  // payments.manage, which is what authorising a completion without a collection requires.
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-FIN','finance.manager@pawspace.test','Finance manager','finance','active',?,?)").bind(now, now).run();

  // The route's own ensureTables creates the subscription and proof tables; run it once, then seed.
  const route = await import("../app/api/grooming-lifecycle/route.ts");
  await route.POST(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST", headers: { "content-type": "application/json", ...STAFF },
    body: JSON.stringify({ bookingId: "BK-SESS", action: "add_proof", beforePhotoRef: "uat://proof/BK-SESS/before", afterPhotoRef: "uat://proof/BK-SESS/after", checklist: ["bath", "dry"] }),
  }));
  const complete = () => route.POST(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST", headers: { "content-type": "application/json", ...STAFF },
    body: JSON.stringify({ bookingId: "BK-SESS", action: "complete", checklist:fixtureChecklist("complete") }),
  })).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  const post = (body, who = STAFF) => route.POST(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST", headers: { "content-type": "application/json", ...who },
    body: JSON.stringify({ bookingId: "BK-SESS", ...body }),
  })).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  const settlement = () => sqlite.prepare("SELECT status,payout_amount,reason FROM provider_settlement_readiness WHERE booking_id='BK-SESS'").get() ?? null;
  const bookingStatus = () => sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-SESS'").get().status;
  const paymentStatus = () => sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='BK-SESS'").get().status;
  return { sqlite, db, complete, post, settlement, bookingStatus, paymentStatus };
}


test("a pay-after-service job cannot be completed with nothing collected", async () => {
  const { complete, bookingStatus, settlement } = await groomingWorld();

  const refused = await complete();

  assert.equal(refused.status, 409, `expected a refusal: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body?.code, "cash_collection_required");
  assert.match(String(refused.body?.error), /Record the payment you collected/, "the provider is told what to do, not just that it failed");
  assert.equal(bookingStatus(), "in_service", "the job stays open");
  assert.equal(settlement(), null, "and above all no payout accrues for a job nobody has paid for");
});

test("recording the collection lets the job complete, and the payout accrues", async () => {
  const { post, complete, bookingStatus, settlement, paymentStatus } = await groomingWorld();

  const recorded = await post({ action: "record_cash_collection", collectedAmount: 1899, collectionMethod: "cash" });
  assert.equal(recorded.status, 200, `${JSON.stringify(recorded.body)}`);
  assert.equal(recorded.body?.cashCollection?.amount, 1899);
  assert.equal(recorded.body?.cashCollection?.shortfall, 0);
  assert.equal(recorded.body?.cashCollection?.capturesMoney, false, "recording a collection is not a capture");
  assert.equal(paymentStatus(), "created", "and booking_payments is untouched: only a verified gateway capture may mark a payment paid");

  const completed = await complete();
  assert.equal(completed.status, 200, `${JSON.stringify(completed.body)}`);
  assert.equal(bookingStatus(), "completed");
  assert.equal(completed.body?.collection?.via, "recorded_collection");
  assert.equal(settlement().status, "accrued", "a job that was paid for accrues its payout as before");
});

test("Operations can authorise a completion, and the payout stays withheld", async () => {
  const { post, complete, bookingStatus, settlement } = await groomingWorld();

  const authorised = await post({ action: "authorise_completion_without_collection", reason: "Customer disputed the charge; Finance is recovering it separately." }, FINANCE);
  assert.equal(authorised.status, 200, `${JSON.stringify(authorised.body)}`);
  assert.equal(authorised.body?.collectionOverride?.payoutReleased, false);

  const completed = await complete();
  assert.equal(completed.status, 200, `${JSON.stringify(completed.body)}`);
  assert.equal(bookingStatus(), "completed", "the job closes, which is what the override is for");
  assert.equal(completed.body?.collection?.via, "ops_override");
  assert.equal(completed.body?.collection?.payoutReleased, false);

  const readiness = settlement();
  assert.equal(readiness.status, "withheld_pending_collection", "authorising a completion must never quietly authorise a payment to the provider as well");
  assert.notEqual(readiness.status, "accrued");
  assert.match(readiness.reason, /WITHHELD/, "and Finance can read why the payout is held");
  assert.match(readiness.reason, /Customer disputed the charge/, "including the reason Operations gave");
});

test("an override needs a reason worth storing", async () => {
  const { post, complete } = await groomingWorld();
  for (const reason of ["", "   ", "ok", "asked"]) {
    const refused = await post({ action: "authorise_completion_without_collection", reason }, FINANCE);
    assert.equal(refused.status, 400, `'${reason}' is not a reason: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body?.code, "override_reason_required");
  }
  const stillRefused = await complete();
  assert.equal(stillRefused.status, 409, "a refused override authorises nothing");
});

test("a prepaid booking completes exactly as it did before", async () => {
  // Non-vacuity in the other direction: the gate must not have been applied to every completion. A
  // prepaid job has already been paid for and has nothing to record.
  const { complete, bookingStatus, settlement } = await groomingWorld({ paymentMode: "prepaid" });

  const completed = await complete();

  assert.equal(completed.status, 200, `${JSON.stringify(completed.body)}`);
  assert.equal(bookingStatus(), "completed");
  assert.equal(completed.body?.collection?.via, "not_required");
  assert.equal(settlement().status, "accrued");
});

test("a provider cannot record a figure larger than the booking", async () => {
  const { post } = await groomingWorld();
  const refused = await post({ action: "record_cash_collection", collectedAmount: 5000, collectionMethod: "cash" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.code, "collection_exceeds_booking");
  assert.equal(refused.body?.bookingTotal, 1899, "and is told what the booking is worth");
});

test("a collection needs an amount and a method", async () => {
  const { post } = await groomingWorld();
  assert.equal((await post({ action: "record_cash_collection", collectionMethod: "cash" })).body?.code, "collection_amount_required");
  assert.equal((await post({ action: "record_cash_collection", collectedAmount: 1899 })).body?.code, "collection_method_required");
  assert.equal((await post({ action: "record_cash_collection", collectedAmount: 1899, collectionMethod: "bank_transfer_next_week" })).body?.code, "collection_method_required");
});

test("a mistyped amount can be corrected before the job closes, and not after", async () => {
  const { post, complete } = await groomingWorld();

  await post({ action: "record_cash_collection", collectedAmount: 189, collectionMethod: "cash" });
  const corrected = await post({ action: "record_cash_collection", collectedAmount: 1899, collectionMethod: "cash" });
  assert.equal(corrected.status, 200, "a provider who typed the wrong number must be able to fix it");
  assert.equal(corrected.body?.cashCollection?.amount, 1899);

  assert.equal((await complete()).status, 200);
  const afterwards = await post({ action: "record_cash_collection", collectedAmount: 1, collectionMethod: "cash" });
  assert.equal(afterwards.status, 409, "a collection recorded after completion would not have gated anything");
  assert.equal(afterwards.body?.code, "collection_after_completion");
});

test("only Operations can authorise a completion, never the provider on their own job", async () => {
  // The whole point of the override is that somebody other than the person who benefits from it decides.
  const { post, complete, settlement } = await groomingWorld();

  const refused = await post({ action: "authorise_completion_without_collection", reason: "I will collect it later, promise." });

  assert.equal(refused.status, 403, `an actor without payments.manage must be refused: ${JSON.stringify(refused.body)}`);
  assert.equal((await complete()).status, 409, "and nothing was authorised");
  assert.equal(settlement(), null);
});

test("the gateway demands the same permission the route does", async () => {
  // Two layers decide who may call this action. A gateway that asked only for bookings.view would let a
  // provider reach an action the route then refuses - a 403 from the wrong place, and a mapping that
  // would quietly become the real answer if the in-route check were ever refactored away.
  const { requiredPermission } = await import("../lib/api-gateway.ts");
  const ask = (action) => requiredPermission(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: "BK-SESS", action }),
  }));
  assert.equal(await ask("authorise_completion_without_collection"), "payments.manage");
  assert.equal(await ask("mark_paid"), "payments.manage");
  assert.equal(await ask("record_cash_collection"), "bookings.view", "the provider records their own collection");
  assert.equal(await ask("complete"), "bookings.view");
});
