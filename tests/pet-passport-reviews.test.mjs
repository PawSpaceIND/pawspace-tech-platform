import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const passport = await readFile(new URL("../lib/pet-passport-governance.ts", import.meta.url), "utf8");
const reviewCfg = await readFile(new URL("../lib/review-configuration-governance.ts", import.meta.url), "utf8");
const serviceReview = await readFile(new URL("../lib/service-review-governance.ts", import.meta.url), "utf8");
const ppRoute = await readFile(new URL("../app/api/pet-passport/route.ts", import.meta.url), "utf8");
const ppPublicRoute = await readFile(new URL("../app/api/pet-passport-public/route.ts", import.meta.url), "utf8");
const cfgRoute = await readFile(new URL("../app/api/review-config/route.ts", import.meta.url), "utf8");
const svcRoute = await readFile(new URL("../app/api/service-review/route.ts", import.meta.url), "utf8");
const scheduler = await readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8");

test("Pet Passport: owner + privacy-safe public share tying birthday+vaccination+points", () => {
  assert.match(passport, /export async function getPetPassport/);
  assert.match(passport, /export async function createPetPassportShare/);
  assert.match(passport, /export async function getSharedPetPassport/);
  assert.match(passport, /export async function revokePetPassportShare/);
  // unguessable token, reused not regenerated
  assert.match(passport, /const token = \(\) =>/);
  assert.match(passport, /if \(existing\) return \{ token: String\(existing\.token\)/);
  // ownership enforced
  assert.match(passport, /You can only share your own pet's passport/);
  // public view must NOT leak owner PII (no customer_id / phone / exact points)
  assert.match(passport, /deliberately no customer_id, phone, address, email, exact points/);
  // the public card exposes only status buckets, never the raw points value
  const publicBody = passport.slice(passport.indexOf("Public, privacy-safe passport"));
  assert.doesNotMatch(publicBody, /pawPoints:/);
  assert.match(publicBody, /vaccines: core\.vaccinations\.map/);
  // loyalty tiers
  assert.match(passport, /points >= 2000 \? "Gold" : points >= 500 \? "Silver" : "Bronze"/);
});

test("Review configuration (Control): per-service questions, cadence, channels, maker/checker, links", () => {
  assert.match(reviewCfg, /DEFAULT_GOOGLE_REVIEW_LINK = "https:\/\/g\.page\/r\/CTm50I98sC-REAo\/review"/);
  assert.match(reviewCfg, /DEFAULT_APP_REVIEW_LINK = "https:\/\/onelink\.to\/jyx88z"/);
  assert.match(reviewCfg, /DEFAULT_SINGLE_REVIEW_DISCOUNT = 250/);
  assert.match(reviewCfg, /DEFAULT_DOUBLE_REVIEW_DISCOUNT = 400/);
  assert.match(reviewCfg, /"every_service", "every_n_sessions"/);
  assert.match(reviewCfg, /"notification", "whatsapp", "email"/);
  // every completed service uses exactly the five governed PawSpace feedback questions
  assert.match(reviewCfg, /const questionCount = 5;/);
  assert.match(reviewCfg, /\.slice\(0,5\)/);
  // maker/checker: author cannot approve own config
  assert.match(reviewCfg, /the author cannot approve their own review config/);
  assert.match(cfgRoute, /requirePermission\(actor,"marketing\.manage"\)/);
});

test("Service reviews: cadence-aware five-question feedback, score-independent reward, optional public review", () => {
  assert.match(serviceReview, /export async function requestServiceReview/);
  assert.match(serviceReview, /export async function submitServiceReview/);
  assert.match(serviceReview, /export async function claimPublicReview/);
  assert.match(serviceReview, /export async function redeemReviewReward/);
  // cadence: every N sessions only fires on the interval boundary
  assert.match(serviceReview, /if \(done <= 0 \|\| done % n !== 0\) return \{ requested: false, reason: "cadence_not_reached"/);
  // PawSpace feedback always carries five scored questions and earns the configured internal reward.
  assert.match(serviceReview, /Please rate all five feedback questions from 1 to 5/);
  assert.match(serviceReview, /feedbackReward:\{code:rewardCode,kind:rewardKind,discount:rewardValue/);
  assert.match(serviceReview, /publicReviewPrompt:\{eligible:true,destination/);
  // Public-review claims are tracked for audit only; they do not mint rewards.
  assert.match(serviceReview, /UNIQUE\(booking_id,platform\)/);
  assert.match(serviceReview, /reward:null/);
  assert.doesNotMatch(serviceReview, /isSecond \? "grooming" : "any"/);
  // Legacy scoped rewards remain fail-closed if such a row already exists.
  assert.match(serviceReview, /This reward is valid on grooming only/);
  // self-declared tracking + staff verification
  assert.match(serviceReview, /'self_declared'/);
  assert.match(serviceReview, /export async function verifyPublicReview/);
  // public passport route is unauthenticated and 404s bad tokens
  assert.match(ppPublicRoute, /getSharedPetPassport/);
  assert.match(ppPublicRoute, /has been revoked/);
  assert.doesNotMatch(ppPublicRoute, /requirePermission|requireCustomerOwnership/);
  // customer + staff surfaces are gated appropriately
  assert.match(ppRoute, /requireCustomerOwnership/);
  assert.match(svcRoute, /requirePermission\(actor,"bookings\.manage"\)/);
  assert.match(svcRoute, /requireCustomerOwnership/);
  // auto every-service review sweep is wired into the background scheduler, cold-DB safe
  assert.match(serviceReview, /export async function runServiceReviewSweep/);
  assert.match(serviceReview, /trigger_type='every_service'/);
  assert.match(serviceReview, /\.catch\(\(\) => \(\{ results: \[\] as Row\[\] \}\)\)/);
  assert.match(scheduler, /runServiceReviewSweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"serviceReviews"/);
});
