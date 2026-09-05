/**
 * UAT closure — the public home booking entry, EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Three tests, every assertion a regex over `app/page.tsx`,
 * `app/mobile-app/grooming-flow.tsx`, `lib/grooming-booking-calendar.ts` and
 * `lib/service-zone-client.ts`. "derives current India dates and never ships the August fixture"
 * asserted that the STRING `const INDIA_TIME_ZONE = "Asia/Kolkata"` appeared in the calendar and
 * that "3 Aug" did not appear in the page. Neither says the dates offered to a customer today are
 * today's, which is the property that actually failed in Phase 1.
 *
 * Each test below runs the real calendar function, drives the real coverage route, and renders the
 * real component through the TSX harness (react-dom/server renders the INITIAL state, so what is
 * pinned here is what a customer sees before any data arrives -- which is exactly where "absent
 * drawn as present" lives).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, OPS_ORIGIN } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__HOME_BOOKING_DB__", "__HOME_BOOKING_ENV__");

const calendar = await import("../lib/grooming-booking-calendar.ts");

/*
 * react and react-dom/server are imported BEFORE any .tsx module, and that order is load-bearing.
 * The transpiled component's first import is `react/jsx-runtime`, whose CommonJS development build
 * does `require("react")` while it initialises. On Node 22.16 (the version CI pins), pulling that in
 * as the first entry of an ESM graph hands it a react whose `__CLIENT_INTERNALS...` export is not yet
 * populated, and the first JSX call dies on `recentlyCreatedOwnerStacks` of undefined. Importing
 * react itself first means it is already fully evaluated and cached by the time jsx-runtime asks.
 */
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

async function render(modulePath, props) {
  const mod = await import(modulePath);
  assert.equal(typeof mod.default, "function", `${modulePath} exports a component`);
  return renderToStaticMarkup(React.createElement(mod.default, props));
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function bookingWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__HOME_BOOKING_DB__ = db;
  globalThis.__HOME_BOOKING_ENV__ = { DB: db };
  return { sqlite, db };
}

/** The India calendar day for an instant, computed independently of the module under test. */
const indiaDay = (at) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(at));

