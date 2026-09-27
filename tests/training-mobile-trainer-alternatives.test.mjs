/*
 * Staging master E2E 36278778677 (27 Sep 2026, 04:43-05:09 IST): the customer app's "Reserve Basic Obedience with
 * 50% split" was refused with "Your selected provider is no longer available. Refresh availability and choose
 * again." The app's trainer step lists the roster for the first session only; the chosen trainer already held one
 * of the Wed & Sun 9:00 windows, and the screen offered no way forward.
 *
 * Training selection is strict (lib/provider-assignment-policy.ts: "never silently substitute"), so the app does
 * not reserve another trainer on the customer's behalf. It asks the scheduler who is free for every session of
 * the same calendar and lets the customer choose one. The engine half runs here; the screen half is checked in
 * its source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { schedule } = await import("../backend/src/scheduling.ts");

const MINUTE_MS = 60_000;
const iso = (ms) => new Date(ms).toISOString();
/** Wed 30 Sep 2026, 9:00 IST: the app's "Wed & Sun · 9:00 AM" calendar. */
const S = Date.parse("2026-09-30T03:30:00.000Z");
const WED_SUN = [3, 0];
const trainer = (id, qualityScore) => ({
  id, cityId: "blr", name: id, model: "full_time", services: ["dog_training"], zones: ["blr-east"], live: true,
  rating: 4.9, qualityScore, capacity: 1, travelBufferMinutes: 45, maxDailyJobs: 8,
});
const providers = [trainer("team", 95), trainer("seat2", 90), trainer("seat3", 85)];
/** The chosen trainer already has a booking at the calendar's second session: Sun 4 Oct, 9:00 IST. */
const SECOND_SESSION = Date.parse("2026-10-04T03:30:00.000Z");
const bookings = [{
  id: "earlier-programme", providerId: "team", serviceCode: "dog_training", status: "assigned",
  scheduledStart: iso(SECOND_SESSION), scheduledEnd: iso(SECOND_SESSION + 60 * MINUTE_MS), petIds: ["x"], capacityUnits: 1,
}];
const repo = {
  async listEligibleProviders() { return providers; },
  async listBookings(_cityId, providerId) { return bookings.filter((item) => item.providerId === providerId); },
  async listAvailability(providerId, date) { return [{ id: `a_${providerId}_${date}`, providerId, cityId: "blr", zoneId: "blr-east", date, windows: ["06:00-22:00"], source: "roster", updatedAt: "2026-09-26T00:00:00.000Z" }]; },
  async getPet(id) { return { id, customerId: "c", legacyIds: [], name: id, species: "dog", allergies: [], vaccinationStatus: "verified", createdAt: "", updatedAt: "" }; },
  async close() {},
};
/** The same programme the app reserves: 8 sessions on Wednesdays and Sundays, one dog. */
const programme = (extra = {}) => ({
  cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", petIds: ["Luna"],
  scheduledStart: iso(S), scheduledEnd: iso(S + 60 * MINUTE_MS), occurrences: 8, weekdays: WED_SUN,
  preferredProviderMode: "strict", ...extra,
});

test("engine: the chosen trainer is refused for the whole calendar, and nobody else is reserved in their place", async () => {
  const decision = await schedule(repo, programme({ preferredProviderId: "team" }));
  assert.equal(decision.provider, null, "strict selection never substitutes another trainer");
  assert.equal(decision.occurrences.length, 8);
  assert.deepEqual(decision.occurrences.map((item) => new Date(Date.parse(item.start) + 330 * MINUTE_MS).getUTCDay()), [3, 0, 3, 0, 3, 0, 3, 0]);
  const team = decision.evaluations.find((item) => item.providerId === "team");
  assert.equal(team.eligible, false);
  assert.ok(team.reasons.some((reason) => /conflict/i.test(reason)), team.reasons.join("; "));
  for (const id of ["seat2", "seat3"]) {
    assert.ok(decision.evaluations.find((item) => item.providerId === id).reasons.includes("Another provider was explicitly selected by the customer"));
  }
});

