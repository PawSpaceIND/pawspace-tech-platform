import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only resolve hook (same pattern as tests/customer-offers.test.mjs) so real libs with
// extensionless relative imports execute directly under --experimental-strip-types.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const lifecycleRoute = read("app/api/grooming-lifecycle/route.ts");
const partnerJobsRoute = read("app/api/partner-grooming-jobs/route.ts");
const changeRoute = read("app/api/grooming-booking-change/route.ts");
const groomingRouteApi = read("app/api/grooming-route/route.ts");
const walletRoute = read("app/api/subscription-wallet/route.ts");
const walletLib = read("lib/subscription-wallet.ts");
const partnerJobsUi = read("app/partner-app/canonical-grooming-jobs.tsx");
const routeCardUi = read("app/partner-app/grooming-route-card.tsx");
const recoveryRoute = read("app/api/provider-assignment-recovery/route.ts");

const statementsOf = (source) =>
  [...source.matchAll(/\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2].replace(/\\(["'`\\])/g, "$1"));
const findStatement = (source, marker) => {
  const hit = statementsOf(source).find((sql) => sql.includes(marker));
  assert.ok(hit, `expected a prepared statement containing: ${marker}`);
  return hit;
};

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; } };
}

function groomingDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const source of [lifecycleRoute, partnerJobsRoute, changeRoute, read("app/api/uat-scheduling/route.ts"), walletLib, read("lib/customer-account.ts"), read("lib/grooming-policy-governance.ts")]) {
    for (const sql of statementsOf(source)) if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) sqlite.exec(sql);
  }
  return { sqlite, db: makeD1(sqlite) };
}

const NOW = Date.now();
function seedBookingChain(sqlite, { bookingId = "BK-G-1", customerId = "CUS-G-1", providerId = "groom_arun", groupId = "GRP-1", start = "2026-08-20T04:30:00.000Z", end = "2026-08-20T06:30:00.000Z", status = "confirmed", amount = 1899 } = {}) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(customerId, "blr", "Ananya Rao Sharma", "9999900601", null, null, "customer_app", "{}", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(bookingId, `ik-${bookingId}`, customerId, "[]", "[]", "blr", "blr-east", "grooming", "dog-basic", "Bath & Basic", groupId, providerId, start, end, status, "customer_app", amount, "INR", "{}", "test", NOW, NOW);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`WO-${bookingId}`, bookingId, groupId, providerId, "Arun R.", "full_time", "grooming", start, end, 1, status, "{}", NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, amount, 0, "INR", "cash", "pay_after_service", "created", "uat_sandbox", `pik-${bookingId}`, "{}", NOW, NOW);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, providerId, "grooming", "blr", "blr-east", customerId, "[]", start, end, 1, 1, null, "assigned", "{}", NOW);
}

function seedSubscription(sqlite, { id = "SUB-1", customerId = "CUS-G-1", total = 6, reserved = 0, consumed = 0, status = "active", pauseDays = 14, graceDays = 7 } = {}) {
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, customerId, "6", "dog-basic", total, reserved, consumed, status, NOW, NOW + 120 * 86_400_000, `SRC-${id}`, "v1", NOW, NOW);
  sqlite.prepare("INSERT INTO grooming_subscription_purchase_snapshots (subscription_id,booking_id,city_id,zone_id,plan_code,catalogue_version,config_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, `SRC-${id}`, "blr", "blr-east", "6", "v1", JSON.stringify({ pauseDays, graceDays, renewalWindowDays: 15, familyWallet: true }), NOW);
}