// ---------------------------------------------------------------------------------------------
test("the public grooming entry derives CURRENT India dates and never a fixed fixture", () => {
  // Today, whenever "today" is when this runs.
  const today = calendar.groomingBookingDates();
  assert.equal(today.length, 4, "four bookable days are offered");
  assert.equal(today[0].isoDate, indiaDay(Date.now()), "the first offered day is today in India");
  for (const day of today) {
    assert.match(day.isoDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(day.day && day.date, "each day carries its own label");
  }

  // Consecutive, and strictly increasing -- not a repeated or shuffled fixture.
  for (let index = 1; index < today.length; index += 1) {
    const previous = new Date(`${today[index - 1].isoDate}T00:00:00Z`).getTime();
    const current = new Date(`${today[index].isoDate}T00:00:00Z`).getTime();
    assert.equal(current - previous, 86_400_000, "the days offered are consecutive");
  }

  // THE REGRESSION THIS EXISTS FOR. Ask for a different instant and the answer moves with it. A
  // hardcoded August fixture would return the same four dates for every argument.
  const inSixMonths = Date.now() + 182 * 86_400_000;
  const later = calendar.groomingBookingDates(inSixMonths);
  assert.equal(later[0].isoDate, indiaDay(inSixMonths));
  assert.notEqual(later[0].isoDate, today[0].isoDate, "the calendar is derived, not shipped");

  // And it is genuinely India time, not the runner's zone: an instant that is a different calendar
  // day in UTC and in IST resolves to the IST day.
  const lateEveningUtc = Date.parse("2026-09-05T20:00:00Z"); // 01:30 on the 6th in Asia/Kolkata
  assert.equal(calendar.groomingBookingDates(lateEveningUtc)[0].isoDate, "2026-09-06");

  const count = calendar.groomingBookingDates(Date.now(), 7);
  assert.equal(count.length, 7, "the window length is a parameter, not a constant");
});

// ---------------------------------------------------------------------------------------------
test("grooming slots are bounded by the real service roster, not by the caller", () => {
  const isoDate = indiaDay(Date.now() + 86_400_000);

  // Slots are a bounded set (0-4). Anything outside it is not a slot at all.
  assert.equal(calendar.groomingSlotFitsRoster(0, 60), true, "the first slot of the day fits");
  assert.throws(() => calendar.groomingSlotFitsRoster(-1, 60), /A valid grooming slot is required/);
  assert.throws(() => calendar.groomingSlotFitsRoster(5, 60), /A valid grooming slot is required/);
  assert.throws(() => calendar.groomingSlotFitsRoster(0, 0), /A valid grooming duration is required/);
  assert.throws(() => calendar.groomingSlotWindow(isoDate, 99, 60), /A valid grooming slot is required/);

  // Slots run on the two-hourly roster from 09:00 IST, and the window is exactly the duration asked for.
  const hourIst = (at) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(at));
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => hourIst(calendar.groomingSlotWindow(isoDate, index, 60).start)),
    ["09:00", "11:00", "13:00", "15:00", "17:00"],
    "the roster is the real one, not whatever the caller asks for",
  );

  const window = calendar.groomingSlotWindow(isoDate, 0, 60);
  assert.ok(window.start && window.end, "a fitting slot produces a real window");
  const start = new Date(window.start).getTime();
  const end = new Date(window.end).getTime();
  assert.equal(end - start, 60 * 60_000, "the window is exactly the requested duration");
  assert.equal(indiaDay(start), isoDate, "and it lands on the day that was asked for");

  /*
   * The roster closes at 19:00 IST and the bound is on the END of the appointment. Every slot fits a
   * two-hour groom (17:00 + 2h = 19:00 exactly), but a three-hour one would run to 20:00 from the
   * last slot, so that slot drops out. This is the assertion that would catch the bound being moved
   * to the START time, which is where an overrun would come from.
   */
  const fits = (duration) => [0, 1, 2, 3, 4].filter((index) => calendar.groomingSlotFitsRoster(index, duration));
  assert.deepEqual(fits(120), [0, 1, 2, 3, 4], "a two-hour groom fits every slot, finishing at 19:00");
  assert.deepEqual(fits(180), [0, 1, 2, 3], "a three-hour groom cannot start in the last slot");
  for (const index of fits(180)) {
    const slot = calendar.groomingSlotWindow(isoDate, index, 180);
    assert.ok(hourIst(slot.end) <= "19:00", `slot ${index} finishes by 19:00 IST, not ${hourIst(slot.end)}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("the public grooming entry resolves service coverage before it schedules anything", async () => {
  const { db } = await bookingWorld();
  const route = await import("../app/api/service-zone/route.ts");

  const ask = (query) => route.GET(new Request(`${OPS_ORIGIN}/api/service-zone?${query}`));

  const missing = await ask("action=resolve");
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Pincode required/);

  const invalid = await ask("pincode=12&action=resolve");
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Invalid pincode/);

  // A real Bengaluru pincode resolves to a zone the SERVER chose.
  const resolved = await ask("pincode=560001&action=resolve");
  assert.equal(resolved.status, 200);
  const coverage = (await resolved.json()).data;
  assert.equal(coverage.assignment.pincode, "560001", "the assignment is for the pincode that was asked about");
  assert.ok(coverage.assignment.zoneId, "and it carries a server-chosen zone");
  assert.equal(coverage.zone.zoneId, coverage.assignment.zoneId, "the zone detail matches the assignment");
  assert.equal(coverage.zone.serviceAvailable, true);

  // An out-of-coverage pincode is answered honestly rather than defaulted into a Bengaluru zone.
  const elsewhere = await ask("pincode=110001&action=resolve");
  assert.ok([200, 404].includes(elsewhere.status));
  const elsewhereBody = await elsewhere.json();
  const elsewhereZone = elsewhereBody.data?.assignment?.zoneId ?? null;
  if (elsewhereZone) {
    assert.doesNotMatch(String(elsewhereZone), /^blr-/, "a Delhi pincode is never silently served as a Bengaluru zone");
  }

  // Coverage is a public read, but changing the zone map is not.
  const seedAttempt = await route.POST(new Request(`${OPS_ORIGIN}/api/service-zone`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "seed" }),
  }));
  assert.ok([401, 403].includes(seedAttempt.status), "an anonymous caller cannot reseed the zone map");

  const crossOrigin = await route.POST(new Request(`${OPS_ORIGIN}/api/service-zone`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ action: "seed" }),
  }));
  assert.equal(crossOrigin.status, 403);
});

// ---------------------------------------------------------------------------------------------
test("the grooming flow's first screen advertises no live capacity and captures no payment", async () => {
  await bookingWorld();

  // react-dom/server renders the INITIAL state: what a customer sees before any data arrives.
  const html = await render("../app/mobile-app/grooming-flow.tsx", {
    customer: { customerId: "CUST-HOME-1", name: "Asha K.", phone: "+919800000001" },
  });
  const rendered = text(html);
  assert.ok(html.length > 0, "the flow renders");

  // Nothing on the first screen claims a slot is held, a groomer is confirmed, or money has moved.
  for (const claim of [
    /\bpayment (?:captured|successful|received)\b/i,
    /\bslot (?:held|locked|reserved)\b/i,
    /\bgroomer confirmed\b/i,
    /\blive tracking\b/i,
  ]) {
    assert.doesNotMatch(rendered, claim, `the first screen must not claim: ${claim}`);
  }

  // Nor does it ship a stale date fixture as if it were availability.
  assert.doesNotMatch(rendered, /\b3 Aug\b/, "the August fixture is gone from the rendered screen");

  // The screen a customer sees with NO resolved location must not present a bookable zone.
  assert.doesNotMatch(rendered, /blr-east/, "no zone literal is rendered before coverage is resolved");
});
