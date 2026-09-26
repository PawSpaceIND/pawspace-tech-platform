/**
 * Boarding and Pet Sitting reserve and booking creation on STAGING. At ~250 ms per D1 call a reserve took
 * ~28 s and a Boarding canonical booking ~21 s, so customers who had picked a host or sitter timed out on
 * the review screen.
 *
 * These EXECUTE the real scheduling and canonical-booking routes behind the real gateway modules (as
 * worker/index.ts runs them, in its per-request scope) against node:sqlite loaded with the staging roster,
 * with every D1 call counted and, for the timing cases, delayed. They pin a bounded D1 budget, an answer inside
 * 20 round trips (5 s at 250 ms), and the SAME outcomes as before the change for the same sequence of
 * customer actions - captured on the previous code: which host or sitter is assigned, replays, capacity,
 * SIT-03 overnight exclusivity with the travel buffer, the vaccination refusal and the persisted roster.
 * The hosts and sitters are the test's own (h.OWN_ROSTER), so a later staging seed edit cannot move an
 * expectation. STAY_CAPTURE=1 prints every observed outcome instead of asserting it: that is how the
 * expectations below were taken, by running this file against the code before the change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import * as h from "./helpers/stay-taxi-latency-harness.mjs";

installWorkersHooks("__STAY_BOOKING_DB__", "__STAY_BOOKING_ENV__");
h.stubGeocoding();
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const boarding = await import("../app/api/boarding-commercial/route.ts");
const canonical = await import("../app/api/canonical-bookings/route.ts");

const world = (extra = 0) => h.stayWorld({ dbGlobal: "__STAY_BOOKING_DB__", envGlobal: "__STAY_BOOKING_ENV__", extra, ownRoster: true });
const CAPTURE = Boolean(process.env.STAY_CAPTURE);
const same = (actual, expected, label) => CAPTURE ? console.log(`CAPTURE ${label} ${JSON.stringify(actual)}`) : assert.deepEqual(actual, expected, label);
const customer = { id: h.CUSTOMER, name: "Stay Latency", primaryPhone: "9000099001" };
const outcome = (r) => r.status === 200 ? [r.body.data.status, r.body.data.provider?.id, r.body.data.duplicatePrevented ?? false] : [r.status, r.body?.error ?? r.body];
const ROUND_TRIPS = 20, LATENCY_MS = 40;
// Captured by running this file with STAY_CAPTURE=1 against the code before the change, on h.OWN_ROSTER.
// Each one-family home drops out once it holds a family; the larger homes lose one place per stay.
const BOARDING_ROUNDS = [
  ["stay_host_one_family", ["stay_host_one_family:2", "stay_host_small:2", "stay_host_large:4", "stay_host_mid:3"]],
  ["stay_host_small", ["stay_host_small:2", "stay_host_large:4", "stay_host_mid:3"]],
  ["stay_host_large", ["stay_host_large:4", "stay_host_mid:3"]],
];
const BOARDING_AFTER = ["stay_host_large:3", "stay_host_mid:3"];
const BOARDING_ROSTER = Array(3).fill('["00:00-23:59"]');
const SITTERS_BEFORE = ["stay_sit_third", "stay_sit_fourth", "stay_sit_second"];
const SITTERS_AFTER = ["stay_sit_fourth", "stay_sit_second", "stay_sit_top"];

async function boardingStay(w, group, stay, host, { latency = 0 } = {}) {
  const quote = await h.timed(w, h.boardingQuoteRequest(w, { packageCode: "boarding-4h", petCount: 1, ...stay, providerId: host }), boarding.POST);
  w.latency.ms = latency;
  const reserve = await h.timed(w, h.schedulingRequest(w, { clientRequestId: group, petIds: [h.PETS.dog], serviceCode: "boarding", careMode: "visit", preferredProviderId: host, ...stay }), scheduling.POST);
  const q = quote.body?.data, provider = reserve.body?.data?.provider;
  const body = { idempotencyKey: group, scheduleGroupId: group, customer, pets: [{ sourceId: h.PETS.dog, name: "Bruno", species: "dog", vaccinationStatus: "verified" }], cityId: "blr", zoneId: "blr-east", serviceCode: "boarding", packageCode: q?.packageCode, packageName: q?.packageName, ...stay, provider: provider && { id: provider.id, name: provider.name, model: provider.model }, totalAmount: q?.totalAmount, amountDueNow: q?.amountDueNow, payment: { method: "upi", mode: q?.paymentMode, status: "created", detail: "Awaiting" }, pricing: { discount: 0, boardingQuoteId: q?.quoteId } };
  const booking = reserve.status === 200 ? await h.timed(w, h.canonicalBookingRequest(w, body), canonical.POST) : null;
  w.latency.ms = 0;
  return { reserve, booking, body };
}
const sittingReserve = (w, label, scheduledStart, scheduledEnd, careMode, preferredProviderId) =>
  h.timed(w, h.schedulingRequest(w, { clientRequestId: `stay:sit-${label}`, petIds: [h.PETS.dog], serviceCode: "pet_sitting", careMode, preferredProviderId, scheduledStart, scheduledEnd }), scheduling.POST);

test("Boarding: hosts are assigned, replayed and booked exactly as before, and a busy home stops being offered", async () => {
  const w = await world();
  const stay = { scheduledStart: h.ist(3, 10), scheduledEnd: h.ist(3, 14) };
  for (const [round, [host, offered]] of BOARDING_ROUNDS.entries()) {
    const search = await h.timed(w, h.boardingSearchRequest(w, { ...stay, petCount: 1, species: ["dog"] }), boarding.GET);
    same(search.body.data.hosts.map((x) => `${x.providerId}:${x.availableGuestPets}`), offered, `round ${round} search`);
    const group = `stay:round-${round}`, { reserve, booking, body } = await boardingStay(w, group, stay, host);
    same(outcome(reserve), ["assigned", host, false], `round ${round} reserve`);
    same(outcome(await h.timed(w, h.schedulingRequest(w, { clientRequestId: group, petIds: [h.PETS.dog], serviceCode: "boarding", careMode: "visit", preferredProviderId: host, ...stay }), scheduling.POST)), ["assigned", host, true], `round ${round} replay`);
    same([booking?.status, booking?.body.data.status, booking?.body.data.duplicatePrevented], [201, "payment_pending", false], `round ${round} booking`);
    const replay = await h.timed(w, h.canonicalBookingRequest(w, body), canonical.POST);
    same([replay.status, replay.body.data?.duplicatePrevented], [200, true], `round ${round} booking replay`);
  }
  const last = await h.timed(w, h.boardingSearchRequest(w, { ...stay, petCount: 1, species: ["dog"] }), boarding.GET);
  same(last.body.data.hosts.map((x) => `${x.providerId}:${x.availableGuestPets}`), BOARDING_AFTER, "search after the three stays");
  w.sqlite.prepare("UPDATE canonical_pets SET vaccination_status='pending' WHERE id=?").run(h.PETS.cat);
  const unvaccinated = await h.timed(w, h.schedulingRequest(w, { clientRequestId: "stay:unvax", petIds: [h.PETS.cat], serviceCode: "boarding", careMode: "visit", preferredProviderId: "stay_host_large", scheduledStart: h.ist(6, 10), scheduledEnd: h.ist(6, 14) }), scheduling.POST);
  same(outcome(unvaccinated), [409, "Boarding requires verified vaccination for every selected pet"], "unvaccinated");
  // The reserve path still publishes the synthetic UAT roster rows it always wrote.
  const roster = w.sqlite.prepare("SELECT windows_json FROM scheduling_availability WHERE source='uat_roster' AND provider_id=? ORDER BY date").all(BOARDING_ROUNDS[0][0]);
  same(roster.map((row) => row.windows_json), BOARDING_ROSTER, "persisted UAT roster");
});

test("Pet Sitting: SIT-03 overnight exclusivity and the travel buffer refuse and assign exactly as before", async () => {
  const w = await world();
  const preview = await h.timed(w, h.schedulingRequest(w, { action: "preview", clientRequestId: "preview:x", petIds: [h.PETS.dog], serviceCode: "pet_sitting", careMode: "overnight", scheduledStart: h.ist(6, 20), scheduledEnd: h.ist(7, 8) }), scheduling.POST);
  same(preview.body.data.providers.map((provider) => provider.id), SITTERS_BEFORE, "overnight shortlist");
  const sitter = SITTERS_BEFORE[0] ?? preview.body.data.providers[0].id;
  const refused = [409, "SELECTED_SITTER_UNAVAILABLE"];
  same(outcome(await sittingReserve(w, "overnight", h.ist(6, 20), h.ist(7, 8), "overnight", sitter)), ["assigned", sitter, false], "overnight");
  same(outcome(await sittingReserve(w, "during", h.ist(6, 22), h.ist(6, 23), "visit", sitter)), refused, "no visit inside the overnight");
  same(outcome(await sittingReserve(w, "buffer", h.ist(7, 8, 10), h.ist(7, 9, 10), "visit", sitter)), refused, "no visit inside the travel buffer");
  same(outcome(await sittingReserve(w, "after", h.ist(7, 11), h.ist(7, 12), "visit", sitter)), ["assigned", sitter, false], "visit after the buffer");
  const after = await h.timed(w, h.schedulingRequest(w, { action: "preview", clientRequestId: "preview:y", petIds: [h.PETS.dog], serviceCode: "pet_sitting", careMode: "overnight", scheduledStart: h.ist(6, 20), scheduledEnd: h.ist(7, 8) }), scheduling.POST);
  same(after.body.data.providers.map((provider) => provider.id), SITTERS_AFTER, "the booked sitter is no longer offered");
});

test("a warm Boarding reserve and booking stay inside their D1 budget and 20 round trips each (5 s at 250 ms)", async () => {
  const w = await world(30);
  const days = [3, 4, 5];
  let last;
  for (const [index, day] of days.entries()) {
    const stay = { scheduledStart: h.ist(day, 10), scheduledEnd: h.ist(day, 14) };
    last = await boardingStay(w, `stay:budget-${day}`, stay, "stay_host_large", { latency: index === days.length - 1 ? LATENCY_MS : 0 });
  }
  assert.equal(last.reserve.status, 200, JSON.stringify(last.reserve.body));
  assert.equal(last.booking.status, 201, JSON.stringify(last.booking.body));
  for (const [label, result, budget] of [["reserve", last.reserve, 35], ["booking", last.booking, 30]]) {
    assert.ok(result.calls.length <= budget, `${label}: ${result.calls.length} D1 calls (limit ${budget})\n${result.calls.map((call) => call.sql.slice(0, 100)).join("\n")}`);
    assert.ok(result.elapsedMs < ROUND_TRIPS * LATENCY_MS, `${label} took ${Math.round(result.elapsedMs)} ms at ${LATENCY_MS} ms per call`);
  }
  assert.ok(!last.booking.calls.some((call) => /^\s*(CREATE|ALTER|PRAGMA)\b/i.test(call.sql) || /^BATCH CREATE/.test(call.sql)), "no schema work on a warm booking");
  assert.equal(last.reserve.calls.filter((call) => call.sql.startsWith("SELECT s.*,b.status binding_status")).length, 1, "one session lookup per reserve");
  assert.equal(last.booking.calls.filter((call) => call.sql.startsWith("SELECT s.*,b.status binding_status")).length, 1, "one session lookup per booking, gateway and route together");
});

test("a warm Pet Sitting reserve stays inside its D1 budget and 20 round trips (5 s at 250 ms)", async () => {
  const w = await world(30);
  let result;
  for (const [index, day] of [3, 4, 5].entries()) {
    w.latency.ms = index === 2 ? LATENCY_MS : 0;
    result = await sittingReserve(w, `budget-${day}`, h.ist(day, 11), h.ist(day, 12), "visit", "stay_sit_third");
    w.latency.ms = 0;
  }
  assert.deepEqual(outcome(result), ["assigned", "stay_sit_third", false]);
  assert.ok(result.calls.length <= 35, `${result.calls.length} D1 calls (limit 35)`);
  assert.ok(result.elapsedMs < ROUND_TRIPS * LATENCY_MS, `took ${Math.round(result.elapsedMs)} ms at ${LATENCY_MS} ms per call`);
});
