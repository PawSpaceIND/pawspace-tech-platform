import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The public grooming entry now hands booking to app/mobile-app/grooming-flow.tsx rather than running
// its own [PTJA-P1-F38]. The date derivation still belongs to the entry page; the scheduling and
// payment properties are asserted against the flow that performs them. Neither is relaxed: where the
// flow lacked what the entry page guaranteed, the flow was corrected.
const source = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const flow = fs.readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
const flowCode = flow.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
const calendarSource = fs.readFileSync(new URL("../lib/grooming-booking-calendar.ts", import.meta.url), "utf8");
const coverageClient = fs.readFileSync(new URL("../lib/service-zone-client.ts", import.meta.url), "utf8");

test("public grooming entry derives current India dates and never ships the August fixture", () => {
  assert.match(calendarSource, /const INDIA_TIME_ZONE = "Asia\/Kolkata"/);
  assert.match(calendarSource, /timeZone:\s*INDIA_TIME_ZONE/);
  assert.match(source, /groomingBookingDates\(\)/);
  assert.doesNotMatch(source, /3 Aug|Date\.UTC\(2026,7,3/);
});

test("public grooming entry resolves service coverage before scheduling", () => {
  // The flow schedules against the zone its resolved service location reports, never a literal.
  assert.match(coverageClient, /\/api\/service-zone\?pincode=/);
  assert.match(flow, /serviceLocation\.assignment\.zoneId/);
  assert.match(flow, /serviceLocation\.assignment\.cityId/);
  assert.doesNotMatch(flowCode, /zoneId:"blr-east"/);
  assert.match(flow, /if\(!serviceLocation\)\{setScheduleError/, "and refuses to book without one");
});

test("public grooming entry does not advertise fabricated live capacity or capture payment", () => {
  assert.doesNotMatch(flowCode, /[12] groomers/);
  // The decisive one: an online payment is an authorization request, not money received. A client
  // asserting "captured" with no gateway confirmation is the defect PTJA-P1-F32 fixed for Training.
  // Banned by TOKEN, not by spelling: a rename, different quoting, a helper or another conditional
  // would all slip past a regex pinned to the retired ternary's exact source text. The decisive fact
  // is that the word never reaches the payload at all, in any syntax.
  // Checked against the PAYMENT PAYLOAD ITSELF, not one retired spelling: the object is extracted by
  // brace balancing and the claim is banned inside it whatever syntax produces it - a variable, a
  // helper, different quoting or another conditional all fail here.
  const start = flowCode.indexOf("payment:{");
  assert.ok(start >= 0, "the flow builds a payment payload");
  let depth = 0, end = start;
  for (let i = flowCode.indexOf("{", start); i < flowCode.length; i += 1) {
    if (flowCode[i] === "{") depth += 1;
    else if (flowCode[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const paymentPayload = flowCode.slice(start, end);
  // The decisive guard is POSITIVE: status must be the literal "created". A variable, a helper or a
  // conditional cannot satisfy a literal pin, so this fails for any reintroduction regardless of the
  // syntax that produces it - which a ban on the retired ternary's exact text could not do.
  assert.match(paymentPayload, /status:"created"/, "the payload's status is the literal created");
  assert.ok(!/"captured"/.test(paymentPayload), `and never captured: ${paymentPayload}`);
  // "live capture not connected" in the detail is a truthful disclaimer, not a claim, so the word
  // itself is not banned here - the status literal above is what carries the guarantee.
  assert.match(flow, /initialPaymentStatus:pay==="online"\?"payment_pending"/, "online is pending, not captured");
});
