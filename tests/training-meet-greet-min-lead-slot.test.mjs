import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CUST_L_D15_DB__", "__CUST_L_D15_ENV__");

// ---------------------------------------------------------------------------------------------------
// CUST-L-D15 — mobile Training "Book a Meet & Greet": the pre-selected default slot chip (next day
// 11:00) sat inside the scheduler's refusal window. POST /api/training-commercial answered 201, then
// POST /api/uat-scheduling answered 400 ("below_minimum_lead_time"), and the app showed "We could not
// reserve this slot..." with no booking created, while the very next "Available" chip worked fine.
//
// The Meet & Greet is reserved with serviceCode "dog_training" (see confirmMeetFirst in
// app/mobile-app/training-flow.tsx), so the governed rule it is measured against is
// lib/booking-time-policy.ts APPROVED_BOOKING_TIME_BY_SERVICE.dog_training.minimumLeadMinutes (24
// hours), enforced server-side by assertBookingWindow inside app/api/uat-scheduling. The old default
// chip was simply "tomorrow at 11:00 IST" with no regard for what time "now" actually is - late enough
// in the day and that is under 24 hours away.
//
// training-flow.tsx now derives its candidate slots from that SAME governed constant (imported, not
// duplicated) via meetGreetSlotDates()/firstBookableMeetGreetDayOffset(), so the pre-selected default
// can never again be a slot the scheduler is guaranteed to refuse.
// ---------------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("CUST-L-D15: the Meet & Greet minimum lead time is read from the same governed rule the scheduler enforces", async () => {
  const trainingFlow = await import("../app/mobile-app/training-flow.tsx");
  const policy = await import("../lib/booking-time-policy.ts");
  assert.equal(
    trainingFlow.MEET_GREET_MIN_LEAD_MINUTES,
    policy.APPROVED_BOOKING_TIME_BY_SERVICE.dog_training.minimumLeadMinutes,
    "training-flow must derive its constant from booking-time-policy.ts, not hardcode a copy that can drift",
  );
  assert.equal(trainingFlow.MEET_GREET_MIN_LEAD_MINUTES, 24 * 60, "dog_training's approved minimum lead time is 24 hours");
});

test("CUST-L-D15: reproduces the exact reported failure - the OLD hardcoded default (tomorrow 11:00) falls inside the refusal window late in the day", async () => {
  const { firstBookableMeetGreetDayOffset, MEET_GREET_MIN_LEAD_MINUTES } = await import("../app/mobile-app/training-flow.tsx");
  // "now" = 3pm IST. "Tomorrow 11:00" is only ~20 hours away - under the 24-hour minimum. This is the
  // scenario the browser pass hit: the QA session was well past 11:00 IST when it opened Training.
  const nowLateInDay = Date.UTC(2026, 8, 21, 9, 30); // 2026-09-21T09:30:00Z == 2026-09-21T15:00 IST
  const oldDefaultLeadMinutes = (Date.UTC(2026, 8, 22, 11, 0) - 5.5 * HOUR - nowLateInDay) / 60_000;
  assert.ok(oldDefaultLeadMinutes < MEET_GREET_MIN_LEAD_MINUTES, "sanity check: the old hardcoded default really was inside the refusal window at this hour");

  const offset = firstBookableMeetGreetDayOffset(11, 0, nowLateInDay);
  assert.ok(offset >= 2, "the fix must push the default past day 1 once 'tomorrow 11:00' no longer clears 24 hours' notice");
});

test("CUST-L-D15: every Meet & Greet chip - including the pre-selected default - always clears the scheduler's minimum lead time, at any hour of day", async () => {
  const { meetGreetSlotDates, MEET_GREET_MIN_LEAD_MINUTES } = await import("../app/mobile-app/training-flow.tsx");
  for (let hour = 0; hour < 24; hour += 1) {
    const now = Date.UTC(2026, 8, 21, 0, 0) + hour * HOUR;
    const slots = meetGreetSlotDates(now);
    assert.equal(slots.length, 3);
    for (const slot of slots) {
      const leadMinutes = (slot.getTime() - now) / 60_000;
      assert.ok(
        leadMinutes >= MEET_GREET_MIN_LEAD_MINUTES,
        `hour=${hour}: slot ${slot.toISOString()} only has ${leadMinutes} minutes' notice, below the required ${MEET_GREET_MIN_LEAD_MINUTES}`,
      );
    }
    // The pre-selected default is always the first candidate returned.
    const defaultLead = (slots[0].getTime() - now) / 60_000;
    assert.ok(defaultLead >= MEET_GREET_MIN_LEAD_MINUTES, `hour=${hour}: the pre-selected default chip must itself be bookable`);
  }
});

test("CUST-L-D15: the default slot never drifts needlessly far out when there is plenty of notice", async () => {
  const { meetGreetSlotDates } = await import("../app/mobile-app/training-flow.tsx");
  // Early morning: "tomorrow 11:00" already clears 24 hours, so the default should still be day 1.
  const earlyMorning = Date.UTC(2026, 8, 21, 1, 0); // 2026-09-21T01:00Z == 06:30 IST
  const [first] = meetGreetSlotDates(earlyMorning);
  const dayOfDefault = new Date(first.getTime() + 330 * 60_000).getUTCDate();
  const dayOfNow = new Date(earlyMorning + 330 * 60_000).getUTCDate();
  assert.equal(dayOfDefault, dayOfNow + 1, "with plenty of notice the default stays 'tomorrow', not pushed further out than necessary");
});