test("engine: the preview of the same calendar names the trainers free for every session", async () => {
  const preview = await schedule(repo, programme());
  assert.deepEqual(preview.shortlist.map((item) => item.provider.id), ["seat2", "seat3"], "the busy trainer is not offered");
});

test("engine: the trainer the customer then chooses is the one reserved, even when another ranks higher", async () => {
  const chosen = await schedule(repo, programme({ preferredProviderId: "seat3" }));
  assert.equal(chosen.provider?.id, "seat3");
  assert.equal(chosen.occurrences.length, 8);
});

const flow = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
const policy = readFileSync(new URL("../lib/provider-assignment-policy.ts", import.meta.url), "utf8");
const reserveStart = flow.indexOf('const schedule:Omit<UatScheduleRequest,"clientRequestId">={customerId:customer.customerId');
const reserveBlock = flow.slice(reserveStart, flow.indexOf("const canonical=await createCanonicalLifecycle", reserveStart));

test("app: a refused trainer leads to a preview of the same calendar, never to a reservation for someone else", () => {
  assert.match(policy, /serviceCode:"dog_training",cityId:"\*",config:\{assignmentMode:"customer_select",preferredProviderMode:"strict"\}/);
  assert.ok(reserveStart > 0 && reserveBlock.length > 0, "the programme reservation");
  assert.equal((reserveBlock.match(/reserveUatSchedule\(/g) || []).length, 1, "one reservation, for the chosen trainer only");
  assert.match(reserveBlock, /reserveUatSchedule\(\{\.\.\.schedule,clientRequestId:requestId,preferredProviderId:selectedTrainer\?\.id\}\)/);
  assert.match(reserveBlock, /if\(!isProviderSlotRefusal\(problem\)\|\|!selectedTrainer\)throw problem;/, "only a refusal of the chosen trainer looks for others");
  assert.match(reserveBlock, /previewUatProviders\(\{\.\.\.schedule,clientRequestId:`\$\{requestId\}:alternatives`\},\{timeoutMs:60_000\}\)/, "the preview describes the exact calendar that was refused");
  assert.match(reserveBlock, /trainer&&trainer\.id!==selectedTrainer\.id\?\[trainer\]:\[\]/, "the refused trainer is not offered again");
  assert.match(reserveBlock, /setCalendarAlternatives\(\{key:calendarKey,trainers:free\}\)/);
  // A preview that timed out or failed is not an answer: the customer is told to try again, not only that the trainer is busy.
  assert.match(reserveBlock, /could not check the other trainers just now\. Try again in a moment, or change the time or days\./);
  assert.doesNotMatch(reserveBlock, /:problem;/, "a failed preview never ends on the bare refusal");
  assert.match(flow, /weekdays:weekdayMap\[frequency\]\};/, "preview and reservation share the weekday calendar");
});

test("app: the review step lists them only for that calendar, and the customer chooses", () => {
  assert.match(flow, /const calendarKey=\[selectedStartIso,frequency,time,trainerId,petKey\]\.join\("\|"\);/);
  assert.match(flow, /const calendarTrainers=calendarAlternatives\?\.key===calendarKey\?calendarAlternatives\.trainers:\[\];/, "a changed time, day, trainer or dog hides the list");
  const list = flow.slice(flow.indexOf('aria-label="Trainers free for every session"') - 200, flow.indexOf("</div>}", flow.indexOf('aria-label="Trainers free for every session"')));
  assert.match(list, /calendarTrainers\.map\(\(item\) => <button key=\{item\.id\} onClick=\{\(\) => \{setTrainerId\(item\.id\);setScheduleError\(""\);\}\}>/, "choosing sets the trainer; the customer confirms again to reserve");
  assert.doesNotMatch(list, /reserveUatSchedule|confirm\(/, "choosing does not reserve by itself");
});
