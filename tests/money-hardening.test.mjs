import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim and whose other keys read a mutable test env object, so the REAL
// money routes and libs (incl. the webhook gate) execute unmodified.
const CF_STUB = "data:text/javascript,export const env=new Proxy({},{get:(t,k)=>k===\"DB\"?globalThis.__MONEY_DB__:(globalThis.__MONEY_ENV__??{})[k]});";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
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
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function freshDb(env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: "uat-test-secret" }) {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__MONEY_DB__ = makeD1(sqlite);
  globalThis.__MONEY_ENV__ = env;
}

const webhookRoute = await import("../app/api/razorpay-webhook/route.ts");
const reconciliationRoute = await import("../app/api/payment-reconciliation/route.ts");
const stayBalanceRoute = await import("../app/api/stay-balance/route.ts");
const walletRoute = await import("../app/api/pawspace-wallet/route.ts");
const pointsRoute = await import("../app/api/paw-points/route.ts");
const couponRoute = await import("../app/api/coupon-governance/route.ts");
const referralRoute = await import("../app/api/referral-governance/route.ts");
const subscriptionWalletRoute = await import("../app/api/subscription-wallet/route.ts");
const missionRoute = await import("../app/api/revenue-mission-control/route.ts");
const { creditWallet, redeemWalletForBooking, walletBalance } = await import("../lib/pawspace-wallet-governance.ts");
const { redeemPoints, runPawPointsEarnSweep, pawPointsBalance } = await import("../lib/paw-points-governance.ts");
const { grantGoodwillPoints } = await import("../lib/paw-points-governance.ts");
const { quoteCoupon, consumeCouponQuote } = await import("../lib/coupon-governance.ts");
const { mutateSubscriptionWallet } = await import("../lib/subscription-wallet.ts");
const { payStayBalance } = await import("../lib/stay-split-payments.ts");
const { linkGatewayOrder } = await import("../lib/grooming-payment-reconciliation.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
const call = async (handler, method, bodyOrQuery, headers = {}) => {
  const url = `http://localhost/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url, { headers })
    : new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
};
const callAs = async (handler, method, bodyOrQuery, email) => {
  const url = `https://app.pawspace.test/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
};

const hex = (bytes) => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
async function sign(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}
// Posts a Razorpay-shaped webhook with a REAL HMAC signature over the raw body.
async function postWebhook(eventId, payload, { secret = "uat-test-secret", signature } = {}) {
  const raw = JSON.stringify(payload);
  const sig = signature ?? await sign(secret, raw);
  const response = await webhookRoute.POST(new Request("http://localhost/api/razorpay-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": eventId },
    body: raw,
  }));
  return { status: response.status, body: await parseBody(response) };
}
const NOW = 1_800_000_000_000;
const realNow = Date.now;
test.before(() => { Date.now = () => NOW; });
test.after(() => { Date.now = realNow; });
const capturedEvent = (bookingId, amountSubunits, paymentId = "pay_TEST1") => ({
  event: "payment.captured", created_at: Math.floor(NOW / 1000),
  payload: { payment: { entity: { id: paymentId, order_id: "order_TEST1", amount: amountSubunits, currency: "INR", notes: { booking_id: bookingId } } } },
});
const DAY = 86_400_000;
// Exact DDL copied verbatim from the owning sources: app/api/canonical-bookings/route.ts
// (canonical_customers/canonical_bookings/booking_payments) and the grooming refund surface
// (booking_refund_cases). Never guessed.
function baseTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  installFinancialLifecycleSchema(sqlite);
}
function seedCustomer(id = "cus_m1", phone = "+91-9000000021", email = "meera@example.in") {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, "blr", `Customer ${id}`, phone, email, NOW, NOW);
}
function seedBooking({ id, customer = "cus_m1", service = "grooming", total = 2000, dueNow = 2000, status = "confirmed", payStatus = "created", mode = "prepaid", method = "upi", createdAt = NOW - 3 * DAY }) {
  seedCustomer(customer, `+91-90000${String(id).replace(/\D/g, "").padStart(5, "1").slice(-5)}`, `${customer}-${id}@example.in`.toLowerCase());
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,'prov_1',?,?,?,'customer_app',?,'INR','{}','uat',?,?)")
    .run(id, `k-${id}`, customer, service, `g-${id}`, new Date(NOW + 5 * DAY).toISOString(), new Date(NOW + 5 * DAY + 3_600_000).toISOString(), status, total, createdAt, createdAt);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(`PAY-${id}`, id, customer, total, dueNow, method, mode, payStatus, `pk-${id}`, createdAt, createdAt);
}
function seedCustomerIdentity(email, customerId) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`usr-${email}`, email, email.split("@")[0], "customer", NOW, NOW);
  sqlite.prepare("INSERT INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, customerId, NOW, NOW);
}

// ---- 1. Webhook: signature-first, verify-first capture, idempotent, exact reconciliation -------

test("real execution: webhook refuses unsigned/badly-signed/unconfigured requests before touching any state", async () => {
  freshDb({ PAWSPACE_PAYMENT_ENV: "sandbox" }); baseTables();
  // No sandbox secret configured -> 503 fail-closed
  const unconfigured = await postWebhook("evt_1", capturedEvent("B1", 200000), { secret: "anything" });
  assert.equal(unconfigured.status, 503);
  freshDb(); baseTables(); seedBooking({ id: "B1" });
  // Missing signature header
  const noSig = await webhookRoute.POST(new Request("http://localhost/api/razorpay-webhook", { method: "POST", headers: { "x-razorpay-event-id": "evt_2" }, body: "{}" }));
  assert.equal(noSig.status, 400);
  // Wrong signature -> 401 and NOTHING recorded
  const badSig = await postWebhook("evt_3", capturedEvent("B1", 200000), { signature: "0".repeat(64) });
  assert.equal(badSig.status, 401);
  const eventsTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_gateway_events'").get();
  if (eventsTable) assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_events").get().n, 0, "a rejected signature must never record an event");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='B1'").get().status, "created");
});

