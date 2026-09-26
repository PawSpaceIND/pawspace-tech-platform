/**
 * PawSpace AI's approved offers, executed: GROOM200 (the closing discount the business set) and GROOM400
 * (WATI's ₹400 cross-sell) are built on the server from the live coupon campaigns and catalogue prices,
 * an offer price grounds a reply only when the reply names its code, and an invented code or discount is
 * blocked on the signed-in, WhatsApp and public chat paths alike.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AI_OFFERS_DB__", "__AI_OFFERS_ENV__");
const offersModule = await import("../lib/ai-sales-offers.ts");
const runtime = await import("../lib/ai-grounded-runtime-provider.ts");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}
const fresh = () => { const sqlite = new DatabaseSync(":memory:"); return { sqlite, db: makeD1(sqlite) }; };
const ASOF = Date.UTC(2026, 9, 1);

test("the approved offers are the business's numbers, built from the live campaigns and the catalogue", async () => {
  const { db } = fresh();
  const offers = await offersModule.approvedSalesOffers(db, ASOF);
  const closing = Object.fromEntries(offers.filter((offer) => offer.code === "GROOM200").map((offer) => [offer.package_code, [offer.regular_price, offer.offer_price]]));
  assert.deepEqual(closing, { "dog-bath": [1349, 1149], "dog-basic": [1899, 1699], "dog-makeover": [2399, 2199], "cat-basic": [1899, 1699], "cat-makeover": [2399, 2199] });
  const crossSell = offers.filter((offer) => offer.code === "GROOM400");
  assert.equal(crossSell.length, 6);
  assert.ok(crossSell.every((offer) => offer.discount_amount === 400 && offer.usage === "cross_sell"));
});

test("a paused or expired campaign is no longer an offer the AI may give", async () => {
  const { db, sqlite } = fresh();
  await offersModule.approvedSalesOffers(db, ASOF);
  sqlite.prepare("UPDATE coupon_campaigns SET status='paused' WHERE code='GROOM200'").run();
  assert.ok(!(await offersModule.approvedSalesOffers(db, ASOF)).some((offer) => offer.code === "GROOM200"), "paused in Control > Coupons");
  assert.deepEqual(await offersModule.approvedSalesOffers(db, Date.UTC(2027, 5, 1)), [], "past the validity window");
});

test("an offer price grounds a reply only when the reply names its code", async () => {
  const { db } = fresh();
  const offers = await offersModule.approvedSalesOffers(db, ASOF);
  const catalogue = { grooming: [{ name: "Essential Bath", base_price: 1349 }], approvedOffers: offersModule.offerGroundingRows(offers) };
  assert.equal(runtime.pricesMatchCatalogue("With code GROOM200, Essential Bath comes to ₹1,149 instead of ₹1,349.", catalogue), true);
  assert.equal(runtime.pricesMatchCatalogue("Essential Bath is just ₹1,149 for you today.", { grooming: [{ name: "Essential Bath", base_price: 1349 }], approvedOffers: offersModule.offerGroundingRows(offers) }), false, "the discounted price needs the code");
  assert.equal(runtime.pricesMatchCatalogue("Use GROOM400 for ₹400 off your first grooming.", catalogue), true);
});

test("invented codes, percentages and amounts off are refused; PIN codes and 'the code below' are not codes", async () => {
  const { db } = fresh();
  const offers = await offersModule.approvedSalesOffers(db, ASOF);
  const ok = (reply) => offersModule.offerClaimsApproved(reply, offers);
  assert.equal(ok("With code GROOM200, Complete Makeover comes to ₹2,199."), true);
  assert.equal(ok("You get ₹400 off with GROOM400."), true);
  assert.equal(ok("Use code SAVE50 at checkout."), false, "a code the server never approved");
  assert.equal(ok("Book today and get 20% off!"), false, "no percentage offers exist");
  assert.equal(ok("I can give you 300 off."), false, "an amount off that is not an approved discount");
  assert.equal(ok("I can give you ₹200 off."), false, "an approved amount still needs its code");
  assert.equal(ok("Please share your PIN code 560038 and the address."), true);
  assert.equal(ok("Enter the code below when you pay."), true);
  assert.equal(offersModule.offerClaimsApproved("Use code GROOM200 for ₹200 off.", []), false, "no approved offers means no discount at all");
});

test("the web chat and WhatsApp prompts carry the offer rules; voice does not sell discounts", async () => {
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /at most once/);
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /only after the customer hesitates on price/);
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /Never invent any other code/);
  assert.match(runtime.WEB_CHAT_SALES_DIRECTIVE, /approvedOffers/);
});
