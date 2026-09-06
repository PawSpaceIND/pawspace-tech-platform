import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context); throw error; }
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

const libSource = fs.readFileSync("lib/customer-offers.ts", "utf8");
const governanceSource = fs.readFileSync("lib/coupon-governance.ts", "utf8");
const routeSource = fs.readFileSync("app/api/customer-offers/route.ts", "utf8");
const gatewaySource = fs.readFileSync("lib/api-gateway.ts", "utf8");
const cardSource = fs.readFileSync("app/mobile-app/offers-card.tsx", "utf8");

test("customer-offers module exports the required contract", () => {
  assert.match(libSource, /export async function seedWelcomeCoupon\(/);
  assert.match(libSource, /export async function listAvailableCoupons\(/);
  assert.match(libSource, /export const WELCOME_COUPON_CODE\s*=\s*"WELCOME"/);
});

test("customer-offers extends coupon-governance instead of duplicating its DDL or eligibility logic", () => {
  assert.match(libSource, /import\s*\{[^}]*ensureCouponTables[^}]*seedUatCoupons[^}]*customerFacts[^}]*rowToCampaign[^}]*\}\s*from\s*"\.\/coupon-governance"/);
  assert.doesNotMatch(libSource, /CREATE TABLE/);
});

test("coupon-governance's customerFacts and rowToCampaign are now exported, unchanged otherwise", () => {
  assert.match(governanceSource, /export async function customerFacts\(/);
  assert.match(governanceSource, /export function rowToCampaign\(/);
  assert.match(governanceSource, /kind:\(subscriber\?"subscriber":orderCount===0\?"new":"existing"\)/);
});

test("the WELCOME coupon seed is scoped to new/first-time customers only", () => {
  const seedBlock = libSource.slice(libSource.indexOf("seedWelcomeCoupon"));
  assert.match(seedBlock, /WELCOME_COUPON_CODE/);
  assert.match(seedBlock, /JSON\.stringify\(\["new"\]\)/);
  assert.match(seedBlock, /1, \/\/ first_order_only/);
  assert.match(seedBlock, /"active"/);
});

test("listAvailableCoupons filters by real customer facts, not a static list", () => {
  assert.match(libSource, /customerFacts\(db,\s*customerId\)/);
  assert.match(libSource, /campaign\.customerKinds\.includes\(facts\.kind\)/);
  assert.match(libSource, /campaign\.firstOrderOnly\s*\|\|\s*facts\.orderCount\s*===\s*0/);
  assert.match(libSource, /campaign\.code\s*===\s*WELCOME_COUPON_CODE\s*&&\s*facts\.orderCount\s*===\s*0/);
});

test("the API route requires verified customer ownership and delegates to listAvailableCoupons", () => {
  assert.match(routeSource, /listAvailableCoupons\(/);
  assert.match(routeSource, /searchParams\.get\("customerId"\)/);
  assert.match(routeSource, /resolveActor\(/);
  assert.match(routeSource, /resolvePlatformSession\(/);
  assert.match(routeSource, /requireCustomerOwnership\(/);
});

test("/api/customer-offers is permission-routed instead of gateway-public", () => {
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/customer-offers"\)return "scheduling\.book"/);
});

test("the offers card is a standalone client component that never touches the checkout flow files", () => {
  assert.match(cardSource, /^"use client";/m);
  assert.match(cardSource, /export default function OffersCard\(/);
  assert.doesNotMatch(cardSource, /grooming-flow|training-flow|from ["'].*stay-flow["']/);
  assert.doesNotMatch(cardSource, /from ["']\.\.\/\.\.\/lib\/(customer-offers|coupon-governance)["']/);
});

test("the card fetches the customer route, shows the welcome banner distinctly, and lets a caller hook the selected code", () => {
  assert.match(cardSource, /fetch\(`\/api\/customer-offers/);
  assert.match(cardSource, /autoApply/);
  assert.match(cardSource, /onSelectCode/);
});

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { sqlite.prepare(sql).run(...args); return { success: true }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; } };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL, service_code TEXT NOT NULL)");
  return { sqlite, db: makeD1(sqlite) };
}

test("real execution: WELCOME auto-applies and is listed for a first-time customer", async () => {
  const { listAvailableCoupons, WELCOME_COUPON_CODE } = await import("../lib/customer-offers.ts");
  const { sqlite, db } = freshDb();
  const result = await listAvailableCoupons(db, { customerId: "cus-new-1" });
  assert.ok(result.coupons.length > 0);
  assert.ok(result.coupons.some((coupon) => coupon.code === WELCOME_COUPON_CODE));
  assert.ok(result.autoApply);
  assert.equal(result.autoApply.code, WELCOME_COUPON_CODE);
  assert.equal(result.autoApply.discountType, "percent");
  assert.ok(result.autoApply.discountValue > 0);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coupon_campaigns'").get());
});

test("real execution: WELCOME does not auto-apply, and is not even listed, for a returning customer", async () => {
  const { listAvailableCoupons, WELCOME_COUPON_CODE } = await import("../lib/customer-offers.ts");
  const { sqlite, db } = freshDb();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,status,service_code) VALUES (?,?,?,?)").run("bkg-1", "cus-returning-1", "completed", "grooming");
  const result = await listAvailableCoupons(db, { customerId: "cus-returning-1" });
  assert.equal(result.autoApply, null);
  assert.ok(!result.coupons.some((coupon) => coupon.code === WELCOME_COUPON_CODE));
});

test("real execution: seeding WELCOME is idempotent across repeated calls", async () => {
  const { listAvailableCoupons, WELCOME_COUPON_CODE } = await import("../lib/customer-offers.ts");
  const { sqlite, db } = freshDb();
  await listAvailableCoupons(db, { customerId: "cus-new-2" });
  await listAvailableCoupons(db, { customerId: "cus-new-2" });
  await listAvailableCoupons(db, { customerId: "cus-new-3" });
  const count = sqlite.prepare("SELECT COUNT(*) c FROM coupon_campaigns WHERE code=?").get(WELCOME_COUPON_CODE);
  assert.equal(count.c, 1);
});

test("real execution: listAvailableCoupons validates customerId and never fabricates a result for a blank id", async () => {
  const { listAvailableCoupons } = await import("../lib/customer-offers.ts");
  const { db } = freshDb();
  await assert.rejects(() => listAvailableCoupons(db, { customerId: "" }), /customerId is required/);
  await assert.rejects(() => listAvailableCoupons(db, {}), /customerId is required/);
});
