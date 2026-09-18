/*
 * A caregiver whose application cannot be submitted must be told something they can act on.
 *
 * Driving the real partner journey produced this, on screen, in an alert:
 *
 *   {"error":"An active onboarding policy is required before submission"}
 *
 * Three separate faults stacked up to produce it:
 *
 *   lib/provider-onboarding-transactional  threw a bare Error, so a missing configuration record
 *                                          became a 500 — a server fault, which it is not
 *   the route's failure()                  turned a thrown Response into the right status but a
 *                                          generic message, so no path gave BOTH status and detail
 *   the onboarding pages                   did `throw new Error(await r.text())`, printing the raw
 *                                          JSON envelope at a person
 *
 * Nothing was wrong with the applicant's details. The platform had no onboarding policy published
 * for their service and city, which is an ops task, and the screen should say so.
 *
 * ERR-1..ERR-3 execute the real unwrapping. ERR-4..ERR-6 pin the two server halves and the absence
 * of the raw-body pattern, which is what would let this regress one page at a time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const { messageFromBody, GENERIC_API_ERROR } = await importLibModule("api-error-message");
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("ERR-1: the message is taken out of the envelope, never shown as one", () => {
  assert.equal(messageFromBody('{"error":"Applications are not open for this city yet."}'),
    "Applications are not open for this city yet.");
  assert.equal(messageFromBody('{"message":"Phone already registered."}'), "Phone already registered.");
});

test("ERR-2: a body with nothing useful falls back to a sentence, not to JSON", () => {
  for (const body of ["", "   ", "{}", '{"error":""}', '{"error":"   "}', "{not json at all", '["odd"]']) {
    const shown = messageFromBody(body);
    assert.equal(shown, GENERIC_API_ERROR, `body ${JSON.stringify(body)} leaked instead of falling back`);
    assert.ok(!shown.includes("{"), "a brace must never reach the screen");
  }
});

test("ERR-3: plain text is passed through, because it is already readable", () => {
  assert.equal(messageFromBody("Service temporarily unavailable"), "Service temporarily unavailable");
});

test("ERR-4: a missing onboarding policy is a 4xx, not a server error", () => {
  const lib = read("lib/provider-onboarding-transactional.ts");
  const guard = lib.match(/throw new Response\("([^"]*)",\{status:(\d{3})\}\)/);
  assert.ok(guard, "the onboarding-policy guard must throw a Response, not a bare Error");
  const [, message, status] = guard;
  assert.ok(Number(status) >= 400 && Number(status) < 500,
    `a missing configuration record is not the applicant's fault and not a crash — got ${status}`);
  assert.ok(!/policy is required before submission/i.test(message),
    "the message an applicant reads must not be the internal precondition");
  assert.ok(message.length > 40, "it has to actually explain what happens next");
});

test("ERR-5: the route keeps both the status and the message of a thrown Response", () => {
  const route = read("app/api/provider-onboarding-self-service/route.ts");
  assert.match(route, /if\(error instanceof Response\)\{const message=await error\.text\(\)/,
    "failure() must read the thrown Response's body rather than replacing it with a generic string");
  assert.ok(!/return failure\(error\);/.test(route),
    "failure() is async now — every call site must await it, or the body becomes a pending promise");
});

test("ERR-6: no onboarding page prints a raw response body at a person", () => {
  const pages = ["app/partner/onboarding/page.tsx", "app/team/provider-onboarding/page.tsx", "app/control/provider-onboarding/page.tsx"];
  const offenders = pages.filter((p) => /new Error\(await (?:r|res|response)\.text\(\)\)/.test(read(p)));
  assert.deepEqual(offenders, [],
    `these show the raw body to the user; use apiErrorMessage from lib/api-error-message:\n  ${offenders.join("\n  ")}`);
  for (const p of pages) assert.match(read(p), /apiErrorMessage/, `${p} must unwrap errors through the shared helper`);
});
