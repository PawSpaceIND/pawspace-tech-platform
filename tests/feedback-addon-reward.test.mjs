import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__FEEDBACK_ADDON_DB__");
const config = await import("../lib/review-configuration-governance.ts");
const reviews = await import("../lib/service-review-governance.ts");
const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");

function world() {
  const ctx = freshCountingD1();
  globalThis.__FEEDBACK_ADDON_DB__ = ctx.db;
  ctx.sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,package_name TEXT,scheduled_start TEXT,total_amount REAL)");
  ctx.sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,amount REAL,amount_due_now REAL,currency TEXT,status TEXT)");
  ctx.sqlite.prepare("INSERT INTO canonical_bookings VALUES ('DONE','C','P','grooming','completed','Bath','2026-09-01',799)").run();
  ctx.sqlite.prepare("INSERT INTO canonical_bookings VALUES ('NEXT','C','P2','boarding','confirmed','Stay','2026-10-01',899)").run();
  ctx.sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-NEXT','NEXT',899,899,'INR','created')").run();
  return ctx;
}

async function earnedReward(ctx, rewardInput) {
  await reviews.ensureServiceReviewTables(ctx.db);
  const draft = await config.saveReviewConfig(ctx.db,{serviceCode:"grooming",questions:[],triggerType:"every_service",channels:["notification"],...rewardInput},"maker@pawspace.in");
  await config.approveReviewConfig(ctx.db,{id:draft.id,approvalReference:"TEST-REWARD",actor:"checker@pawspace.in"});
  const req = await reviews.requestServiceReview(ctx.db,{bookingId:"DONE",serviceCode:"grooming",customerId:"C"});
  const answers = Object.fromEntries(req.questions.map(q=>[q.id,5]));
  return reviews.submitServiceReview(ctx.db,{requestId:req.requestId,customerId:"C",answers});
}

test("Rs.500 feedback coupon becomes a real any-service booking credit and lowers gateway cash due", async()=>{
  const ctx=world();
  const result=await earnedReward(ctx,{feedbackRewardKind:"coupon",feedbackRewardValue:500});
  const before=await paymentStageAmount(ctx.db,"NEXT");
  assert.equal(before.dueNow,899);
  const redeemed=await reviews.redeemReviewReward(ctx.db,{code:result.feedbackReward.code,customerId:"C",bookingId:"NEXT",actorId:"C"});
  assert.equal(redeemed.discountApplied,500);
  const after=await paymentStageAmount(ctx.db,"NEXT");
  assert.equal(after.creditsApplied,500);
  assert.equal(after.dueNow,399);
});

test("feedback coupon is capped at the booking remainder and cannot make cash due negative", async()=>{
  const ctx=world();
  ctx.sqlite.prepare("UPDATE canonical_bookings SET total_amount=300 WHERE id='NEXT'").run();
  ctx.sqlite.prepare("UPDATE booking_payments SET amount=300,amount_due_now=300 WHERE booking_id='NEXT'").run();
  const result=await earnedReward(ctx,{feedbackRewardKind:"coupon",feedbackRewardValue:500});
  const redeemed=await reviews.redeemReviewReward(ctx.db,{code:result.feedbackReward.code,customerId:"C",bookingId:"NEXT",actorId:"C"});
  assert.equal(redeemed.discountApplied,300);
  const after=await paymentStageAmount(ctx.db,"NEXT");
  assert.equal(after.creditsApplied,300);
  assert.equal(after.dueNow,0);
});

test("backend can switch feedback reward to one free configured add-on bound exactly once to the booking",async()=>{
  const ctx=world();
  const result=await earnedReward(ctx,{feedbackRewardKind:"addon",feedbackAddonCode:"NAIL_TRIM"});
  assert.equal(result.feedbackReward.kind,"addon");
  assert.equal(result.feedbackReward.discount,0);
  const redeemed=await reviews.redeemReviewReward(ctx.db,{code:result.feedbackReward.code,customerId:"C",bookingId:"NEXT",actorId:"C"});
  assert.equal(redeemed.addOnCode,"NAIL_TRIM");
  assert.equal(redeemed.discountApplied,0);
  const row=ctx.sqlite.prepare("SELECT booking_id,customer_id,addon_code,status FROM booking_feedback_addons WHERE reward_code=?").get(result.feedbackReward.code);
  assert.deepEqual({...row},{booking_id:"NEXT",customer_id:"C",addon_code:"NAIL_TRIM",status:"reserved"});
  const replay=await assert.rejects(()=>reviews.redeemReviewReward(ctx.db,{code:result.feedbackReward.code,customerId:"C",bookingId:"NEXT",actorId:"C"}),/already been used/);
  void replay;
  assert.equal(Number(ctx.sqlite.prepare("SELECT COUNT(*) c FROM booking_feedback_addons WHERE reward_code=?").get(result.feedbackReward.code).c),1);
});
