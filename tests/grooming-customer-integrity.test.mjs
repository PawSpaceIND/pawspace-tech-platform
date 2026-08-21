import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("app/page.tsx", "utf8");

test("grooming checkout persists the customer-entered identity instead of generated placeholders", () => {
  assert.match(source, /name:customerName\.trim\(\)/);
  assert.match(source, /secondaryPhone:secondaryPhone\.replace/);
  assert.doesNotMatch(source, /customerName:`PawSpace Customer/);
});

test("grooming checkout persists the selected safety requirement", () => {
  assert.match(source, /requirements:\[`grooming_safety:\$\{safetyNotes\}`\]/);
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