test("real execution: verify-first — a 'created' payment is only captured by a correctly signed webhook, reconciliation matches booking_payments exactly, duplicates ignored", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 2000, payStatus: "created" });
  /* One event, posted twice. capturedEvent() stamps created_at from the live clock on EVERY call, and
   * gateway_webhook_events correctly rejects an event id replayed with a DIFFERENT payload hash - so
   * building the replay separately made this assertion pass only when both posts landed inside the same
   * wall-clock second. Reusing the identical body is what actually exercises duplicate detection. */
  const captured = capturedEvent("B1", 200000);
  const ok = await postWebhook("evt_10", captured);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.environment, "sandbox");
  assert.equal(ok.body.status, "processed");
  assert.equal(sqlite.prepare("SELECT status,gateway FROM booking_payments WHERE booking_id='B1'").get().status, "captured");
  const recon = sqlite.prepare("SELECT * FROM payment_reconciliation_records WHERE booking_id='B1'").get();
  assert.equal(recon.expected_amount, 2000, "expected mirrors booking_payments.amount");
  assert.equal(recon.captured_amount, 2000);
  assert.equal(recon.reconciliation_status, "matched");
  assert.equal(recon.variance_amount, 0);
  // Same gateway event id replayed -> duplicate, no second effect
  const dup = await postWebhook("evt_10", captured);
  assert.equal(dup.body.duplicate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_events").get().n, 1);
});

test("real execution: capture amount mismatch and refund flow both land in the exact reconciliation truth", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 2000, payStatus: "created" });
  // Gateway says 1500 for a 2000 booking -> exception, never silently matched
  const mismatch = await postWebhook("evt_20", capturedEvent("B1", 150000));
  assert.equal(mismatch.body.status, "exception");
  assert.equal(mismatch.body.reason, "capture_amount_mismatch");
  const record = sqlite.prepare("SELECT reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE booking_id='B1'").get();
  assert.equal(record.reconciliation_status, "amount_mismatch");
  assert.equal(record.variance_amount, -500);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions WHERE exception_type='capture_amount_mismatch'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='B1'").get().status, "created", "a mismatched capture must NOT flip the canonical payment");
  // Correct capture then a full refund via internal refund case
  const captured = await postWebhook("evt_21", capturedEvent("B1", 200000));
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RC1','B1','PAY-B1',2000,'customer cancellation','approved','finance:uat',?,?)").run(NOW, NOW);
  const refunded = await postWebhook("evt_22", {
    event: "refund.processed", created_at: Math.floor(NOW / 1000),
    payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_TEST1", order_id: "order_TEST1", amount: 200000, currency: "INR" } }, payment: { entity: { id: "pay_TEST1", notes: { booking_id: "B1" } } } },
  });
  assert.equal(refunded.body.status, "processed", JSON.stringify(refunded.body));
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='B1'").get().status, "refunded");
  const after = sqlite.prepare("SELECT gateway_status,refunded_amount FROM payment_reconciliation_records WHERE booking_id='B1'").get();
  assert.equal(after.gateway_status, "refunded");
  assert.equal(after.refunded_amount, 2000);
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id='RC1'").get().status, "processed");
});

