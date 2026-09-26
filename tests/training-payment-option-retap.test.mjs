/*
 * Mobile Training review step: re-tapping the payment option that is already selected must change nothing.
 *
 * Found while investigating staging master E2E run 36243387701 (row 10, UATCARE100 at 100%) and reproduced in
 * headless Chromium with the real TrainingFlow: each option's onClick cleared the server quote, but the quote
 * effect only re-runs when paymentMode, couponCode or couponQuoteId change. Tapping "Pay 100% upfront" again after
 * a coupon was applied left "Refreshing server quote…" on the pay button for good - no request in flight, no
 * alert, and no way to pay. The same held for "Pay 50% upfront".
 *
 * Both buttons now go through choosePaymentOption. These cases run it against a model of the review step whose
 * re-quote trigger is the effect's real dependency list, and pin that the buttons are wired to it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRAINING_PAYMENT_RETAP_DB__");
const { choosePaymentOption } = await import("../app/mobile-app/training-flow.tsx");
const flow = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");

const QUOTE = { quoteId: "TQ-SHOWN", amountDueNow: 11_900 };
/** The review step's state, and the one thing that brings a cleared quote back: the quote effect re-running. */
function reviewStep(initial) {
  const state = { quote: QUOTE, ...initial }, calls = [];
  const set = {
    mode: (value) => { calls.push(["mode", value]); state.mode = value; },
    coupon: (code, quoteId) => { calls.push(["coupon", code, quoteId]); state.couponCode = code; state.couponQuoteId = quoteId; },
    quote: (value) => { calls.push(["quote", value]); state.quote = value; },
  };
  const dependencies = () => JSON.stringify([state.mode, state.couponCode, state.couponQuoteId]);
  return {
    state, calls,
    tap(next) {
      const before = dependencies(), changed = choosePaymentOption(state.mode, next, set), requotes = dependencies() !== before;
      // "Refreshing server quote…" with nothing coming to replace it is the stuck state.
      assert.ok(state.quote !== null || requotes, `tapping ${next} from ${JSON.stringify(before)} cleared the quote without re-quoting`);
      return { changed, requotes };
    },
  };
}

test("re-tapping the selected option keeps the quote the pay button shows", () => {
  const withCoupon = reviewStep({ mode: "full", couponCode: "UATCARE100", couponQuoteId: "CPQ-APPLIED" });
  assert.deepEqual(withCoupon.tap("full"), { changed: false, requotes: false });
  assert.deepEqual(withCoupon.calls, [], "nothing is set, so nothing is cleared");
  assert.deepEqual(withCoupon.state, { quote: QUOTE, mode: "full", couponCode: "UATCARE100", couponQuoteId: "CPQ-APPLIED" }, "the applied coupon and its quote survive");

  const split = reviewStep({ mode: "half", couponCode: "", couponQuoteId: "" });
  assert.deepEqual(split.tap("half"), { changed: false, requotes: false });
  assert.deepEqual(split.calls, []);
  assert.equal(split.state.quote, QUOTE);
});

test("switching options still clears the quote for the effect to re-price, and 50% drops the coupon", () => {
  const step = reviewStep({ mode: "half", couponCode: "", couponQuoteId: "" });
  assert.deepEqual(step.tap("full"), { changed: true, requotes: true });
  assert.deepEqual(step.calls, [["mode", "full"], ["quote", null]]);

  step.state.couponCode = "UATCARE100"; step.state.couponQuoteId = "CPQ-APPLIED"; step.state.quote = QUOTE; step.calls.length = 0;
  assert.deepEqual(step.tap("half"), { changed: true, requotes: true });
  assert.deepEqual(step.calls, [["mode", "half"], ["coupon", "", ""], ["quote", null]], "coupons need 100% payment");

  // Any sequence of taps, from either option, never strands the pay button.
  for (const start of ["half", "full"]) {
    const walk = reviewStep({ mode: start, couponCode: start === "full" ? "WELCOME" : "", couponQuoteId: start === "full" ? "CPQ-W" : "" });
    for (const next of ["full", "full", "half", "half", "full", "half", "half"]) { walk.tap(next); if (walk.state.quote === null) walk.state.quote = { ...QUOTE, quoteId: `TQ-${walk.calls.length}` }; }
  }
});

test("both payment buttons are wired through choosePaymentOption, and the model re-quotes on the effect's real dependencies", () => {
  const options = flow.slice(flow.indexOf("<div className={styles.paymentOptions}>"), flow.indexOf("</div>", flow.indexOf("Pay 100% upfront")));
  assert.match(options, /onClick=\{\(\) => choosePaymentOption\(paymentMode,"half",paymentSetters\)\}><i>\{paymentMode === "half"/);
  assert.match(options, /onClick=\{\(\) => choosePaymentOption\(paymentMode,"full",paymentSetters\)\}><i>\{paymentMode === "full"/);
  assert.doesNotMatch(options, /setCheckoutQuote\(null\)/, "no button clears the quote on its own");
  assert.match(flow, /const paymentSetters=\{mode:setPaymentMode,coupon:\(code:string,quoteId:string\)=>\{setCouponCode\(code\);setCouponQuoteId\(quoteId\);\},quote:setCheckoutQuote\};/);
  assert.match(flow, /\},\[stage,plan\.packageCode,plan\.sessions,selectedPets\.length,paymentMode,couponCode,couponQuoteId,frequency,time,startDateIndex,selectedStartIso\]\);/, "the quote effect re-runs on the mode and coupon, which is what the model above treats as a re-quote");
});
