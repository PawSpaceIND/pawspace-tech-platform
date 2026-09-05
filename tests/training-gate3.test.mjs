import test from "node:test";
import assert from "node:assert/strict";
import {
  freshTrainingWorld,
  futureTrainingStart,
  createTrainingQuote,
  captureTrainingQuoteSandbox,
  collectTrainingRemainingBalanceSandbox,
  requireTrainingQuoteSandboxCapture,
  consumeTrainingQuote,
  expectResponseRefusal,
} from "./helpers/training-gate-harness.mjs";

test("Training commercial truth is server-quoted and linked exactly once", async () => {
  const world = freshTrainingWorld();
  const quote = await createTrainingQuote(world.db, {
    packageCode: "training-4-puppy",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "prepaid",
  });
  assert.equal(quote.sessions, 4);
  assert.equal(quote.totalAmount, 6000);
  assert.equal(quote.amountDueNow, 6000);

  const payment = await captureTrainingQuoteSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey: "gate3-full-payment",
  });
  assert.equal(payment.status, "FULLY_PAID");
  const attestation = await requireTrainingQuoteSandboxCapture(world.db, { quoteId: quote.quoteId, amount: quote.amountDueNow });
  assert.equal(attestation.environment, "sandbox");

  await consumeTrainingQuote(world.db, quote.quoteId, "BKG-GATE3-1");
  const row = world.sqlite.prepare("SELECT status,used_booking_id FROM training_commercial_quotes WHERE id=?").get(quote.quoteId);
  assert.equal(row.status, "used");
  assert.equal(row.used_booking_id, "BKG-GATE3-1");

  await expectResponseRefusal(() => consumeTrainingQuote(world.db, quote.quoteId, "BKG-GATE3-2"), {
    status: 409,
    message: /Training quote is already linked to a booking/,
  });
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_booking_quote_links WHERE quote_id=?").get(quote.quoteId).n, 1);
});

test("Training payment sabotage rejects mismatched amount and replay key", async () => {
  const world = freshTrainingWorld();
  const quote = await createTrainingQuote(world.db, {
    packageCode: "training-2-starter",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
  });

  await expectResponseRefusal(() => captureTrainingQuoteSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow - 1,
    paymentKey: "gate3-wrong-amount",
  }), { status: 409, message: /Sandbox capture amount must match the Training quote amount due now/ });
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_quote_payment_attestations WHERE quote_id=?").get(quote.quoteId).n, 0);

  await captureTrainingQuoteSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey: "gate3-deposit",
  });
  await expectResponseRefusal(() => captureTrainingQuoteSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey: "gate3-different-key",
  }), { status: 403, message: /PAYMENT_CAPTURE_REPLAY/ });
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_quote_payment_attestations WHERE quote_id=?").get(quote.quoteId).n, 1);
});

test("Training split-payment balance executes once and refuses incorrect remaining value", async () => {
  const world = freshTrainingWorld();
  const quote = await createTrainingQuote(world.db, {
    packageCode: "training-8-basic",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
  });
  await captureTrainingQuoteSandbox(world.db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: "gate3-basic-deposit" });

  await expectResponseRefusal(() => collectTrainingRemainingBalanceSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.totalAmount - quote.amountDueNow - 1,
    paymentKey: "gate3-wrong-balance",
  }), { status: 409, message: /Remaining Training balance must equal/ });
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_balance_payment_events WHERE quote_id=?").get(quote.quoteId).n, 0);

  const result = await collectTrainingRemainingBalanceSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.totalAmount - quote.amountDueNow,
    paymentKey: "gate3-balance",
  });
  assert.equal(result.status, "FULLY_PAID");
  assert.equal(result.remainingAmount, 0);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_balance_payment_events WHERE quote_id=?").get(quote.quoteId).n, 1);
});

test("Training commercial inputs fail closed for coupon misuse and past scheduling", async () => {
  const world = freshTrainingWorld();
  await expectResponseRefusal(() => createTrainingQuote(world.db, {
    packageCode: "training-2-starter",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
    couponCode: "ANY",
  }), { status: 409, message: /Training coupons require full prepaid payment/ });

  await expectResponseRefusal(() => createTrainingQuote(world.db, {
    packageCode: "training-2-starter",
    petCount: 1,
    scheduledStart: new Date(Date.now() - 60_000).toISOString(),
    paymentMode: "prepaid",
  }), { status: 400, message: /Training quote requires a future scheduled start/ });
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes").get().n, 0);
});