// The old title and assertion both named the two payment modes the guard covered — "pins LIVE prepaid
// AND split_50_50". The platform also uses "full" and "split", so what this certified was a guard that
// covered two spellings out of several, and it passed for as long as the bypass existed. The rule is now
// about the METHOD being online and the environment being LIVE, never about a client-supplied label.
test("contract: verify-first pins EVERY LIVE online payment to 'created' regardless of mode, and the webhook checks the signature before parsing", () => {
  const bookings = fs.readFileSync(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8");
  assert.match(bookings, /liveMode&&payment\.status==="captured"&&!offlineAuthorized\)return "created"/, "the verify-first rule fails closed on the method — it demotes unless the server authorized an offline collection");
  assert.doesNotMatch(bookings, /liveMode&&ONLINE_METHODS\.has\(payment\.method\)&&payment\.status==="captured"/, "an online-method allowlist is exactly what let an off-list method preserve captured");
  assert.doesNotMatch(bookings, /payment\.mode==="prepaid"\|\|payment\.mode==="split_50_50"/, "a mode-name allowlist is exactly what let 'full' and 'split' through");
  assert.doesNotMatch(bookings, /!isSubscription/, "and a subscription carve-out is what let a LIVE subscription self-declare capture");
  const webhook = fs.readFileSync(new URL("../app/api/razorpay-webhook/route.ts", import.meta.url), "utf8");
  const lifecycle = fs.readFileSync(new URL("../lib/financial-lifecycle.ts", import.meta.url), "utf8");
  assert.match(webhook, /acceptRazorpayWebhook\(db,\{rawBody:raw,signature,webhookSecret:gate\.secret/, "the route passes the exact raw body to the lifecycle verifier");
  assert.ok(lifecycle.indexOf("verifyRazorpayRawBody(input.rawBody") < lifecycle.indexOf("JSON.parse(input.rawBody)"), "signature verification must run before the payload is parsed");
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /url\.pathname==="\/api\/razorpay-webhook"/, "webhook stays on the public (signature-authenticated) gateway list");
  assert.match(gateway, /stay-balance"\)return "scheduling\.book"/);
  for (const route of ["razorpay-webhook", "payment-reconciliation", "subscription-wallet", "coupon-governance", "referral-governance", "stay-balance", "pawspace-wallet", "paw-points"]) {
    const source = fs.readFileSync(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /globalThis/, `${route} must get the DB via cloudflare:workers env, never globalThis`);
  }
});

// ---- 2. PawSpace Wallet: never negative, exactly-once under races ------------------------------

test("real execution: wallet credit is idempotent and a raced duplicate credit lands exactly once", async () => {
  freshDb(); baseTables();
  const db = globalThis.__MONEY_DB__;
  const first = await creditWallet(db, { customerId: "cus_m1", amount: 500, source: "refund", idempotencyKey: "cr-1", actorId: "finance:uat" });
  assert.equal(first.balance, 500);
  const replay = await creditWallet(db, { customerId: "cus_m1", amount: 500, source: "refund", idempotencyKey: "cr-1", actorId: "finance:uat" });
  assert.equal(replay.alreadyCredited, true);
  assert.equal(replay.balance, 500);
  // REGRESSION lib/pawspace-wallet-governance.ts: the same key IN FLIGHT TWICE used to double-apply
  // the balance delta and then crash on the ledger UNIQUE — money invented out of a retry.
  const raced = await Promise.allSettled([
    creditWallet(db, { customerId: "cus_m1", amount: 300, source: "goodwill", idempotencyKey: "cr-2", actorId: "finance:uat" }),
    creditWallet(db, { customerId: "cus_m1", amount: 300, source: "goodwill", idempotencyKey: "cr-2", actorId: "finance:uat" }),
  ]);
  assert.ok(raced.every(r => r.status === "fulfilled"), JSON.stringify(raced));
  assert.equal(await walletBalance(db, "cus_m1"), 800, "500 + 300 exactly once, not 1100");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM pawspace_wallet_ledger WHERE entry_type='credit'").get().n, 2);
});

test("REGRESSION lib/pawspace-wallet-governance.ts: concurrent redemptions can no longer drive the wallet negative, and a lost same-booking race refunds the debit", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 5000 }); seedBooking({ id: "B2", total: 5000 });
  const db = globalThis.__MONEY_DB__;
  await creditWallet(db, { customerId: "cus_m1", amount: 400, source: "refund", idempotencyKey: "cr-1", actorId: "finance:uat" });
  // Two bookings racing to spend the SAME 400 balance: exactly one may win.
  const race = await Promise.allSettled([
    redeemWalletForBooking(db, { customerId: "cus_m1", bookingId: "B1", actorId: "cus_m1" }),
    redeemWalletForBooking(db, { customerId: "cus_m1", bookingId: "B2", actorId: "cus_m1" }),
  ]);
  const wins = race.filter(r => r.status === "fulfilled");
  assert.equal(wins.length, 1, JSON.stringify(race.map(r => r.status === "fulfilled" ? r.value : String(r.reason))));
  assert.equal(wins[0].value.walletUsed, 400);
  assert.equal(wins[0].value.appliedValue, 440, "10% enhanced value: 400 wallet -> 440 booking value");
  const balance = await walletBalance(db, "cus_m1");
  assert.equal(balance, 0, `balance must be exactly 0, never negative (got ${balance})`);
  // Same-booking double redeem after re-crediting: the loser must NOT burn balance silently.
  await creditWallet(db, { customerId: "cus_m1", amount: 200, source: "goodwill", idempotencyKey: "cr-2", actorId: "finance:uat" });
  seedBooking({ id: "B3", total: 5000 });
  const sameBooking = await Promise.allSettled([
    redeemWalletForBooking(db, { customerId: "cus_m1", bookingId: "B3", walletAmount: 100, actorId: "cus_m1" }),
    redeemWalletForBooking(db, { customerId: "cus_m1", bookingId: "B3", walletAmount: 100, actorId: "cus_m1" }),
  ]);
  assert.equal(sameBooking.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await walletBalance(db, "cus_m1"), 100, "the losing duplicate must give its debit back (100 spent once, not twice)");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM pawspace_wallet_ledger WHERE entry_type='redeem'").get().n, 2, "one redeem ledger row per winning redemption");
});

test("real execution: wallet route enforces ownership and staff-gated credit", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 5000 });
  await call(walletRoute.POST, "POST", { action: "credit", customerId: "cus_m1", amount: 500, source: "goodwill", idempotencyKey: "cr-1" });
  seedCustomerIdentity("mallory@pawspace.test", "cus_other");
  const foreign = await callAs(walletRoute.POST, "POST", { customerId: "cus_m1", bookingId: "B1", walletAmount: 100 }, "mallory@pawspace.test");
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  const credit = await callAs(walletRoute.POST, "POST", { action: "credit", customerId: "cus_other", amount: 500, source: "goodwill", idempotencyKey: "cr-2" }, "mallory@pawspace.test");
  assert.equal(credit.status, 403, "customers must not mint their own wallet credit (finance.manage only)");
  const own = await call(walletRoute.POST, "POST", { customerId: "cus_m1", bookingId: "B1", walletAmount: 100 });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.data.appliedValue, 110);
  // PawPoints route: same ownership rule — another customer cannot redeem cus_m1's points
  const foreignPoints = await callAs(pointsRoute.POST, "POST", { customerId: "cus_m1", points: 10, bookingId: "B1" }, "mallory@pawspace.test");
  assert.equal(foreignPoints.status, 403, JSON.stringify(foreignPoints.body));
});

// ---- 3. PawPoints: earn sweep idempotent, redemption race-safe ---------------------------------

