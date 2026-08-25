/**
 * PawSpace Total Journey Audit — permanent behavioural regressions for the CONFIRMED P0 defects.
 *
 * Every case in this file was reproduced by TWO independent blind verifiers before a line of production
 * code was changed. Each records the failure it locks out, and each fails if its fix is reverted.
 *
 * Nothing here reads a source file. Every assertion executes the real module or the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_P0_DB__", "__PTJA_P0_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const out = []; for (const item of items) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_P0_DB__ = db;
  globalThis.__PTJA_P0_ENV__ = env;
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-P0-01 — a package price outside its own effective window is quoted and charged
//
// CONFIRMED independently by both verifiers. Operators schedule prices through a first-class UI control
// ("Effective from" date input on the Pricing Control panel, whitelisted by PATCH /api/pricing-control),
// but resolveLivePrice selected the row on `package_code=? AND active=1` alone and calculatePrice never
// read pkg.effectiveFrom/effectiveTo. A price scheduled for 2027 was therefore quoted for a 2026 stay,
// and a price retired in 2025 was quoted forever.
//
// The asymmetry is what makes it unambiguous rather than a design choice: activeOn() in
// lib/pricing-engine.ts applies exactly this window test to dynamic_pricing_rules. Only the package row
// was exempt. Every priced vertical shares this resolver - grooming, boarding, sitting and training.
// =====================================================================================================

const PKG_COLUMNS = "id,service_code,package_code,name,description,base_price,slot_minutes,blocking_minutes,tax_inclusive,active,version,effective_from,effective_to,updated_by,updated_at";

async function pricingWorld() {
  const { sqlite, db } = world();
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(db);
  const seed = (packageCode, basePrice, effectiveFrom, effectiveTo) =>
    sqlite.prepare(`INSERT OR REPLACE INTO service_packages (${PKG_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,'ptja',0)`)
      .run(`SP-${packageCode}`, "grooming", packageCode, `Pkg ${packageCode}`, "", basePrice, 60, 75, 1, effectiveFrom, effectiveTo);
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  const quote = (packageCode, scheduledStart, fallbackPrice = 1111) =>
    resolveLivePrice(db, { packageCode, fallbackPrice, scheduledStart, cityId: "blr" });
  return { sqlite, db, seed, quote };
}

const IN_2026 = "2026-09-16T05:00:00.000Z";

test("P0-01: a package whose effective window has NOT OPENED is not charged today", async () => {
  // Measured before the fix: {"price":5555,"source":"pricing_control"} for a 2026 stay.
  const { seed, quote } = await pricingWorld();
  seed("future-price", 5555, "2027-01-01", "2027-12-31");
  const result = await quote("future-price", IN_2026, 1111);
  assert.equal(result.price, 1111, "a 2027-only price must not be charged for a 2026 stay");
  assert.equal(result.source, "fallback_default", "an out-of-window package is no package at all");
});

test("P0-01: a package whose effective window has CLOSED is not charged forever", async () => {
  // Measured before the fix: {"price":7777,"source":"pricing_control"} long after the window expired.
  const { seed, quote } = await pricingWorld();
  seed("retired-price", 7777, "2025-01-01", "2025-06-30");
  const result = await quote("retired-price", IN_2026, 1111);
  assert.equal(result.price, 1111, "a price retired in June 2025 must not still be charged in 2026");
  assert.equal(result.source, "fallback_default");
});

test("P0-01: a currently-effective package is still charged - the fix is not a blanket refusal", async () => {
  // Non-vacuity. A window test that rejects everything would also make both cases above pass.
  const { seed, quote } = await pricingWorld();
  seed("current-price", 1499, "2020-01-01", null);
  const result = await quote("current-price", IN_2026, 1111);
  assert.equal(result.price, 1499, "a live catalogue price must still be used");
  assert.equal(result.source, "pricing_control");
});

test("P0-01: an open-ended window (effective_to NULL) stays open", async () => {
  const { seed, quote } = await pricingWorld();
  seed("open-ended", 2499, "2026-01-01", null);
  assert.equal((await quote("open-ended", IN_2026)).price, 2499);
});

test("P0-01: the window boundaries are inclusive on both ends", async () => {
  // The same inclusivity activeOn() already uses for rules: >= from, <= to. A boundary day is INSIDE.
  const { seed, quote } = await pricingWorld();
  seed("bounded", 1799, "2026-09-16", "2026-09-16");
  assert.equal((await quote("bounded", IN_2026)).price, 1799, "the first and last day of the window are inside it");
  assert.equal((await quote("bounded", "2026-09-15T05:00:00.000Z")).source, "fallback_default", "the day before is outside");
  assert.equal((await quote("bounded", "2026-09-17T05:00:00.000Z")).source, "fallback_default", "the day after is outside");
});

test("P0-01: the window is judged against the BOOKING date, not today", async () => {
  // The consequence that makes this a pricing defect rather than a deployment one: the same package
  // must price a 2027 stay at the 2027 price and refuse to price a 2026 stay with it.
  const { seed, quote } = await pricingWorld();
  seed("seasonal", 3999, "2027-01-01", "2027-01-31");
  assert.equal((await quote("seasonal", "2027-01-15T05:00:00.000Z")).price, 3999, "inside the window it applies");
  assert.equal((await quote("seasonal", IN_2026)).source, "fallback_default", "outside it, it does not");
});
