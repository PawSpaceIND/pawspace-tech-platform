import test from "node:test";
import assert from "node:assert/strict";
import {
  freshTrainingWorld,
  futureTrainingStart,
  createTrainingQuote,
  captureTrainingQuoteSandbox,
  getGovernedProvider,
  TRAINER_ID,
} from "./helpers/training-gate-harness.mjs";

test("UAT Training closure resolves trainer identity from governed provider capacity", async () => {
  const world = freshTrainingWorld();
  const trainer = await getGovernedProvider(world.db, TRAINER_ID);
  assert.ok(trainer, "canonical trainer must resolve from provider capacity governance");
  assert.equal(trainer.id, TRAINER_ID);
  assert.ok(trainer.services.includes("dog_training"));
  assert.ok(trainer.zones.includes("blr-east"));
  assert.equal(trainer.live, true);
  assert.ok(trainer.maxDailyJobs >= 1);
});

test("UAT Training closure executes Meet & Greet through the same governed quote boundary", async () => {
  const world = freshTrainingWorld();
  const quote = await createTrainingQuote(world.db, {
    packageCode: "trainer-meet-greet",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "prepaid",
  });
  assert.equal(quote.meetAndGreet, true);
  assert.equal(quote.sessions, 1);
  assert.equal(quote.totalAmount, 500);
  assert.equal(quote.amountDueNow, 500);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes WHERE id=?").get(quote.quoteId).n, 1);
});

test("UAT Training closure keeps Meet & Greet payment fail-closed", async () => {
  const world = freshTrainingWorld();
  await assert.rejects(() => createTrainingQuote(world.db, {
    packageCode: "trainer-meet-greet",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
  }), /Meet & Greet must be paid in full/);

  const quote = await createTrainingQuote(world.db, {
    packageCode: "trainer-meet-greet",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "prepaid",
  });
  await assert.rejects(() => captureTrainingQuoteSandbox(world.db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey: "uat-meet-greet",
  }), /Meet & Greet remains pending until a verified payment event/);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_quote_payment_attestations WHERE quote_id=?").get(quote.quoteId).n, 0);
});