test("real execution: PawPoints earn sweep credits each completed booking exactly once across repeated runs", async () => {
  freshDb(); baseTables();
  seedBooking({ id: "B1", total: 1000, status: "completed" });
  seedBooking({ id: "B2", total: 2550, status: "completed" });
  seedBooking({ id: "B3", total: 900, status: "confirmed" });
  const db = globalThis.__MONEY_DB__;
  const first = await runPawPointsEarnSweep(db);
  assert.equal(first.bookingsCredited, 2, "only completed bookings earn");
  assert.equal(first.pointsAwarded, 355, "floor(1000*0.1)+floor(2550*0.1) = 100+255");
  assert.equal(await pawPointsBalance(db, "cus_m1"), 355);
  const second = await runPawPointsEarnSweep(db);
  assert.equal(second.bookingsCredited, 0, "the sweep must be idempotent");
  assert.equal(await pawPointsBalance(db, "cus_m1"), 355);
});

test("REGRESSION lib/paw-points-governance.ts: concurrent redemptions on two bookings can no longer overdraw the points balance", async () => {
  freshDb(); baseTables();
  seedBooking({ id: "B1", total: 1000, status: "completed" });
  seedBooking({ id: "B2", total: 5000 });
  seedBooking({ id: "B3", total: 5000 });
  const db = globalThis.__MONEY_DB__;
  await runPawPointsEarnSweep(db); // balance 100
  const race = await Promise.allSettled([
    redeemPoints(db, { customerId: "cus_m1", points: 100, bookingId: "B2", actorId: "cus_m1" }),
    redeemPoints(db, { customerId: "cus_m1", points: 100, bookingId: "B3", actorId: "cus_m1" }),
  ]);
  const wins = race.filter(r => r.status === "fulfilled");
  assert.equal(wins.length, 1, JSON.stringify(race.map(r => r.status)));
  assert.equal(wins[0].value.pointsRedeemed, 100);
  assert.equal(wins[0].value.discountApplied, 50, "100 points = Rs.50 off");
  const balance = await pawPointsBalance(db, "cus_m1");
  assert.equal(balance, 0, `points balance must be exactly 0, never negative (got ${balance})`);
  // Same-booking duplicate stays a governed error
  await assert.rejects(redeemPoints(db, { customerId: "cus_m1", points: 10, bookingId: "B2", actorId: "cus_m1" }), /already been redeemed/);
});

// ---- 4. Coupon quote -> consume: single-use + limits under concurrency -------------------------

test("real execution: coupon quote->consume via routes; replay is idempotent; a second consume of the same quote is a governed error", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 1500 }); seedBooking({ id: "B2", total: 1500 });
  const quote = await call(couponRoute.POST, "POST", { action: "quote", input: { code: "UATCARE100", customerId: "cus_m1", serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "pkg", orderValue: 1500, paymentMode: "full", isSubscription: false } });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.data.discount, 100);
  assert.equal(quote.body.data.finalAmount, 1400);
  const consume = await call(couponRoute.POST, "POST", { action: "consume", quoteId: quote.body.data.quoteId, bookingId: "B1", customerId: "cus_m1", idempotencyKey: "cc-1" });
  assert.equal(consume.status, 200, JSON.stringify(consume.body));
  assert.equal(consume.body.data.redemption.discountAmount, 100);
  const replay = await call(couponRoute.POST, "POST", { action: "consume", quoteId: quote.body.data.quoteId, bookingId: "B1", customerId: "cus_m1", idempotencyKey: "cc-1" });
  assert.equal(replay.body.data.duplicatePrevented, true);
  // Same quote against a different booking -> governed 4xx/5xx error, not a raw UNIQUE crash
  const reuse = await call(couponRoute.POST, "POST", { action: "consume", quoteId: quote.body.data.quoteId, bookingId: "B2", customerId: "cus_m1", idempotencyKey: "cc-2" });
  assert.notEqual(reuse.status, 200);
  assert.match(String(reuse.body.error || ""), /no longer open/i, JSON.stringify(reuse.body));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 1);
});

test("REGRESSION lib/coupon-governance.ts: two concurrent consumes of different quotes can no longer breach the per-customer limit (TOCTOU)", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 1500 }); seedBooking({ id: "B2", total: 1500 });
  const db = globalThis.__MONEY_DB__;
  const input = { code: "UATCARE100", customerId: "cus_m1", serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "pkg", orderValue: 1500, paymentMode: "full", isSubscription: false };
  const q1 = await quoteCoupon(db, input, {});
  const q2 = await quoteCoupon(db, input, {});
  assert.ok(q1.valid && q2.valid, "two open quotes for the same customer are allowed pre-consume");
  sqlite.prepare("UPDATE coupon_campaigns SET per_customer_limit=1 WHERE code='UATCARE100'").run();
  // Pre-fix: both consumes read used-count 0, both inserted -> limit 1 breached to 2.
  const race = await Promise.allSettled([
    consumeCouponQuote(db, { quoteId: q1.quoteId, bookingId: "B1", customerId: "cus_m1", idempotencyKey: "cc-a" }),
    consumeCouponQuote(db, { quoteId: q2.quoteId, bookingId: "B2", customerId: "cus_m1", idempotencyKey: "cc-b" }),
  ]);
  const wins = race.filter(r => r.status === "fulfilled");
  assert.equal(wins.length, 1, JSON.stringify(race.map(r => r.status === "fulfilled" ? "ok" : String(r.reason))));
  assert.match(String(race.find(r => r.status === "rejected").reason), /limit reached/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE status='consumed'").get().n, 1, "per-customer limit 1 must hold under concurrency");
  // The losing quote is reopened so the customer has not burned it
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes WHERE status='open'").get().n, 1);
});

