import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const calendarSource = fs.readFileSync(new URL("../lib/grooming-booking-calendar.ts", import.meta.url), "utf8");
const coverageClient = fs.readFileSync(new URL("../lib/service-zone-client.ts", import.meta.url), "utf8");

test("public grooming entry derives current India dates and never ships the August fixture", () => {
  assert.match(calendarSource, /const INDIA_TIME_ZONE = "Asia\/Kolkata"/);
  assert.match(calendarSource, /timeZone:\s*INDIA_TIME_ZONE/);
  assert.match(source, /groomingBookingDates\(\)/);
  assert.doesNotMatch(source, /3 Aug|Date\.UTC\(2026,7,3/);
});

test("public grooming entry resolves service coverage before scheduling", () => {
  assert.match(source, /resolveServiceCoverage\(pincode\)/);
  assert.match(coverageClient, /\/api\/service-zone\?pincode=/);
  assert.match(source, /zoneId:\s*coverage\.zoneId/);
  assert.doesNotMatch(source, /zoneId:"blr-east"/);
});

test("public grooming entry does not advertise fabricated live capacity or capture payment", () => {
  assert.match(source, /Capacity verified on confirmation/);
  assert.doesNotMatch(source, /[12] groomers/);
  assert.doesNotMatch(source, /status:payment==="after"\?"created":"captured"/);
  assert.match(source, /status:"created"/);
});
