import assert from "node:assert/strict";
import test from "node:test";
import {
  createAddressSessionToken,
  groomingBookingDates,
  groomingSlotFitsRoster,
  groomingSlotWindow,
} from "../lib/grooming-booking-calendar.ts";

test("grooming calendar starts on today's Bengaluru date and advances across month boundaries", () => {
  const dates = groomingBookingDates(Date.UTC(2026, 7, 31, 20, 0), 4);
  assert.deepEqual(dates.map((entry) => entry.isoDate), [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
  ]);
  assert.equal(dates[0].day, "Today");
  assert.equal(dates[0].date, "1 Sept");
});

test("grooming slot windows convert the selected Bengaluru date and time to UTC", () => {
  const first = groomingSlotWindow("2026-08-19", 0, 120);
  assert.equal(first.start.toISOString(), "2026-08-19T03:30:00.000Z");
  assert.equal(first.end.toISOString(), "2026-08-19T05:30:00.000Z");
  const lastTwoHour = groomingSlotWindow("2026-08-19", 4, 120);
  assert.equal(lastTwoHour.start.toISOString(), "2026-08-19T11:30:00.000Z");
  assert.equal(lastTwoHour.end.toISOString(), "2026-08-19T13:30:00.000Z");
});

test("multi-pet durations cannot run past the 7 PM Bengaluru roster", () => {
  assert.equal(groomingSlotFitsRoster(0, 240), true);
  assert.equal(groomingSlotFitsRoster(3, 240), false);
  assert.equal(groomingSlotFitsRoster(4, 240), false);
  assert.equal(groomingSlotFitsRoster(4, 120), true);
  assert.throws(() => groomingSlotWindow("2026-08-19", 4, 240), /service hours/);
});

test("address session token works when randomUUID is unavailable", () => {
  const fakeCrypto = {
    getRandomValues(bytes) {
      bytes.fill(7);
      return bytes;
    },
  };
  assert.equal(createAddressSessionToken(fakeCrypto), "07070707070707070707070707070707");
});

test("invalid grooming dates, slots and durations fail closed", () => {
  assert.throws(() => groomingSlotWindow("19-08-2026", 0, 120));
  assert.throws(() => groomingSlotWindow("2026-02-31", 0, 120));
  assert.throws(() => groomingSlotWindow("2026-08-19", 5, 120));
  assert.throws(() => groomingSlotWindow("2026-08-19", 0, 0));
});