test("REGRESSION coupon idempotency: one key with different contexts leaves exactly one complete mutation", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 1500 }); seedBooking({ id: "B2", total: 1500 });
  const db = globalThis.__MONEY_DB__;
  const input = { code: "UATCARE100", customerId: "cus_m1", serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "pkg", orderValue: 1500, paymentMode: "full", isSubscription: false };
  const q1 = await quoteCoupon(db, input, {}), q2 = await quoteCoupon(db, input, {});
  const race = await Promise.allSettled([
    consumeCouponQuote(db, { quoteId: q1.quoteId, bookingId: "B1", customerId: "cus_m1", idempotencyKey: "coupon-shared-key" }),
    consumeCouponQuote(db, { quoteId: q2.quoteId, bookingId: "B2", customerId: "cus_m1", idempotencyKey: "coupon-shared-key" }),
  ]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String(race.find(result => result.status === "rejected").reason), /different redemption/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE idempotency_key='coupon-shared-key'").get().n, 1);
  assert.deepEqual(sqlite.prepare("SELECT status,COUNT(*) n FROM coupon_quotes GROUP BY status ORDER BY status").all().map(row => ({ ...row })), [{ status: "consumed", n: 1 }, { status: "open", n: 1 }]);
});

// ---- 5. Referral: qualify -> reward -> reserve -> reverse with exact amounts --------------------

test("real execution: referral chain pays the configured reward exactly and reverses it exactly once", async () => {
  freshDb(); baseTables();
  seedCustomer("cus_ref", "+91-9000000031", "referrer@example.in");
  const programme = await call(referralRoute.POST, "POST", { action: "save_programme", programme: { id: "uat-referral-programme", name: "UAT Referral Programme", status: "active", eligibleServices: ["grooming"], cityIds: ["blr"], rewardUseServices: ["grooming"], friendDiscount: 300, referrerReward: 500, perReferrerMonthlyLimit: 2, rewardValidityDays: 30, oneRewardPerFriend: true, reversalOnRefund: true, validFrom: NOW - DAY, validUntil: NOW + 90 * DAY } });
  assert.equal(programme.status, 200, JSON.stringify(programme.body));
  const code = await call(referralRoute.POST, "POST", { action: "ensure_code", customerId: "cus_ref" });
  assert.equal(code.status, 200, JSON.stringify(code.body));
  seedCustomer("cus_friend", "+91-9000000032", "friend@example.in");
  const claim = await call(referralRoute.POST, "POST", { action: "claim", input: { code: code.body.data.code, referredCustomerId: "cus_friend", serviceCode: "grooming", cityId: "blr", idempotencyKey: "rc-1" } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.data.friendDiscount, 300, "friend discount comes from the configured policy");
  // Friend's FIRST canonical booking, completed and captured
  seedBooking({ id: "FB1", customer: "cus_friend", total: 1800, status: "completed", payStatus: "captured" });
  const qualify = await call(referralRoute.POST, "POST", { action: "qualify", claimId: claim.body.data.claimId, bookingId: "FB1", idempotencyKey: "rq-1" });
  assert.equal(qualify.status, 200, JSON.stringify(qualify.body));
  assert.equal(qualify.body.data.qualified, true);
  assert.equal(qualify.body.data.reward.amount, 500, "reward is exactly the configured referrerReward");
  assert.equal(qualify.body.data.reward.status, "released");
  const rewardId = qualify.body.data.reward.id;
  const requalify = await call(referralRoute.POST, "POST", { action: "qualify", claimId: claim.body.data.claimId, bookingId: "FB1", idempotencyKey: "rq-2" });
  assert.equal(requalify.body.data.duplicatePrevented, true, "one reward per claim, ever");
  // Referrer spends the reward on their own eligible booking
  seedBooking({ id: "RB1", customer: "cus_ref", total: 2400 });
  const reserve = await call(referralRoute.POST, "POST", { action: "reserve_reward", rewardId, bookingId: "RB1", customerId: "cus_ref", idempotencyKey: "rr-1" });
  assert.equal(reserve.status, 200, JSON.stringify(reserve.body));
  assert.equal(reserve.body.data.reservation.amount, 500);
  // Refund path reverses the reward and its reservation, exactly once
  const reverse = await call(referralRoute.POST, "POST", { action: "reverse_reward", rewardId, reason: "qualifying booking refunded" });
  assert.equal(reverse.status, 200, JSON.stringify(reverse.body));
  assert.equal(reverse.body.data.status, "reversed");
  assert.equal(sqlite.prepare("SELECT status FROM referral_reward_reservations WHERE reward_id=?").get(rewardId).status, "reversed");
  assert.equal(sqlite.prepare("SELECT points FROM (SELECT amount points FROM referral_reward_events WHERE event_type='reversed')").get().points, -500, "the reversal event carries the exact negative amount");
  const rereverse = await call(referralRoute.POST, "POST", { action: "reverse_reward", rewardId, reason: "double reversal attempt" });
  assert.equal(rereverse.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM referral_reward_events WHERE event_type='reversed'").get().n, 1);
});

// ---- 6. Subscription wallet: reserve/consume/release never double-move credits -----------------

function seedSubscription({ id = "SUB1", customer = "cus_m1", total = 8 } = {}) {
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,?,?,?,0,0,'active',?,?,?,?,?,?)")
    .run(id, customer, "plan-8", "full-groom", total, NOW, NOW + 90 * DAY, `SRC-${id}`, "v1", NOW, NOW);
  sqlite.prepare("INSERT INTO grooming_subscription_purchase_snapshots (subscription_id,booking_id,city_id,zone_id,plan_code,catalogue_version,config_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, `SRC-${id}`, "blr", "blr-east", "plan-8", "v1", JSON.stringify({ pauseDays: 30, graceDays: 30, renewalWindowDays: 15, familyWallet: true }), NOW);
}

test("real execution: subscription wallet reserve->consume moves credits exactly once; available never goes negative", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 1200 });
  const db = globalThis.__MONEY_DB__;
  const { ensureSubscriptionWalletTables } = await import("../lib/subscription-wallet.ts");
  await ensureSubscriptionWalletTables(db);
  seedSubscription({});
  const reserved = await call(subscriptionWalletRoute.POST, "POST", { subscriptionId: "SUB1", action: "reserve", bookingId: "B1", credits: 1, idempotencyKey: "sw-1" });
  assert.equal(reserved.status, 201, JSON.stringify(reserved.body));
  assert.deepEqual(reserved.body.data.wallet.balances, { total: 8, reserved: 1, consumed: 0, available: 7 });
  // Over-reserving beyond the remaining credits is refused atomically
  seedBooking({ id: "B2", total: 1200 });
  const over = await call(subscriptionWalletRoute.POST, "POST", { subscriptionId: "SUB1", action: "reserve", bookingId: "B2", credits: 8, idempotencyKey: "sw-2" });
  assert.notEqual(over.status, 201);
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='B1'").run();
  // REGRESSION lib/subscription-wallet.ts: two concurrent consumes of the same reservation used to
  // BOTH run the unconditional counter update (the guarded usage flip sat in the same batch), so
  // one delivered session was counted as two consumed credits.
  const race = await Promise.allSettled([
    mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "consume", bookingId: "B1", idempotencyKey: "sw-3a", actorId: "staff:a" }),
    mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "consume", bookingId: "B1", idempotencyKey: "sw-3b", actorId: "staff:b" }),
  ]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1, JSON.stringify(race.map(r => r.status)));
  const counters = { ...sqlite.prepare("SELECT sessions_reserved,sessions_consumed FROM customer_grooming_subscriptions WHERE id='SUB1'").get() };
  assert.deepEqual(counters, { sessions_reserved: 0, sessions_consumed: 1 }, "one completed booking consumes exactly one credit");
});