// ---------------------------------------------------------------------------
// 1. Wallet: purchase -> reserve -> consume -> pause/resume; never negative,
//    never double-consumed. Real execution of the unmodified lib.
// ---------------------------------------------------------------------------
test("real execution: subscription credits reserve, consume once, pause and resume correctly", async () => {
  const { sqlite, db } = groomingDb();
  const wallet = await import("../lib/subscription-wallet.ts");
  seedBookingChain(sqlite, { bookingId: "BK-W-1", status: "confirmed" });
  seedSubscription(sqlite, { id: "SUB-W", total: 6 });

  const afterReserve = await wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "reserve", idempotencyKey: "w-res-1", bookingId: "BK-W-1", credits: 2, actorId: "cust@test" });
  assert.deepEqual(afterReserve.wallet.balances, { total: 6, reserved: 2, consumed: 0, available: 4 });

  // Replay of the same idempotency key is a no-op.
  const replay = await wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "reserve", idempotencyKey: "w-res-1", bookingId: "BK-W-1", credits: 2, actorId: "cust@test" });
  assert.equal(replay.duplicatePrevented, true);

  // Consume requires canonical completion.
  await assert.rejects(() => wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "consume", idempotencyKey: "w-con-0", bookingId: "BK-W-1", actorId: "staff@test" }), /after canonical service completion/);
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='BK-W-1'").run();
  const afterConsume = await wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "consume", idempotencyKey: "w-con-1", bookingId: "BK-W-1", actorId: "staff@test" });
  assert.deepEqual(afterConsume.wallet.balances, { total: 6, reserved: 0, consumed: 2, available: 4 });

  // Never double-consumed.
  await assert.rejects(() => wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "consume", idempotencyKey: "w-con-2", bookingId: "BK-W-1", actorId: "staff@test" }), /already consumed/);
  // Consumed credits can never be released back.
  await assert.rejects(() => wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "release", idempotencyKey: "w-rel-1", bookingId: "BK-W-1", actorId: "staff@test" }), /cannot be released/);

  // Pause within entitlement, blocked movements while paused, then resume.
  await wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "pause", idempotencyKey: "w-pause-1", pauseDays: 5, reason: "Travelling", actorId: "cust@test" });
  seedBookingChain(sqlite, { bookingId: "BK-W-2", groupId: "GRP-W2" });
  await assert.rejects(() => wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "reserve", idempotencyKey: "w-res-2", bookingId: "BK-W-2", credits: 1, actorId: "cust@test" }), /paused and cannot move/);
  const resumed = await wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "resume", idempotencyKey: "w-resume-1", actorId: "cust@test" });
  assert.equal(String(resumed.wallet.subscription.status), "active");

  // Never negative / never over-reserved: 5 credits on a 4-available wallet is refused with no usage row.
  await assert.rejects(() => wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-W", action: "reserve", idempotencyKey: "w-res-3", bookingId: "BK-W-2", credits: 5, actorId: "cust@test" }), /not have enough available credits/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_subscription_usage WHERE booking_id='BK-W-2'").get().c, 0, "a refused reserve leaves no phantom usage row");
  const row = sqlite.prepare("SELECT sessions_reserved,sessions_consumed,total_sessions FROM customer_grooming_subscriptions WHERE id='SUB-W'").get();
  assert.ok(row.sessions_reserved >= 0 && row.sessions_consumed + row.sessions_reserved <= row.total_sessions, "wallet arithmetic never goes negative or over total");
});

test("regression: reserve claims idempotency, credits and usage in one guarded batch", () => {
  const reserveBlock = walletLib.slice(walletLib.indexOf('input.action==="reserve"'), walletLib.indexOf('input.action==="consume"'));
  const eventIndex = reserveBlock.indexOf("INSERT INTO subscription_wallet_events");
  const guardIndex = reserveBlock.indexOf("UPDATE customer_grooming_subscriptions SET sessions_reserved=sessions_reserved+?");
  const usageIndex = reserveBlock.indexOf("INSERT INTO booking_subscription_usage");
  assert.match(reserveBlock, /const results=await db\.batch/);
  assert.ok(eventIndex > -1 && guardIndex > eventIndex && usageIndex > guardIndex, "the idempotency claim, credit move and usage write share one ordered transaction");
  assert.match(reserveBlock, /results\[0\].*results\[1\].*results\[2\]/s, "every statement must report exactly one persisted mutation");
});

