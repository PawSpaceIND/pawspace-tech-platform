import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, nextKey, refusal, seedBoardingStay, validCarePlan } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_CHECKOUT_DAY_DB__", "__BOARDING_CHECKOUT_DAY_ENV__");

const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
const IST_OFFSET_MS = 330 * 60_000;
const istDate = (value) => new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

async function activeStay() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_CHECKOUT_DAY_DB__ = db;
  globalThis.__BOARDING_CHECKOUT_DAY_ENV__ = {};
  const window = {
    scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 30 * 3_600_000).toISOString(),
  };
  const seeded = await seedBoardingStay(db, sqlite, { bookingId: "BKG-BOARD-CHECKOUT-DAY", window });
  const act = (action, extra = {}) => lifecycle.mutateBoardingStay(db, {
    stayId: seeded.stayId,
    action,
    actorId: extra.actorId ?? "host_maya_rohan",
    idempotencyKey: extra.idempotencyKey ?? nextKey("CHECKOUT-DAY"),
    ...extra,
  });
  await act("accept");
  await act("submit_care_plan", { carePlan: validCarePlan(), actorId: seeded.customerId });
  await act("check_in");
  return { db, seeded, act };
}

test("Boarding checkout day remains a valid care-event day before the checkout boundary", async () => {
  const { db, seeded, act } = await activeStay();
  const stay = await db.prepare("SELECT check_in_at,check_out_at FROM boarding_stays WHERE id=?").bind(seeded.stayId).first();
  const checkoutDay = istDate(stay.check_out_at);
  assert.notEqual(checkoutDay, istDate(stay.check_in_at), "fixture must span into a distinct IST checkout day");

  const logged = await act("care_event", {
    careEventType: "meal",
    detail: { stayDate: checkoutDay, note: "Breakfast served before departure" },
  });

  assert.equal(logged.status, "logged");
  assert.equal(logged.stayDate, checkoutDay);
  const event = await db.prepare("SELECT detail_json FROM boarding_stay_events WHERE stay_id=? AND event_type='care_meal' ORDER BY created_at DESC LIMIT 1").bind(seeded.stayId).first();
  assert.equal(JSON.parse(event.detail_json).stayDate, checkoutDay);
});

test("Boarding care events are refused once the checkout boundary has passed", async () => {
  const { db, seeded, act } = await activeStay();
  const pastCheckout = new Date(Date.now() - 60_000).toISOString();
  await db.prepare("UPDATE boarding_stays SET check_out_at=? WHERE id=?").bind(pastCheckout, seeded.stayId).run();

  const refused = await refusal(act("care_event", {
    careEventType: "meal",
    detail: { stayDate: istDate(pastCheckout) },
  }));
  assert.equal(refused?.status, 409);
  assert.match(refused.message, /checkout boundary/);
});