test("REGRESSION lib/subscription-wallet.ts: a raced double release cannot hand back the same credit twice", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 1200 }); seedBooking({ id: "B2", total: 1200 });
  const db = globalThis.__MONEY_DB__;
  const { ensureSubscriptionWalletTables } = await import("../lib/subscription-wallet.ts");
  await ensureSubscriptionWalletTables(db);
  seedSubscription({});
  await mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "reserve", bookingId: "B1", credits: 2, idempotencyKey: "sw-1", actorId: "cus" });
  await mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "reserve", bookingId: "B2", credits: 2, idempotencyKey: "sw-2", actorId: "cus" });
  const race = await Promise.allSettled([
    mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "release", bookingId: "B1", idempotencyKey: "sw-3a", actorId: "staff:a" }),
    mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "release", bookingId: "B1", idempotencyKey: "sw-3b", actorId: "staff:b" }),
  ]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  const counters = { ...sqlite.prepare("SELECT sessions_reserved,sessions_consumed FROM customer_grooming_subscriptions WHERE id='SUB1'").get() };
  assert.deepEqual(counters, { sessions_reserved: 2, sessions_consumed: 0 }, "B2's reservation must survive: only B1's 2 credits were released, once");
});

test("REGRESSION subscription idempotency: one reserve key cannot mutate two bookings", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 1200 }); seedBooking({ id: "B2", total: 1200 });
  const db = globalThis.__MONEY_DB__;
  const { ensureSubscriptionWalletTables } = await import("../lib/subscription-wallet.ts");
  await ensureSubscriptionWalletTables(db); seedSubscription({});
  const race = await Promise.allSettled([
    mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "reserve", bookingId: "B1", credits: 1, idempotencyKey: "reserve-shared-key", actorId: "cus" }),
    mutateSubscriptionWallet(db, { subscriptionId: "SUB1", action: "reserve", bookingId: "B2", credits: 1, idempotencyKey: "reserve-shared-key", actorId: "cus" }),
  ]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String(race.find(result => result.status === "rejected").reason), /different mutation/i);
  assert.equal(sqlite.prepare("SELECT sessions_reserved FROM customer_grooming_subscriptions WHERE id='SUB1'").get().sessions_reserved, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_subscription_usage").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM subscription_wallet_events WHERE idempotency_key='reserve-shared-key'").get().n, 1);
});

// ---- 7. Stay balance -> payment truth (task 2) + route governance ------------------------------

async function seedSplitStay({ bookingId = "SB1", total = 4000, dueNow = 2000, customer = "cus_m1" } = {}) {
  seedBooking({ id: bookingId, customer, service: "boarding", total, dueNow, payStatus: "captured", mode: "split_50_50" });
  const db = globalThis.__MONEY_DB__;
  const { ensureStayPaymentTables, staySplitScheduleStatement } = await import("../lib/stay-split-payments.ts");
  await ensureStayPaymentTables(db);
  await staySplitScheduleStatement(db, { bookingId, serviceCode: "boarding", customerId: customer, totalAmount: total, paidNowAmount: dueNow, balanceAmount: total - dueNow, balanceDueAt: NOW + 4 * DAY }).run();
  // The booking-time 50% arrived through the gateway: reflect it in the reconciliation truth the
  // same way the verify-first webhook path does (order link + captured record).
  await linkGatewayOrder(db, { bookingId, gatewayOrderId: `order_${bookingId}`, environment: "sandbox", actorId: "uat" });
  sqlite.prepare("UPDATE payment_reconciliation_records SET captured_amount=?,gateway_status='captured',reconciliation_status='matched' WHERE booking_id=?").run(dueNow, bookingId);
}