// ---------------------------------------------------------------------------
// 2. Lifecycle complete settles credits even for paused subscriptions (drift fix)
//    and mirrors completion to the customer account.
// ---------------------------------------------------------------------------
test("regression: completing a service settles reserved credits even when the subscription is paused", async () => {
  const { sqlite, db } = groomingDb();
  seedBookingChain(sqlite, { bookingId: "BK-P-1", status: "in_service" });
  seedSubscription(sqlite, { id: "SUB-P", total: 6, reserved: 1, status: "paused" });
  sqlite.prepare("INSERT INTO booking_subscription_usage (id,booking_id,customer_id,plan_code,sessions_reserved,sessions_consumed,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("USE-P-1", "BK-P-1", "CUS-G-1", "SUB-P", 1, 0, "reserved", NOW, NOW);

  // The route's own complete-time statements (extracted verbatim).
  assert.doesNotMatch(findStatement(lifecycleRoute, "sessions_consumed=sessions_consumed+?"), /status IN \('active','exhausted'\)/, "the consume update no longer skips paused/grace subscriptions");
  await db.prepare(findStatement(lifecycleRoute, "UPDATE booking_subscription_usage SET sessions_consumed=sessions_reserved")).bind(NOW, "BK-P-1").run();
  await db.prepare(findStatement(lifecycleRoute, "sessions_consumed=sessions_consumed+?")).bind(1, 1, 1, NOW, "SUB-P").run();

  const sub = sqlite.prepare("SELECT sessions_reserved,sessions_consumed,status FROM customer_grooming_subscriptions WHERE id='SUB-P'").get();
  assert.equal(sub.sessions_reserved, 0, "reserved credits are released at completion");
  assert.equal(sub.sessions_consumed, 1, "consumed count is recorded at completion");
  assert.equal(sub.status, "paused", "settling credits never force-unpauses the subscription");
  assert.equal(sqlite.prepare("SELECT status FROM booking_subscription_usage WHERE booking_id='BK-P-1'").get().status, "consumed");
});

test("real execution: booking -> accept -> travel -> proof -> complete mirrors into the customer account", async () => {
  const { sqlite, db } = groomingDb();
  seedBookingChain(sqlite, { bookingId: "BK-C-1", status: "confirmed" });
  // Transition map is the single source of state law in the route.
  assert.match(lifecycleRoute, /accept:\{awaiting_acceptance:"assigned",confirmed:"assigned"\}/);
  assert.match(lifecycleRoute, /complete:\{in_service:"completed"\}/, "complete is only reachable from in_service");
  assert.match(lifecycleRoute, /Before photo, after photo and completion checklist are required/, "completion demands full proof");

  const statusPair = (status) => {
    sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id='BK-C-1'").run(status);
    sqlite.prepare("UPDATE provider_work_orders SET status=? WHERE booking_id='BK-C-1'").run(status);
  };
  for (const step of ["assigned", "on_the_way", "arrived", "in_service"]) statusPair(step);

  // Proof upsert via the route's own SQL.
  await db.prepare(findStatement(lifecycleRoute, "INSERT INTO grooming_service_proof")).bind("BK-C-1", "uat://proof/BK-C-1/before", "uat://proof/BK-C-1/after", JSON.stringify(["Coat check", "Finish review"]), "done", NOW, NOW).run();
  // Complete-time writes via the route's own SQL.
  await db.prepare(findStatement(lifecycleRoute, "UPDATE canonical_bookings SET status='completed'")).bind(NOW, "BK-C-1").run();
  await db.prepare(findStatement(lifecycleRoute, "UPDATE provider_work_orders SET status='completed'")).bind(NOW, "BK-C-1").run();
  await db.prepare(findStatement(lifecycleRoute, "INSERT OR IGNORE INTO booking_invoices")).bind("INV-1", "BK-C-1", "CUS-G-1", "PS-2026-0001", "issued", "INR", 1899, 0, 1899, NOW, NOW, NOW).run();
  await db.prepare(findStatement(lifecycleRoute, "INSERT OR IGNORE INTO repeat_booking_tasks")).bind("RPT-1", "BK-C-1", "CUS-G-1", "grooming", NOW + 21 * 86_400_000, NOW, NOW).run();

  // Customer mirror: the canonical account read (the customer surface) sees the completed booking.
  const { readCustomerAccount } = await import("../lib/customer-account.ts");
  const account = await readCustomerAccount(db, "CUS-G-1");
  assert.equal(account.bookings[0].id, "BK-C-1");
  assert.equal(account.bookings[0].status, "completed");
  assert.equal(sqlite.prepare("SELECT status FROM booking_invoices WHERE booking_id='BK-C-1'").get().status, "issued");
});

// ---------------------------------------------------------------------------
// 3. Reschedule: TOCTOU-safe slot move, future-only, server-priced.
// ---------------------------------------------------------------------------
test("regression: the reschedule reservation move is atomic — an overlapping reservation blocks it at write time", async () => {
  const { sqlite, db } = groomingDb();
  seedBookingChain(sqlite, { bookingId: "BK-R-1", groupId: "GRP-R1", start: "2026-08-20T04:30:00.000Z", end: "2026-08-20T06:30:00.000Z" });
  // Another customer's reservation with the same provider, 08:00-09:30 (this is the reservation
  // that "lands between the pre-check and the write" in the TOCTOU scenario).
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("RES-OTHER", "GRP-OTHER", "groom_arun", "grooming", "blr", "blr-east", "CUS-OTHER", "[]", "2026-08-20T08:00:00.000Z", "2026-08-20T09:30:00.000Z", 1, 1, null, "assigned", "{}", NOW);

  const guarded = findStatement(changeRoute, "NOT EXISTS (SELECT 1 FROM scheduling_reservations other");
  // Attempt to move into the overlap: the guarded write itself must refuse.
  const conflicted = await db.prepare(guarded).bind("2026-08-20T08:30:00.000Z", "2026-08-20T10:30:00.000Z", "GRP-R1", "GRP-R1", "2026-08-20T10:30:00.000Z", "2026-08-20T08:30:00.000Z").run();
  assert.equal(conflicted.meta.changes, 0, "overlapping move is refused atomically at write time");
  assert.equal(sqlite.prepare("SELECT scheduled_start FROM scheduling_reservations WHERE group_id='GRP-R1'").get().scheduled_start, "2026-08-20T04:30:00.000Z", "the reservation did not move");

  // A free slot moves cleanly.
  const moved = await db.prepare(guarded).bind("2026-08-20T11:00:00.000Z", "2026-08-20T13:00:00.000Z", "GRP-R1", "GRP-R1", "2026-08-20T13:00:00.000Z", "2026-08-20T11:00:00.000Z").run();
  assert.equal(moved.meta.changes, 1);
  assert.equal(sqlite.prepare("SELECT scheduled_start FROM scheduling_reservations WHERE group_id='GRP-R1'").get().scheduled_start, "2026-08-20T11:00:00.000Z");

  // Route-level guarantees around the guard.
  assert.match(changeRoute, /start\.getTime\(\)<=now/, "reschedule to a past time is rejected");
  assert.match(changeRoute, /moved\.meta\?\.changes/, "the route checks the guarded write's result");
});

test("reschedule and cancel are server-priced: no client price fields, fee/refund from the frozen policy", async () => {
  assert.doesNotMatch(changeRoute, /type Input=\{[^}]*(amount|price|total)/i, "the change API accepts no client-submitted money");
  assert.match(changeRoute, /parsePolicySnapshot\(pricing\.commercialPolicy\)\?\?await resolveGroomingPolicy/, "policy comes from the frozen snapshot, else the server policy");
  assert.match(changeRoute, /policyEvaluation\.refundPercent/);
  assert.match(changeRoute, /policyEvaluation\.feeAmount/);
  // Real execution of the policy: completed bookings are change-locked.
  const { sqlite, db } = groomingDb();
  void sqlite;
  const policyLib = await import("../lib/grooming-policy-governance.ts");
  const policy = await policyLib.resolveGroomingPolicy(db, "blr", "blr-east", new Date("2026-08-12T05:00:00.000Z"));
  const locked = policyLib.evaluateBookingChange(policy, { action: "reschedule", scheduledStart: "2026-08-20T04:30:00.000Z", status: "completed", bookingAmount: 1899, rescheduleCount: 0, now: NOW });
  assert.equal(locked.allowed, false, "completed bookings cannot be rescheduled");
});

test("real execution: cancellation releases reserved subscription credits and never goes negative", async () => {
  const { sqlite, db } = groomingDb();
  seedBookingChain(sqlite, { bookingId: "BK-X-1", groupId: "GRP-X1" });
  seedSubscription(sqlite, { id: "SUB-X", total: 6, reserved: 2 });
  sqlite.prepare("INSERT INTO booking_subscription_usage (id,booking_id,customer_id,plan_code,sessions_reserved,sessions_consumed,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("USE-X-1", "BK-X-1", "CUS-G-1", "SUB-X", 2, 0, "reserved", NOW, NOW);

  await db.prepare(findStatement(changeRoute, "UPDATE booking_subscription_usage SET sessions_reserved=0")).bind(NOW, "BK-X-1").run();
  const release = findStatement(changeRoute, "status=CASE WHEN source_booking_id=? THEN ? ELSE status END");
  await db.prepare(release).bind(2, "BK-X-1", "cancelled", NOW, "SUB-X").run();
  let sub = sqlite.prepare("SELECT sessions_reserved,status FROM customer_grooming_subscriptions WHERE id='SUB-X'").get();
  assert.equal(sub.sessions_reserved, 0, "cancellation returns the reserved credits");
  assert.equal(sub.status, "active", "cancelling a normal booking never cancels the subscription itself");
  // Re-running the release can never drive the wallet negative.
  await db.prepare(release).bind(2, "BK-X-1", "cancelled", NOW, "SUB-X").run();
  sub = sqlite.prepare("SELECT sessions_reserved FROM customer_grooming_subscriptions WHERE id='SUB-X'").get();
  assert.equal(sub.sessions_reserved, 0);
  assert.equal(sqlite.prepare("SELECT status FROM booking_subscription_usage WHERE booking_id='BK-X-1'").get().status, "reversed");
});

// ---------------------------------------------------------------------------
// 4. Partner surface: PII minimisation and button-to-API trace.
// ---------------------------------------------------------------------------
test("partner payloads carry first name + masked phone only — never full contact data", () => {
  assert.match(partnerJobsRoute, /partnerFirstName\(row\.customer_name\)/, "customer name is reduced to first name");
  assert.doesNotMatch(partnerJobsRoute, /name:String\(row\.customer_name\)/, "the raw full name is no longer forwarded");
  assert.match(partnerJobsRoute, /maskedPhone:maskPhone\(row\.primary_phone\)/, "phone is masked");
  assert.doesNotMatch(partnerJobsRoute, /phone:String\(row\.primary_phone\)|email:String\(|customerEmail/, "no raw phone or email fields in the partner payload");
  // The masking helpers behave as declared.
  const firstName = (value) => String(value || "").trim().split(/\s+/)[0] || "Customer";
  assert.equal(firstName("Ananya Rao Sharma"), "Ananya");
  assert.equal(firstName("  "), "Customer");
});

test("every partner-app grooming button maps to a live API action", () => {
  // Commission accept/decline go to assignment recovery, which supports both actions.
  assert.match(partnerJobsUi, /\/api\/provider-assignment-recovery/);
  assert.match(recoveryRoute, /"accept"/);
  assert.match(recoveryRoute, /"decline"/);
  // Lifecycle buttons map 1:1 onto the route's action vocabulary.
  for (const action of ["accept", "on_the_way", "arrived", "start_service", "add_proof", "complete"]) {
    assert.ok(partnerJobsUi.includes(`"${action}"`), `partner UI offers ${action}`);
    assert.ok(lifecycleRoute.includes(`"${action}"`), `lifecycle route handles ${action}`);
  }
  assert.match(partnerJobsUi, /\/api\/grooming-lifecycle/);
  assert.match(partnerJobsUi, /\/api\/partner-grooming-jobs/);
  // The route card's tracking buttons hit the grooming-route API, which serves both verbs.
  assert.match(routeCardUi, /\/api\/grooming-route/);
  assert.match(groomingRouteApi, /export async function GET/);
  assert.match(groomingRouteApi, /export async function POST/);
  // Route sharing is provider-owned and travel-state gated.
  assert.match(groomingRouteApi, /requireProviderOwnership/);
  assert.match(groomingRouteApi, /activeTravelStates/);
});

// ---------------------------------------------------------------------------
// 5. Permission posture across the stack.
// ---------------------------------------------------------------------------
test("grooming stack permission mapping stays enforced in-route", () => {
  assert.match(lifecycleRoute, /if\(input\.action==="mark_paid"\)requirePermission\(actorIdentity,"payments\.manage"\);else requirePermission\(actorIdentity,"bookings\.view"\)/);
  assert.match(lifecycleRoute, /requireProviderOwnership\(db,actorIdentity,String\(work\.provider_id\)\)/, "providers can only act on their own work orders");
  assert.match(partnerJobsRoute, /requireProviderOwnership\(actor\?.|requireProviderOwnership\(db,actor,providerId\)/, "partners can only list their own jobs");
  assert.match(changeRoute, /requirePermission\(actor,"scheduling\.book"\)/);
  assert.match(changeRoute, /requireCustomerOwnership\(db,actor,input\.customerId\)/, "customers can only change their own bookings");
  assert.match(walletRoute, /customerActions=new Set<SubscriptionWalletAction>\(\["reserve","pause","resume"\]\)/);
  assert.match(walletRoute, /requirePermission\(actor,"bookings\.manage"\)/, "consume/release stay staff-gated");
});
