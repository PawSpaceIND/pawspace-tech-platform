import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("app/page.tsx", "utf8");
const transactionSource = fs.readFileSync("lib/test-transaction.ts", "utf8");

test("grooming checkout persists normalized customer identity instead of generated placeholders", () => {
  assert.match(source, /name: normalizedCustomerName/);
  assert.match(source, /secondaryPhone: normalizedSecondaryPhone/);
  assert.match(source, /normalizedSecondaryPhone\.length !== 10/);
  assert.doesNotMatch(source, /customerName:`PawSpace Customer/);
});

test("grooming checkout persists the selected safety requirement", () => {
  assert.match(source, /requirements: \[`grooming_safety:\$\{safetyNotes\}`\]/);
});

test("confirmation proof is derived from the public provider profile", () => {
  assert.match(source, /matchedProvider\.stats\.completedServices/);
  assert.match(source, /matchedProvider\?\.isNewProvider \? "New to PawSpace"/);
  assert.doesNotMatch(source, /1,248 services/);
  assert.doesNotMatch(source, /4 years with PawSpace/);
});

test("booking submission is guarded against concurrent double clicks", () => {
  assert.match(source, /if \(bookingSubmitting\) return/);
  assert.match(source, /disabled=\{bookingSubmitting\}/);
});

test("provider preview never reserves capacity before confirmation", () => {
  assert.equal((source.match(/reserveUatSchedule\(/g) || []).length, 1);
  assert.match(source, /matched when you confirm/);
});

test("pay-now state is explicitly pending and cannot fall through to pay-after-service", () => {
  assert.match(source, /initialPaymentStatus: payment === "after" \? "due_after_service" : "payment_pending"/);
  assert.match(transactionSource, /"payment_pending"/);
  assert.match(transactionSource, /initialPaymentStatus\?\?\(/);
});

test("mutable persisted booking inputs participate in the idempotency fingerprint", () => {
  assert.match(source, /stableBookingInputKey\(\[/);
  for (const input of ["normalizedCustomerName", "normalizedSecondaryPhone", "normalizedAddress.toLowerCase()", "payment", "safetyNotes", "offerType", "selectedPackage.name", "String(total)"]) {
    assert.ok(source.includes(input), input);
  }
});

test("grooming schedule copy does not claim unobserved live capacity", () => {
  assert.doesNotMatch(source, /Live groomer calendar/);
  assert.doesNotMatch(source, /update automatically from groomer calendars/);
  assert.doesNotMatch(source, />2 groomers</);
  assert.match(source, /Provider capacity and zone availability are checked when you confirm/);
});