test("real execution: stay balance pay is atomic + idempotent, ownership-checked, and sweeps overdue", async () => {
  freshDb(); baseTables(); await seedSplitStay({});
  const db = globalThis.__MONEY_DB__;
  await call(stayBalanceRoute.GET, "GET", "bookingId=SB1"); // preview actor initializes the security tables
  seedCustomerIdentity("mallory@pawspace.test", "cus_other");
  const foreign = await callAs(stayBalanceRoute.POST, "POST", { action: "pay_balance", bookingId: "SB1", idempotencyKey: "pb-mal" }, "mallory@pawspace.test");
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  // Concurrent double-pay: exactly one capture, one payment_ref, one event
  const race = await Promise.all([
    payStayBalance(db, { bookingId: "SB1", actorId: "cus_m1", idempotencyKey: "pb-1" }),
    payStayBalance(db, { bookingId: "SB1", actorId: "cus_m1", idempotencyKey: "pb-2" }),
  ]);
  assert.equal(race.filter(r => !r.duplicatePrevented).length, 1, "only one caller may capture the balance");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM stay_payment_events WHERE event_type='balance_captured'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM stay_payment_schedules WHERE booking_id='SB1'").get().status, "paid");
  const replay = await call(stayBalanceRoute.POST, "POST", { action: "pay_balance", bookingId: "SB1", idempotencyKey: "pb-1" });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  // Overdue sweep marks only past-due pending balances
  await seedSplitStay({ bookingId: "SB2", customer: "cus_m2" });
  sqlite.prepare("UPDATE stay_payment_schedules SET balance_due_at=? WHERE booking_id='SB2'").run(NOW - DAY);
  const sweep = await call(stayBalanceRoute.POST, "POST", { action: "sweep_overdue" });
  assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
  assert.equal(sweep.body.data.marked, 1);
  assert.equal(sweep.body.data.overdue[0].bookingId, "SB2");
});

test("REGRESSION lib/revenue-mission-control.ts: stay balance captures now appear in the reconciliation collected truth (they were invisible)", async () => {
  freshDb(); baseTables(); await seedSplitStay({ bookingId: "SB1", total: 4000, dueNow: 2000 });
  const db = globalThis.__MONEY_DB__;
  await payStayBalance(db, { bookingId: "SB1", actorId: "cus_m1", idempotencyKey: "pb-1" });
  const save = await call(missionRoute.POST, "POST", { action: "save_mission", name: "Money Audit Mission", targetAmount: 10000, currency: "INR", periodStart: NOW - 7 * DAY, periodEnd: NOW + 7 * DAY, scope: { type: "company" }, revenueBasis: "collected", reason: "money-stack hardening audit" });
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const missionId = save.body.data.id;
  await call(missionRoute.POST, "POST", { action: "activate_mission", missionId, approvalReference: "APPR-1", reason: "hardening audit activation" });
  const backfill = await call(missionRoute.POST, "POST", { action: "backfill_canonical_sources", missionId });
  assert.equal(backfill.status, 200, JSON.stringify(backfill.body));
  const summary = await call(missionRoute.GET, "GET", `missionId=${missionId}`);
  assert.equal(summary.status, 200);
  const metrics = summary.body.summary.metrics;
  assert.equal(metrics.booked, 4000);
  assert.equal(metrics.collected, 4000, "2000 gateway-captured due-now + 2000 governed stay balance capture (pre-fix: 2000, balance invisible)");
  // Rebuild is delta-idempotent: nothing double-counts
  await call(missionRoute.POST, "POST", { action: "backfill_canonical_sources", missionId });
  const again = await call(missionRoute.GET, "GET", `missionId=${missionId}`);
  assert.equal(again.body.summary.metrics.collected, 4000, "re-running the backfill must not double-count the balance");
});

// ---- 8. Finance reconciliation console read path ------------------------------------------------

test("real execution: payment-reconciliation console lists webhook exceptions and dismisses them with a governed note", async () => {
  freshDb(); baseTables(); seedBooking({ id: "B1", total: 2000, payStatus: "created" });
  const mismatch = await postWebhook("evt_30", capturedEvent("B1", 150000)); // amount mismatch -> exception
  assert.equal(mismatch.body.reason, "capture_amount_mismatch", JSON.stringify(mismatch.body));
  const list = await call(reconciliationRoute.GET, "GET", "status=open");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.exceptions.length, 1);
  const exception = list.body.data.exceptions[0];
  assert.equal(exception.type, "capture_amount_mismatch");
  const noNote = await call(reconciliationRoute.POST, "POST", { exceptionId: exception.id, action: "dismiss" });
  assert.equal(noNote.status, 400, "a resolution requires a note");
  const dismissed = await call(reconciliationRoute.POST, "POST", { exceptionId: exception.id, action: "dismiss", note: "test gateway sent a partial capture" });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  assert.equal(dismissed.body.data.status, "dismissed");
  const after = await call(reconciliationRoute.GET, "GET", "status=open");
  assert.equal(after.body.data.exceptions.length, 0);
});

