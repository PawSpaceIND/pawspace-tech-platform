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
  const offers = await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  const closing = Object.fromEntries(offers.filter((offer) => offer.code === "GROOM200").map((offer) => [offer.package_code, [offer.regular_price, offer.offer_price]]));
  assert.deepEqual(closing, { "dog-bath": [1349, 1149], "dog-basic": [1899, 1699], "dog-makeover": [2399, 2199], "cat-basic": [1899, 1699], "cat-makeover": [2399, 2199] });
  const crossSell = offers.filter((offer) => offer.code === "GROOM400");
  assert.equal(crossSell.length, 6);
  assert.ok(crossSell.every((offer) => offer.discount_amount === 400 && offer.usage === "cross_sell"));
});

test("a paused or expired campaign is no longer an offer the AI may give", async () => {
  const { db, sqlite } = fresh();
  await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  sqlite.prepare("UPDATE coupon_campaigns SET status='paused' WHERE code='GROOM200'").run();
  assert.ok(!(await offersModule.approvedSalesOffers(db, { asOf: ASOF })).some((offer) => offer.code === "GROOM200"), "paused in Control > Coupons");
  assert.deepEqual(await offersModule.approvedSalesOffers(db, { asOf: Date.UTC(2027, 5, 1) }), [], "past the validity window");
});

test("an offer price grounds a reply only when the reply names its code; a discount is never a price", async () => {
  const { db } = fresh();
  const offers = await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  const catalogue = { grooming: [{ name: "Essential Bath", base_price: 1349 }], approvedOffers: offersModule.offerGroundingRows(offers) };
  const priced = (reply) => runtime.pricesMatchCatalogue(offersModule.withoutApprovedDiscounts(reply, offers), catalogue);
  assert.equal(priced("With code GROOM200, Essential Bath comes to ₹1,149 instead of ₹1,349."), true);
  assert.equal(priced("Essential Bath is just ₹1,149 for you today."), false, "the discounted price needs the code");
  assert.equal(priced("Use GROOM400 for ₹400 off your first grooming."), true, "an approved '₹400 off' is a discount, not a price");
  assert.equal(priced("With GROOM200, add nail clipping for just ₹200."), false, "the ₹200 discount does not ground a ₹200 price");
  assert.equal(priced("Your taxi ride is ₹400 and use GROOM400 for grooming."), false, "the ₹400 discount does not ground a ₹400 fare");
});

test("invented coupon codes are refused however they are written; other sales wording is left alone", async () => {
  const { db } = fresh();
  const offers = await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  const ok = (reply) => offersModule.offerClaimsApproved(reply, offers);
  assert.equal(ok("With code GROOM200, Complete Makeover comes to ₹2,199."), true);
  assert.equal(ok("You get ₹400 off with GROOM400."), true);
  for (const invented of ["Use code SAVE50 at checkout.", "Use coupon code SAVE50 at checkout!", "Use voucher code FLAT500 for extra savings.", "Apply FLAT500 at checkout for a special deal!", "Use code Save50 at checkout", "Use promo code WELCOME10", "Enter discount code PAWS100"]) assert.equal(ok(invented), false, invented);
  assert.equal(ok("With GROOM200 you save ₹300 off."), false, "an amount off next to an approved code must be that code's discount");
  assert.equal(offersModule.offerClaimsApproved("Use code GROOM200 for ₹200 off.", []), false, "a code the customer can no longer redeem is not approved");
  for (const fine of ["Please share your PIN code 560038 and the address.", "Enter the code below when you pay.", "Your case CASE-AB12CD34 is open.", "Pay ₹1,349 by UPI or card.", "Book both dogs together and get ₹200 off per dog with the multi-pet price.", "I can offer you a 10% discount if you confirm today.", "Your dog gets 3 off-leash play sessions a day."]) assert.equal(ok(fine), true, fine);
});

test("an offer is only listed while this customer can redeem it on this channel", async () => {
  const { db, sqlite } = fresh();
  await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY, city_id TEXT)");
  sqlite.prepare("INSERT INTO canonical_customers (id, city_id) VALUES ('CUS-USED','blr'), ('CUS-HYD','hyd'), ('CUS-NEW','blr')").run();
  sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES ('R1','K1','Q1','sales-coupon-groom200','GROOM200','CUS-USED','BK1',200,'consumed',1,1)").run();
  const codes = async (input) => [...new Set((await offersModule.approvedSalesOffers(db, { asOf: ASOF, ...input })).map((offer) => offer.code))].sort();
  assert.deepEqual(await codes({ customerId: "CUS-NEW", channel: "website" }), ["GROOM200", "GROOM400"]);
  assert.deepEqual(await codes({ customerId: "CUS-USED", channel: "website" }), ["GROOM400"], "GROOM200 is once per customer");
  assert.deepEqual(await codes({ customerId: "CUS-HYD", channel: "whatsapp" }), [], "the campaigns serve Bangalore");
  assert.deepEqual(await codes({ channel: "partner_app" }), [], "not a channel the campaigns serve");
  sqlite.prepare("UPDATE coupon_campaigns SET total_limit=1 WHERE id='sales-coupon-groom200'").run();
  assert.deepEqual(await codes({ customerId: "CUS-NEW", channel: "website" }), ["GROOM400"], "the campaign's total limit is used up");
  assert.deepEqual(await offersModule.activeCrossSell(db, { customerId: "CUS-NEW", channel: "whatsapp" }), { code: "GROOM400", cityIds: ["blr"] });
  assert.equal(await offersModule.activeCrossSell(db, { customerId: "CUS-HYD", channel: "whatsapp" }), null);
});

test("a renamed code is still found by its campaign, and does not re-seed on every turn", async () => {
  const { db, sqlite } = fresh();
  await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  sqlite.prepare("UPDATE coupon_campaigns SET code='GROOM250' WHERE id='sales-coupon-groom200'").run();
  const before = sqlite.prepare("SELECT COUNT(*) n FROM coupon_campaigns").get().n;
  const offers = await offersModule.approvedSalesOffers(db, { asOf: ASOF });
  assert.ok(offers.some((offer) => offer.code === "GROOM250" && offer.usage === "closing"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_campaigns").get().n, before, "no new GROOM200 row is seeded beside the renamed one");
});

test("the web chat and WhatsApp prompts carry the coupon rules without overriding a sales lever", async () => {
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /at most once/);
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /only after the customer hesitates on price/);
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /Never invent, guess or alter a coupon code/);
  assert.match(offersModule.APPROVED_OFFERS_DIRECTIVE, /authorized sales lever stated elsewhere/);
  assert.match(runtime.WEB_CHAT_SALES_DIRECTIVE, /approvedOffers/);
});
