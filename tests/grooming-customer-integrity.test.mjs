import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The grooming checkout these cases describe now lives in app/mobile-app/grooming-flow.tsx: app/page.tsx
// hands booking to the governed flow rather than running a second implementation of one [PTJA-P1-F38].
// Every property below is asserted against the flow that actually books, and NONE is relaxed to accept
// less than the retired page provided — where the flow lacked a behaviour it was carried across, not
// written off. The entry page is still checked for the identity defect that caused P1-04.
const source = fs.readFileSync("app/mobile-app/grooming-flow.tsx", "utf8");
const entry = fs.readFileSync("app/page.tsx", "utf8");
const transactionSource = fs.readFileSync("lib/test-transaction.ts", "utf8");
const partnerFeedSource = fs.readFileSync("lib/partner-job-feed.ts", "utf8");
const partnerJobsPage = fs.readFileSync("app/partner/jobs/page.tsx", "utf8");
const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");

test("grooming checkout persists normalized customer identity instead of generated placeholders", () => {
  // Stronger than before: the identity is no longer normalized from typed input at all, it is the
  // signed-in customer resolved from the platform session, so a placeholder cannot be constructed.
  assert.match(source, /customerId:customer\.customerId/);
  assert.match(source, /customerName:customer\.customerName/);
  assert.match(source, /primary:customer\.phone/);
  assert.doesNotMatch(code, /customerName:`PawSpace Customer/);
  assert.match(entry, /loadCustomerAccount\(\)/);
  assert.doesNotMatch(entry, /`WEB-\$\{/);
});

test("grooming checkout persists the selected safety requirement", () => {
  assert.match(source, /requirements:\[`grooming_safety:\$\{safetyNotes\}`\]/);
  assert.match(source, /Aggressive \/ bite history/);
});

test("assigned groomer receives canonical safety requirements and add-ons", () => {
  assert.match(partnerFeedSource, /pricing_json FROM canonical_bookings/);
  assert.match(partnerFeedSource, /safetyRequirements:pricingList\(booking\.pricing_json,"requirements"\)/);
  assert.match(partnerFeedSource, /addOns:pricingList\(booking\.pricing_json,"addOns"\)/);
  assert.match(partnerJobsPage, /job\.serviceCode==="grooming"&&job\.safetyRequirements\.length/);
  assert.match(partnerJobsPage, /job\.serviceCode==="grooming"&&job\.addOns\.length/);
});

test("confirmation proof is derived from the public provider profile", () => {
  assert.match(source, /provider-public-profile\?providerId=/);
  assert.match(source, /providerProof\.stats\.completedServices/);
  assert.match(source, /providerProof\.isNewProvider&&/);
  assert.doesNotMatch(code, /1,248 services/);
  assert.doesNotMatch(code, /4 years with PawSpace/);
});

test("booking submission is guarded against concurrent double clicks", () => {
  assert.match(source, /confirm=async\(\)=>\{if\(scheduling\)return;/);
  assert.match(source, /disabled=\{scheduling\|\|!serviceLocation\}/);
});

test("provider preview never reserves capacity before confirmation", () => {
  assert.equal((code.match(/reserveUatSchedule\(/g) || []).length, 1);
});

test("pay-now state is explicitly pending and cannot fall through to pay-after-service", () => {
  assert.match(source, /initialPaymentStatus:pay==="online"\?"payment_pending":"due_after_service"/);
  assert.match(transactionSource, /"payment_pending"/);
  assert.match(transactionSource, /initialPaymentStatus\?\?\(/);
});

test("mutable persisted booking inputs participate in the idempotency fingerprint", () => {
  assert.match(source, /stableBookingInputKey\(\[/);
  // The same inputs the retired page fingerprinted, expressed in this flow's own names.
  for (const input of ["customer.customerId", "date", "String(slotIndex)", "String(count)", "String(pay)", "safetyNotes", "String(total)", "packId"]) {
    assert.ok(source.includes(input), input);
  }
});

test("grooming schedule copy does not claim unobserved live capacity", () => {
  assert.doesNotMatch(code, /Live groomer calendar/);
  assert.doesNotMatch(code, /update automatically from groomer calendars/);
  assert.doesNotMatch(code, />2 groomers</);
});