// =====================================================================================================
// PTJA-W2-MKT-01 (ledger W2-09-M01) — wallet credit and PawPoints stack to 120% of the order value
//
// redeemWalletForBooking and redeemPoints each computed their cap independently against
// canonical_bookings.total_amount, and neither writes the booking down, so the two instruments applied
// to the SAME booking sum past what the order is worth.
//
// MEASURED through the two real routes on one customer session: a Rs 5,000 booking, a Rs 5,000 wallet
// balance and 5,000 PawPoints. POST /api/pawspace-wallet -> 201 {"walletUsed":4545.45,"bonus":454.55,
// "appliedValue":5000}. POST /api/paw-points {"points":5000} -> 201 {"pointsRedeemed":2000,
// "discountApplied":1000}. Neither call refused; neither knew about the other. Rs 6,000 of discount on a
// Rs 5,000 order, from two ordinary self-service calls with no staff involved, and
// canonical_bookings.total_amount still 5000. lib/unit-economics.ts then books all Rs 6,000 as real
// discount against a Rs 5,000 GMV line, so contribution goes negative with nothing flagging it.
//
// PawPoints' MAX_REDEEM_FRACTION margin cap does not help: it is measured on the GROSS total, so it
// survives intact even after the wallet has already covered 100% of the booking.
//
// The ceiling was never wrong - it was measured per instrument. Each redemption now caps against what
// is still PAYABLE on the booking, via lib/booking-credit-application.ts, which reads what every
// instrument has already applied. The margin cap stays exactly as it is, on the gross total; it is now
// the tighter of the two that binds. No incentive policy is invented.
// =====================================================================================================

async function stackingWorld({ total = 5000, wallet = 5000, points = 5000 } = {}) {
  freshDb(); baseTables(); seedBooking({ id: "STACK", total });
  const db = globalThis.__MONEY_DB__;
  if (wallet > 0) await creditWallet(db, { customerId: "cus_m1", amount: wallet, source: "goodwill", idempotencyKey: "stack-wc", actorId: "finance:uat" });
  if (points > 0) await grantGoodwillPoints(db, { customerId: "cus_m1", points, reason: "service recovery probe", actorId: "ops:uat", idempotencyKey: "stack-pp" });
  const applied = async () => {
    const { creditsAppliedToBooking } = await import("../lib/booking-credit-application.ts");
    return creditsAppliedToBooking(db, "STACK");
  };
  return { db, applied };
}

test("REGRESSION lib/pawspace-wallet-governance.ts + lib/paw-points-governance.ts: wallet and points together cannot exceed the order value", async () => {
  const { db, applied } = await stackingWorld();

  const walletLeg = await redeemWalletForBooking(db, { customerId: "cus_m1", bookingId: "STACK", actorId: "cus_m1" });
  assert.equal(walletLeg.appliedValue, 5000, "the wallet alone legitimately covers the whole Rs 5,000 booking");
  assert.equal(await applied(), 5000, "so the booking has already received its full value in credit");

  await assert.rejects(
    redeemPoints(db, { customerId: "cus_m1", points: 5000, bookingId: "STACK", actorId: "cus_m1" }),
    /payable|redeemable|discount/i,
    "points must not add discount to a booking that is already fully covered",
  );
  assert.equal(await applied(), 5000, "total credit applied must never exceed the Rs 5,000 order value");
});

test("REGRESSION: the same ceiling holds when points are redeemed first", async () => {
  // Order must not decide the outcome - the defect was symmetric.
  const { db, applied } = await stackingWorld({ total: 5000 });
  const pointsLeg = await redeemPoints(db, { customerId: "cus_m1", points: 5000, bookingId: "STACK", actorId: "cus_m1" });
  assert.equal(pointsLeg.discountApplied, 1000, "the 20% margin cap still binds first: Rs 1,000 on a Rs 5,000 booking");

  const walletLeg = await redeemWalletForBooking(db, { customerId: "cus_m1", bookingId: "STACK", actorId: "cus_m1" });
  assert.equal(walletLeg.appliedValue, 4000, "the wallet may only cover what is still payable");
  assert.equal(await applied(), 5000, "and the two together come to exactly the order value, never past it");
});

test("REGRESSION: each instrument alone still works, and the margin cap is unchanged", async () => {
  // Non-vacuity. Refusing the second instrument outright, or tightening the points cap, would satisfy
  // the cases above and break both products.
  const soloWallet = await stackingWorld({ total: 5000, points: 0 });
  const walletOnly = await redeemWalletForBooking(soloWallet.db, { customerId: "cus_m1", bookingId: "STACK", actorId: "cus_m1" });
  assert.equal(walletOnly.appliedValue, 5000, "wallet alone still covers a whole booking, bonus included");

  const soloPoints = await stackingWorld({ total: 5000, wallet: 0 });
  const pointsOnly = await redeemPoints(soloPoints.db, { customerId: "cus_m1", points: 5000, bookingId: "STACK", actorId: "cus_m1" });
  assert.equal(pointsOnly.discountApplied, 1000, "points alone still redeem up to the unchanged 20% margin cap");
  assert.equal(pointsOnly.pointsRedeemed, 2000, "for the same number of points as before");

  // and a partial wallet spend still leaves room for points
  const mixed = await stackingWorld({ total: 5000 });
  await redeemWalletForBooking(mixed.db, { customerId: "cus_m1", bookingId: "STACK", walletAmount: 1000, actorId: "cus_m1" });
  const rest = await redeemPoints(mixed.db, { customerId: "cus_m1", points: 5000, bookingId: "STACK", actorId: "cus_m1" });
  assert.equal(rest.discountApplied, 1000, "Rs 1,100 of wallet value leaves the full 20% margin cap available");
  assert.equal(await mixed.applied(), 2100, "Rs 1,100 wallet value + Rs 1,000 points, well inside the order value");
});
