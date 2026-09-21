import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CUST_L_D06_DB__", "__CUST_L_D06_ENV__");

// ---------------------------------------------------------------------------------------------------
// CUST-L-D06 — /mobile-app Book -> Review: switching the payment mode dropped an applied coupon
// ("APPLIED" disappeared, only a small "Booking details changed..." line) while Confirm stayed
// enabled, so the booking was created at full price (PS-UAT-MUBC8VUJ-597C, totalAmount 1241 instead of
// the couponed 1141).
//
// Root cause, traced to two places:
//   1. CouponField's own "the commercial key this coupon was quoted against has changed" effect
//      reported the drop as onDiscountChange(0, "") - an empty code, which reads identically to "no
//      coupon was ever involved".
//   2. grooming-flow.tsx additionally reset couponCode to "" on every payment-mode toggle through its
//      own couponBasketKey effect (paymentMode was a member of that key even though CouponField never
//      unmounts across a payment-mode switch), racing CouponField's own report and erasing it either way.
//
// Both defects fed the SAME guard used at Confirm time: `couponCode && !couponQuoteId` means "a coupon
// is pending reapplication - block". Once the code is wiped to "" the guard is blind. lib/coupon-
// reapply-guard.ts is now the single, tested source of truth both call sites use, and this suite pins
// both its logic and that both files are actually wired to it (not a re-derived inline copy that could
// drift back to the bug).
// ---------------------------------------------------------------------------------------------------

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("CUST-L-D06 unit: a coupon code without its governed quote id must block Confirm", async () => {
  const { couponNeedsReapply } = await import("../lib/coupon-reapply-guard.ts");
  assert.equal(couponNeedsReapply("UATCARE100", ""), true, "code present, no quote id -> stale, must block");
  assert.equal(couponNeedsReapply("UATCARE100", "quote_123"), false, "applied with a live quote id -> fine");
  assert.equal(couponNeedsReapply("", ""), false, "no coupon ever involved -> nothing to block");
  assert.equal(couponNeedsReapply("  ", ""), false, "whitespace-only code is not a pending coupon");
});

test("CUST-L-D06 unit: a dropped coupon quote is reported with its code, never blanked", async () => {
  const { droppedCouponReport } = await import("../lib/coupon-reapply-guard.ts");
  assert.deepEqual(droppedCouponReport("UATCARE100"), { discount: 0, code: "UATCARE100" });
  // The whole defect was "" reading as "nothing happened" - the code must survive the drop.
  assert.notEqual(droppedCouponReport("UATCARE100").code, "");
});

test("CUST-L-D06 wiring: CouponField reports the dropped code through the shared guard, not an empty string", () => {
  const field = read("app/mobile-app/coupon-field.tsx");
  assert.match(field, /droppedCouponReport/, "the invalidate effect must go through the shared helper");
  // The stale-quote invalidate effect specifically must report the report's own code, not a hardcoded
  // "". (A DIFFERENT onDiscountChange(0, "") remains further down for the user explicitly clearing the
  // input themselves - that one is correct and must stay untouched.)
  const invalidateEffect = field.slice(field.indexOf("appliedCommercialKey.current === commercialKey"), field.indexOf("appliedCommercialKey.current === commercialKey") + 700);
  assert.match(invalidateEffect, /onDiscountChange\(report\.discount,\s*report\.code\)/, 'the drop must report report.code, not a hardcoded ""');
});

test("CUST-L-D06 wiring: grooming-flow blocks Confirm via the shared guard and no longer resets the coupon on a payment-mode switch alone", () => {
  const flow = read("app/mobile-app/grooming-flow.tsx");
  assert.match(flow, /couponNeedsReapply\(couponCode,couponQuoteId\)/, "checkoutReady must consult the shared guard");
  assert.match(flow, /couponPendingReapply/, "a pending-reapply flag must gate Confirm and be shown to the customer");
  // The basket-reset effect must not include `pay`: CouponField stays mounted across a payment-mode
  // toggle and already invalidates + reports the drop itself; re-including `pay` here reintroduces the
  // race that let the coupon code get wiped before Confirm's guard could see it.
  const basketKeyLine = flow.split("\n").find((line) => line.includes("const couponBasketKey="));
  assert.ok(basketKeyLine, "couponBasketKey line must exist");
  assert.doesNotMatch(basketKeyLine, /\bpay\b/, "couponBasketKey must not react to `pay` any more");
});

test("CUST-L-D06 end to end: the exact reported sequence (apply, then switch payment mode) leaves Confirm blocked, not silently full price", async () => {
  // Simulates the customer-visible state machine driving CouponField + grooming-flow's onDiscountChange
  // handler and Confirm guard, without needing a DOM: the same (discount, code, quoteId) triple that
  // would flow through props/state in the real components.
  const { couponNeedsReapply, droppedCouponReport } = await import("../lib/coupon-reapply-guard.ts");
  let discount = 0, couponCode = "", couponQuoteId = "";
  const onDiscountChange = (value, code, quoteId) => { discount = value; couponCode = code; couponQuoteId = quoteId || ""; };

  // "Apply UATCARE100 -> 'UAT coupon applied - you save Rs 100'"
  onDiscountChange(100, "UATCARE100", "quote_abc");
  assert.equal(couponNeedsReapply(couponCode, couponQuoteId), false, "freshly applied coupon must not block Confirm");

  // "Tap Pay online, then Pay after service" - CouponField's own commercialKey (which includes
  // paymentMode) now differs from the key the quote was applied under, so it reports the drop.
  const report = droppedCouponReport(couponCode);
  onDiscountChange(report.discount, report.code);

  assert.equal(discount, 0, "the discount must not silently keep applying after the payment mode changed");
  assert.equal(couponCode, "UATCARE100", "the code must survive the drop so the guard can see it");
  assert.equal(couponQuoteId, "", "the stale quote id must not survive the drop");
  assert.equal(couponNeedsReapply(couponCode, couponQuoteId), true, "Confirm must now be blocked, not silently proceed at full price");
});
