/**
 * CUST-L-D13. V2 pages and /boarding/manage rendered booking times with `Date#toLocaleString` and no
 * `timeZone`, which uses the DEVICE's zone: a 7:00 AM IST walk read as "1:30 am" on a browser whose OS
 * clock is UTC, with no zone label anywhere to explain the gap. lib/india-time.ts is the one shared
 * formatter every customer surface must go through instead, so this suite:
 *  1. Pins its output against a fixed instant, independent of this process's own TZ (the sandbox here
 *     runs UTC — the same device zone the finding was reproduced against).
 *  2. Confirms every page named in the finding actually imports it, so the fix stays wired in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatIndiaDateTime,
  formatIndiaTime,
  formatIndiaRange,
  formatIndiaDateTimeMedium,
  INDIA_TIME_ZONE,
} from "../lib/india-time.ts";

// A 7:00 AM IST walk — 01:30 UTC. On a UTC-device browser, the finding showed this rendered as
// "1:30 am": the exact defect this module exists to prevent.
const SEVEN_AM_IST = "2026-09-24T01:30:00.000Z";
const SEVEN_THIRTY_AM_IST = "2026-09-24T02:00:00.000Z";

test("INDIA_TIME_ZONE is Asia/Kolkata", () => {
  assert.equal(INDIA_TIME_ZONE, "Asia/Kolkata");
});

test("formatIndiaDateTime renders the IST wall-clock time, labelled, not the device zone's", () => {
  assert.equal(formatIndiaDateTime(SEVEN_AM_IST), "24 Sept, 7:00 am IST");
  assert.doesNotMatch(formatIndiaDateTime(SEVEN_AM_IST), /1:30/, "must not fall back to a UTC/device reading");
});

test("formatIndiaDateTime supports a weekday prefix and a year", () => {
  assert.equal(formatIndiaDateTime(SEVEN_AM_IST, { weekday: true }), "Thu, 24 Sept, 7:00 am IST");
  assert.equal(formatIndiaDateTime(SEVEN_AM_IST, { year: true }), "24 Sept 2026, 7:00 am IST");
});

test("formatIndiaDateTime falls back honestly for an unparsable value", () => {
  assert.equal(formatIndiaDateTime("not-a-date"), "Schedule pending");
  assert.equal(formatIndiaDateTime("not-a-date", { fallback: "Not scheduled" }), "Not scheduled");
});

test("formatIndiaTime renders only the labelled IST time", () => {
  assert.equal(formatIndiaTime(SEVEN_AM_IST), "7:00 am IST");
});

test("formatIndiaRange renders a labelled start -> end window in IST", () => {
  assert.equal(formatIndiaRange(SEVEN_AM_IST, SEVEN_THIRTY_AM_IST), "24 Sept, 7:00 am IST → 7:30 am IST");
});

test("formatIndiaDateTimeMedium renders a labelled medium-style IST date", () => {
  assert.equal(formatIndiaDateTimeMedium(SEVEN_AM_IST), "24 Sept 2026, 7:00 am IST");
});

// ---------------------------------------------------------------------------------------------
// WIRING. Every surface the finding named must actually import the shared formatter, and must not
// still call the device-zone `toLocaleString`/`toLocaleTimeString` (no timeZone option) it replaced.
const WIRED_SURFACES = [
  "app/v2/activity/page.tsx",
  "app/walking/page.tsx",
  "app/walking/manage/walking-customer-management.tsx",
  "app/training/page.tsx",
  "app/taxi/canonical-taxi-page.tsx",
  "app/taxi/manage/taxi-customer-management.tsx",
  "app/mobile-app/boarding-customer-stay-panel.tsx",
];

test("every surface named in CUST-L-D13 imports the shared india-time formatter", () => {
  for (const path of WIRED_SURFACES) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /lib\/india-time/, `${path} must import the shared IST formatter`);
    // The specific defect: a `Date` formatted with `toLocaleString`/`toLocaleTimeString` and no
    // `timeZone` renders in the DEVICE zone. (Plain `amount.toLocaleString("en-IN")` money formatting
    // is untouched by this fix and must stay allowed — only a bare Date-time call is disallowed.)
    assert.doesNotMatch(
      source,
      /Date\([^)]*\)\.toLocaleString\("en-IN"\)|\.toLocaleTimeString\("en-IN"\)/,
      `${path} must not format a booking time with the device zone`,
    );
  }
});

test("the V2 grooming confirmation and legacy grooming manage views label IST", () => {
  for (const path of ["app/v2/grooming/payment-panel.tsx", "app/grooming/manage/grooming-customer-booking.tsx"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /lib\/india-time/, `${path} must reuse the shared IST formatter`);
  }
});
