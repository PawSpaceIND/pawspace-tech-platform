/**
 * TEST / LOCAL. Governed Grooming quote -> explicit customer acceptance -> canonical booking linkage.
 * Price authority is the existing live Grooming governance + add-on catalogue + the customer's coupon quote; the quote pins
 * the FINAL terms, the booking re-governs them, and acceptance compares in exact paise. Same shared harness, TEST actors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const future = (hour) => { const now = Date.now(); const start = new Date(now + 3 * 86_400_000); start.setUTCHours(hour, 30, 0, 0); if (start.getTime() <= now + 2 * 60 * 60_000) start.setUTCDate(start.getUTCDate() + 1); return start.toISOString(); };
const QUOTE = "../../app/api/grooming-commercial/route.ts", BOOK = "../../app/api/canonical-bookings/route.ts", SCHED = "../../app/api/uat-scheduling/route.ts";
const ADD_ON = "Full-body oil massage";

async function world(t, suffix, hour, extra = {}) {
  const ctx = await setupJourney(); t.after(ctx.close);
  const cfg = { customerId: `CUST-ATLAS-${suffix}`, phone: `+9199000007${suffix.slice(-2)}`, petSourceId: `PET-ATLAS-${suffix}`, cityId: "blr", zoneId: "blr-east", pincode: "560038", preferredProviderId: "groom_arun", groupId: `ATLAS-${suffix}`, start: future(hour), ...extra };
  await seedOwnedPet(ctx.db, cfg.customerId, cfg.petSourceId, "Juno");
  const cookie = await sessionCookie(ctx.db, "customer", cfg.customerId, `customer:${cfg.customerId}`);
  const start = new Date(cfg.start), end = new Date(start.getTime() + 2 * 60 * 60_000);
  const scheduled = await routeCall(SCHED, "POST", "/api/uat-scheduling", { clientRequestId: cfg.groupId, customerId: cfg.customerId, petIds: [cfg.petSourceId], serviceCode: "grooming", cityId: cfg.cityId, zoneId: cfg.zoneId, serviceAddress: "TEST address", servicePincode: cfg.pincode, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), preferredProviderId: cfg.preferredProviderId }, cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  return { ctx, cfg, cookie, slot: { provider: scheduled.body.data.provider, start, end } };
}
const quoteBody = (cfg, slot, over = {}) => ({ customerId: cfg.customerId, packageCode: "dog-basic", pets: [{ sourceId: cfg.petSourceId }], cityId: cfg.cityId, zoneId: cfg.zoneId, scheduledStart: slot.start.toISOString(), paymentMode: "prepaid", ...over });
async function quoteFor(w, over = {}) { const q = await routeCall(QUOTE, "POST", "/api/grooming-commercial", quoteBody(w.cfg, w.slot, over), w.cookie); assert.equal(q.status, 201, JSON.stringify(q.body)); return q.body.data.quote; }
function bookingBody(cfg, quote, slot, over = {}) {
  return { idempotencyKey: cfg.groupId, scheduleGroupId: cfg.groupId, customer: { id: cfg.customerId, name: "Atlas Quote Customer", primaryPhone: cfg.phone }, pets: [{ sourceId: cfg.petSourceId, name: "Juno", species: "dog", breed: "Indie", vaccinationStatus: "vaccinated" }], cityId: cfg.cityId, zoneId: cfg.zoneId, serviceCode: "grooming", packageCode: quote.packageCode, packageName: quote.packageName, scheduledStart: slot.start.toISOString(), scheduledEnd: slot.end.toISOString(), provider: slot.provider, totalAmount: quote.finalPayable, amountDueNow: quote.amountDueNow, payment: { method: "upi", mode: quote.paymentMode, status: "created", detail: "TEST quote acceptance" }, pricing: { discount: quote.couponDiscount, addOns: quote.addOns, groomingQuoteId: quote.quoteId, ...(quote.couponQuoteId ? { couponCode: "UATCARE100", couponQuoteId: quote.couponQuoteId } : {}) }, ...over };
}
const book = (w, body) => routeCall(BOOK, "POST", "/api/canonical-bookings", body, w.cookie);
const count = (w, sql) => w.ctx.sqlite.prepare(sql).get().c;
async function expectRefusal(promise, pattern) { let caught = null; try { await promise; } catch (e) { caught = e; } assert.ok(caught instanceof Response, `expected a governed Response refusal, got ${String(caught)}`); assert.equal(caught.status, 409); assert.match(await caught.text(), pattern); }

test("TEST (finding 1): quote pins FINAL terms with add-ons and coupon; acceptance compares the final governed terms", async (t) => {
  const w = await world(t, "F101", 4);
  const { quoteCoupon } = await import("../lib/coupon-governance.ts");
  const { quoteGroomingBookingWithLiveMultiPet } = await import("../lib/live-grooming-governance.ts");
  const base = await quoteGroomingBookingWithLiveMultiPet(w.ctx.db, { packageCode: "dog-basic", pets: [{ species: "dog" }], paymentMode: "prepaid", cityId: w.cfg.cityId, zoneId: w.cfg.zoneId, scheduledStart: w.slot.start.toISOString() });
  const gross = base.totalAmount + 299; // catalogue add-on price, cross-checked by the route's own add-on map at acceptance
  const coupon = await quoteCoupon(w.ctx.db, { code: "UATCARE100", customerId: w.cfg.customerId, serviceCode: "grooming", cityId: w.cfg.cityId, channel: "customer_app", packageCode: "dog-basic", orderValue: gross, paymentMode: "full", isSubscription: false });
  assert.equal(coupon.valid, true, JSON.stringify(coupon));
  const quote = await quoteFor(w, { addOns: [ADD_ON], couponQuoteId: coupon.quoteId });
  assert.equal(quote.baseAmount, base.totalAmount); assert.equal(quote.addOnTotal, 299); assert.deepEqual(quote.addOns, [ADD_ON]);
  assert.equal(quote.couponDiscount, coupon.discount); assert.equal(quote.finalPayable, coupon.finalAmount); assert.equal(quote.amountDueNow, coupon.finalAmount);
  assert.ok(quote.commercialPolicyVersion, "commercial policy version pinned"); assert.ok(quote.catalogueVersion);
  // Add-on silently dropped while keeping the same final payable -> refused (final terms, not just a number).
  const dropped = await book(w, bookingBody(w.cfg, quote, w.slot, { pricing: { discount: quote.couponDiscount, groomingQuoteId: quote.quoteId, couponCode: "UATCARE100", couponQuoteId: quote.couponQuoteId } }));
  assert.equal(dropped.status, 409, JSON.stringify(dropped.body));
  // Coupon removed (full gross paid) -> refused: the quote was accepted WITH the coupon.
  const noCoupon = await book(w, bookingBody(w.cfg, quote, w.slot, { totalAmount: gross, amountDueNow: gross, pricing: { discount: 0, addOns: quote.addOns, groomingQuoteId: quote.quoteId } }));
  assert.equal(noCoupon.status, 409, JSON.stringify(noCoupon.body));
  assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 0);
  const accepted = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const bookingId = accepted.body.data.bookingId;
  const booking = w.ctx.sqlite.prepare("SELECT total_amount,pricing_json FROM canonical_bookings WHERE id=?").get(bookingId);
  assert.equal(booking.total_amount, quote.finalPayable, "booking carries the final payable agreed on the quote");
  const pricing = JSON.parse(booking.pricing_json); assert.equal(pricing.groomingQuoteId, quote.quoteId); assert.deepEqual(pricing.addOns, [ADD_ON]); assert.equal(pricing.couponQuoteId, coupon.quoteId);
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).status, "used");
  assert.equal(count(w, "SELECT COUNT(*) c FROM coupon_redemptions WHERE status='consumed'"), 1);
});

test("TEST (finding 2): unequal paise are unequal; an expired coupon quote is refused at quote creation", async (t) => {
  const w = await world(t, "F102", 5);
  const { governGroomingQuoteAcceptance, createGroomingQuote, toMinor, sameMinor } = await import("../lib/grooming-commercial-governance.ts");
  assert.equal(sameMinor(1349, 1349.49), false); assert.equal(toMinor(1349.49), 134949); assert.equal(sameMinor(1349.49, 1349.49), true);
  const quote = await quoteFor(w);
  const base = { quoteId: quote.quoteId, customerId: w.cfg.customerId, packageCode: quote.packageCode, pets: [{ sourceId: w.cfg.petSourceId, species: "dog" }], addOns: [], cityId: w.cfg.cityId, zoneId: w.cfg.zoneId, scheduledStart: w.slot.start.toISOString(), paymentMode: "prepaid", couponQuoteId: null };
  const governed = { baseAmount: quote.baseAmount, addOnTotal: 0, couponDiscount: 0, finalPayable: quote.finalPayable, amountDueNow: quote.amountDueNow };
  await governGroomingQuoteAcceptance(w.ctx.db, { ...base, governed });
  for (const delta of [0.49, 0.01, -0.01]) await assert.rejects(governGroomingQuoteAcceptance(w.ctx.db, { ...base, governed: { ...governed, finalPayable: quote.finalPayable + delta, amountDueNow: quote.amountDueNow + delta } }), (e) => e instanceof Response && e.status === 409);
  await assert.rejects(governGroomingQuoteAcceptance(w.ctx.db, { ...base, governed: { ...governed, baseAmount: quote.baseAmount + 0.49 } }), (e) => e instanceof Response && e.status === 409);
  // Expired coupon quote: the coupon row is open but past expires_at -> quote creation refuses (no 'open' shortcut).
  const { quoteCoupon } = await import("../lib/coupon-governance.ts");
  const coupon = await quoteCoupon(w.ctx.db, { code: "UATCARE100", customerId: w.cfg.customerId, serviceCode: "grooming", cityId: w.cfg.cityId, channel: "customer_app", packageCode: "dog-basic", orderValue: quote.baseAmount, paymentMode: "full", isSubscription: false });
  w.ctx.sqlite.prepare("UPDATE coupon_quotes SET expires_at=? WHERE id=?").run(Date.now() - 1, coupon.quoteId);
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(coupon.quoteId).status, "open", "row still says open; expiry must be checked");
  const expired = await routeCall(QUOTE, "POST", "/api/grooming-commercial", quoteBody(w.cfg, w.slot, { couponQuoteId: coupon.quoteId }), w.cookie);
  assert.equal(expired.status, 409); assert.match(String(expired.body.error), /expired/);
  await assert.rejects(createGroomingQuote(w.ctx.db, { customerId: w.cfg.customerId, packageCode: "dog-basic", pets: [{ sourceId: w.cfg.petSourceId }], cityId: w.cfg.cityId, zoneId: w.cfg.zoneId, scheduledStart: w.slot.start.toISOString(), paymentMode: "prepaid", couponQuoteId: coupon.quoteId }), (e) => e instanceof Response && e.status === 409);
});

test("TEST (finding 3): declared owned pets and catalogue/pricing scope are pinned and compared; ownership guards preserved", async (t) => {
  const w = await world(t, "F103", 6);
  await seedOwnedPet(w.ctx.db, w.cfg.customerId, "PET-ATLAS-F103-B", "Rex"); // second owned dog, same species/count
  const quote = await quoteFor(w);
  assert.deepEqual(quote.pets, [{ sourceId: w.cfg.petSourceId, species: "dog" }]);
  // Same-count pet substitution -> refused.
  const swapped = await book(w, bookingBody(w.cfg, quote, w.slot, { pets: [{ sourceId: "PET-ATLAS-F103-B", name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "vaccinated" }] }));
  assert.equal(swapped.status, 409, JSON.stringify(swapped.body)); assert.match(String(swapped.body.error), /pets/);
  // Declaring someone else's pet, or an unsaved pet, at quote time is refused.
  const notOwned = await routeCall(QUOTE, "POST", "/api/grooming-commercial", quoteBody(w.cfg, w.slot, { pets: [{ sourceId: "PET-NOT-MINE" }] }), w.cookie);
  assert.equal(notOwned.status, 409); assert.match(String(notOwned.body.error), /saved pet/);
  const other = await sessionCookie(w.ctx.db, "customer", "CUST-ATLAS-OTHER", "customer:CUST-ATLAS-OTHER");
  assert.equal((await routeCall(QUOTE, "POST", "/api/grooming-commercial", quoteBody(w.cfg, w.slot), other)).status, 403);
  // Catalogue / breakdown drift with equal totals -> refused.
  const { governGroomingQuoteAcceptance } = await import("../lib/grooming-commercial-governance.ts");
  const base = { quoteId: quote.quoteId, customerId: w.cfg.customerId, packageCode: quote.packageCode, pets: [{ sourceId: w.cfg.petSourceId, species: "dog" }], addOns: [], cityId: w.cfg.cityId, zoneId: w.cfg.zoneId, scheduledStart: w.slot.start.toISOString(), paymentMode: "prepaid", couponQuoteId: null, governed: { baseAmount: quote.baseAmount, addOnTotal: 0, couponDiscount: 0, finalPayable: quote.finalPayable, amountDueNow: quote.amountDueNow, catalogueVersion: quote.catalogueVersion, pricingBreakdown: quote.pricingBreakdown, commercialPolicyVersion: quote.commercialPolicyVersion } };
  await governGroomingQuoteAcceptance(w.ctx.db, base);
  await expectRefusal(governGroomingQuoteAcceptance(w.ctx.db, { ...base, governed: { ...base.governed, catalogueVersion: quote.catalogueVersion + "-changed" } }), /catalogue changed/);
  await expectRefusal(governGroomingQuoteAcceptance(w.ctx.db, { ...base, governed: { ...base.governed, pricingBreakdown: { ...(quote.pricingBreakdown ?? {}), gstRate: 99 } } }), /breakdown changed/);
  await expectRefusal(governGroomingQuoteAcceptance(w.ctx.db, { ...base, governed: { ...base.governed, commercialPolicyVersion: "blr:all:other:v9" } }), /policy changed/);
  // Species cross-check uses the saved pet, not the client claim.
  await expectRefusal(governGroomingQuoteAcceptance(w.ctx.db, { ...base, pets: [{ sourceId: w.cfg.petSourceId, species: "cat" }] }), /pets/);
  const accepted = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

test("TEST (finding 4): consumption is atomic with the booking; injected batch failure leaves no partial state; exact-key replay and concurrent acceptance", async (t) => {
  const w = await world(t, "F104", 7);
  const quote = await quoteFor(w);
  // Injected failure in the booking batch: nothing durable, quote still open and reusable.
  let armed = true;
  w.ctx.db.beforeBatch = async (items) => { if (armed && items.some((s) => /INSERT INTO canonical_bookings/.test(s._sql))) { armed = false; throw new Error("TEST injected batch failure"); } };
  const failed = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.ok(failed.status >= 500 || failed.status === 409, JSON.stringify(failed.body));
  assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 0); assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 0);
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).status, "open");
  w.ctx.db.beforeBatch = null;
  // Retry with the same key succeeds and consumes in the same batch.
  const ok = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const bookingId = ok.body.data.bookingId;
  assert.deepEqual({ ...w.ctx.sqlite.prepare("SELECT status,used_booking_id FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId) }, { status: "used", used_booking_id: bookingId });
  assert.equal(w.ctx.sqlite.prepare("SELECT booking_id FROM grooming_booking_quote_links WHERE quote_id=?").get(quote.quoteId).booking_id, bookingId);
  // Exact-key replay: same bundle, no new writes, quote still used once.
  const replay = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(replay.body.data.duplicatePrevented, true, JSON.stringify(replay.body)); assert.equal(replay.body.data.bookingId, bookingId);
  assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 1); assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 1);
  // Reconciliation is idempotent and never un-consumes.
  const { reconcileGroomingQuoteLink } = await import("../lib/grooming-commercial-governance.ts");
  assert.deepEqual(await reconcileGroomingQuoteLink(w.ctx.db, bookingId), { linked: true, quoteId: quote.quoteId, repaired: false, staleLinkDetected: false });
  w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET status='open',used_booking_id=NULL WHERE id=?").run(quote.quoteId); // simulate a torn historical row
  assert.equal((await reconcileGroomingQuoteLink(w.ctx.db, bookingId)).repaired, true);
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).status, "used");
  // Concurrent acceptance of ONE fresh quote by two different bookings: exactly one wins, the other fails as a whole batch.
  const w2 = await world(t, "F105", 8);
  const q2 = await quoteFor(w2);
  const second = { ...w2.cfg, groupId: "ATLAS-F105-B" };
  const sched2 = await routeCall(SCHED, "POST", "/api/uat-scheduling", { clientRequestId: second.groupId, customerId: second.customerId, petIds: [second.petSourceId], serviceCode: "grooming", cityId: second.cityId, zoneId: second.zoneId, serviceAddress: "TEST address", servicePincode: second.pincode, scheduledStart: w2.slot.start.toISOString(), scheduledEnd: w2.slot.end.toISOString(), preferredProviderId: second.preferredProviderId }, w2.cookie);
  const slot2 = sched2.status === 200 ? { provider: sched2.body.data.provider, start: w2.slot.start, end: w2.slot.end } : w2.slot;
  const [a, b] = await Promise.all([book(w2, bookingBody(w2.cfg, q2, w2.slot)), book(w2, bookingBody(second, q2, slot2))]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify([a.body, b.body]));
  assert.equal(count(w2, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 1);
  assert.equal(count(w2, "SELECT COUNT(*) c FROM canonical_bookings"), 1, "the losing acceptance leaves no booking");
  assert.equal(w2.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(q2.quoteId).status, "used");
});

test("TEST: bookings without a quote keep the existing governed path (optional integration)", async (t) => {
  const w = await world(t, "F106", 9);
  const quote = await quoteFor(w);
  const plain = await book(w, bookingBody(w.cfg, quote, w.slot, { pricing: { discount: 0 } }));
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 0);
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).status, "open");
});

test("TEST (P1): eligibility is enforced INSIDE the booking transaction: expiry or state change between validation and batch aborts every write", async (t) => {
  const w = await world(t, "F107", 10);
  const quote = await quoteFor(w);
  const expireBetween = async (items) => { if (items.some((s) => /INSERT INTO canonical_bookings/.test(s._sql))) w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET expires_at=? WHERE id=?").run(Date.now() - 1, quote.quoteId); };
  w.ctx.db.beforeBatch = expireBetween;
  const expiredAtCommit = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(expiredAtCommit.status, 409, JSON.stringify(expiredAtCommit.body)); assert.equal(expiredAtCommit.body.code, "grooming_quote_not_acceptable");
  assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 0); assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 0); assert.equal(count(w, "SELECT COUNT(*) c FROM provider_work_orders"), 0); assert.equal(count(w, "SELECT COUNT(*) c FROM booking_payments"), 0);
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).status, "open", "an aborted acceptance never consumes");
  w.ctx.db.beforeBatch = null;
  // State change: another path consumes the quote between validation and batch.
  const q2 = await quoteFor(w);
  w.ctx.db.beforeBatch = async (items) => { if (items.some((s) => /INSERT INTO canonical_bookings/.test(s._sql))) w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET status='used',used_booking_id='OTHER' WHERE id=?").run(q2.quoteId); };
  const raced = await book(w, bookingBody(w.cfg, q2, w.slot));
  assert.equal(raced.status, 409, JSON.stringify(raced.body)); assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 0); assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 0);
  w.ctx.db.beforeBatch = null;
  // The reviewer's supplied-statement canary: the statements alone, against an expired quote, cannot commit a link.
  const { groomingQuoteAcceptanceStatements } = await import("../lib/grooming-commercial-governance.ts");
  const q3 = await quoteFor(w);
  w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET expires_at=? WHERE id=?").run(Date.now() - 1, q3.quoteId);
  await assert.rejects(w.ctx.db.batch(groomingQuoteAcceptanceStatements(w.ctx.db, q3.quoteId, "BKG-CANARY", w.cfg.customerId)), /grooming_booking_quote_links|constraint/i);
  assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 0); assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(q3.quoteId).status, "open");
  // Foreign customer id in the statements (ownership enforced in-transaction as well).
  const q4 = await quoteFor(w);
  await assert.rejects(w.ctx.db.batch(groomingQuoteAcceptanceStatements(w.ctx.db, q4.quoteId, "BKG-FOREIGN", "CUST-SOMEONE-ELSE")));
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(q4.quoteId).status, "open");
  // A healthy acceptance still works after all of that.
  const ok = await book(w, bookingBody(w.cfg, q4, w.slot));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("TEST (P2): normal-route exact-key replay reports governed reconciliation of injected historical partial state; stale links are detected, never legitimized", async (t) => {
  const w = await world(t, "F108", 11);
  const quote = await quoteFor(w);
  const ok = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const bookingId = ok.body.data.bookingId;
  // Healthy replay: consistent, nothing repaired, no duplicate.
  let replay = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(replay.body.data.duplicatePrevented, true); assert.deepEqual({ ...replay.body.data.quoteReconciliation }, { linked: true, quoteId: quote.quoteId, repaired: false, staleLinkDetected: false });
  // Injected historical partial state (pre-guard code): link present, quote torn back to open, link written before expiry.
  w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET status='open',used_booking_id=NULL,used_at=NULL WHERE id=?").run(quote.quoteId);
  replay = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(replay.body.data.duplicatePrevented, true, JSON.stringify(replay.body)); assert.equal(replay.body.data.bookingId, bookingId);
  assert.equal(replay.body.data.quoteReconciliation.repaired, true); assert.equal(replay.body.data.quoteReconciliation.staleLinkDetected, false);
  assert.deepEqual({ ...w.ctx.sqlite.prepare("SELECT status,used_booking_id FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId) }, { status: "used", used_booking_id: bookingId });
  assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 1); assert.equal(count(w, "SELECT COUNT(*) c FROM grooming_booking_quote_links"), 1);
  // Stale link: written AFTER quote expiry. Reported, left untouched, no re-consumption, no duplicate booking.
  w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET status='open',used_booking_id=NULL,used_at=NULL,expires_at=? WHERE id=?").run(Date.now() - 60_000, quote.quoteId);
  w.ctx.sqlite.prepare("UPDATE grooming_booking_quote_links SET created_at=? WHERE quote_id=?").run(Date.now(), quote.quoteId);
  replay = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(replay.body.data.duplicatePrevented, true); assert.equal(replay.body.data.quoteReconciliation.staleLinkDetected, true); assert.equal(replay.body.data.quoteReconciliation.repaired, false); assert.equal(replay.body.data.quoteReconciliation.reason, "link_written_after_quote_expiry");
  assert.equal(w.ctx.sqlite.prepare("SELECT status FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).status, "open", "a stale acceptance is never retroactively consumed");
  assert.equal(count(w, "SELECT COUNT(*) c FROM canonical_bookings"), 1);
  // A quote used by ANOTHER booking but linked here is also only reported.
  w.ctx.sqlite.prepare("UPDATE grooming_commercial_quotes SET status='used',used_booking_id='SOME-OTHER',expires_at=? WHERE id=?").run(Date.now() + 60_000, quote.quoteId);
  w.ctx.sqlite.prepare("UPDATE grooming_booking_quote_links SET created_at=? WHERE quote_id=?").run(Date.now() - 1, quote.quoteId);
  replay = await book(w, bookingBody(w.cfg, quote, w.slot));
  assert.equal(replay.body.data.quoteReconciliation.reason, "quote_used_by_other_booking"); assert.equal(w.ctx.sqlite.prepare("SELECT used_booking_id FROM grooming_commercial_quotes WHERE id=?").get(quote.quoteId).used_booking_id, "SOME-OTHER");
  // Replay WITHOUT a quote id does not touch reconciliation.
  replay = await book(w, bookingBody(w.cfg, quote, w.slot, { pricing: { discount: 0 } }));
  assert.equal(replay.body.data.duplicatePrevented, true); assert.equal(replay.body.data.quoteReconciliation, undefined);
});
