/* The legacy scheduler still honors an explicitly selected trainer across a series (three engine regressions).
 * Accepted T1 customer checkout now reserves one automatic first appointment in the governed zone.
 * Later customer appointments use the assigned programme's server-offered slot, hold and explicit confirm.
 * The actual helper cases below retain refusal/no-write and chosen-slot boundaries under that current contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__TRAINING_CHOICE_TEST_DB__");

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
const {createRollingBooking}=await import("../lib/training-rolling-booking.ts");
const {trainingReservationForChoice}=await import("../lib/training-availability-client.ts");

test("app: automatic first-appointment refusal never reserves another calendar or starts a booking", async () => {
  assert.match(policy, /serviceCode:"dog_training",cityId:"\*",config:\{assignmentMode:"auto",preferredProviderMode:"strict"\}/);
  const start=flow.indexOf('const selection:RollingSelection={customerId:customer.customerId');
  const block=flow.slice(start,flow.indexOf('const canonical=await createCanonicalLifecycle',start));
  assert.ok(start>0&&block.length>0,"the first-appointment reservation");
  assert.equal((block.match(/reserveUatSchedule\(/g)||[]).length,1,"one reservation attempt only");
  assert.match(block,/trainingReservationForChoice\(selection,\{mode:"auto"\}\)/);
  assert.match(block,/if\(!isProviderSlotRefusal\(problem\)\)throw problem;/);
  assert.match(block,/No certified trainer is free for your first appointment/);
  assert.doesNotMatch(block,/previewUatProviders|preferredProviderId|weekdays:/,"no legacy calendar fallback or customer-selected trainer");
  const quote={quoteId:"Q-FIRST",petCount:1,sessions:8,validityDays:60,minutesPerSession:60,expiresAt:Date.now()+60000,schedulingMode:"rolling_v1"};
  const request=trainingReservationForChoice({customerId:"customer",petIds:["dog"],cityId:"governed-city",zoneId:"governed-zone",scheduledStart:"2026-10-09T04:30:00.000Z",quote,schedulingMode:"rolling_v1"},{mode:"auto"});
  assert.equal(request.cityId,"governed-city");assert.equal(request.zoneId,"governed-zone");assert.equal(request.occurrences,1);
  assert.equal(request.trainingQuoteId,quote.quoteId);assert.equal(request.trainingSchedulingMode,"rolling_v1");assert.equal(request.providerSelection,"auto");assert.equal("preferredProviderId" in request,false);assert.equal(quote.sessions,8,"full entitlement preserved");
  const slot={start:"2026-10-09T04:30:00.000Z",end:"2026-10-09T05:30:00.000Z"},sent=[];
  const machine=createRollingBooking({bookingId:"BK",now:()=>1,client:{loadSummary:async()=>({canSchedule:true,remainingSessions:7,maxUpcomingSessions:3,upcomingSessions:[],holds:[],availableSlots:[slot],providerId:"assigned"}),sendAction:async body=>{sent.push(body);throw Error("Slot unavailable");}}});
  await machine.load();machine.select(slot);await machine.hold();await machine.confirm();
  assert.equal(machine.state.hold,null);assert.notEqual(machine.state.phase,"confirmed");assert.deepEqual(machine.state.confirmedSessionIds,[]);
  assert.deepEqual(sent.map(x=>x.action),["hold"],"refusal never dispatches confirmation or another reservation");
});

test("app: later appointments use one server-offered slot and a bound hold before confirmation",async()=>{
  assert.match(flow,/Only your first appointment|ROLLING_CHECKOUT_COPY/);
  const slot={start:"2026-10-09T04:30:00.000Z",end:"2026-10-09T05:30:00.000Z"},sent=[];
  const machine=createRollingBooking({bookingId:"BK",now:()=>1,client:{loadSummary:async()=>({canSchedule:true,remainingSessions:7,maxUpcomingSessions:3,upcomingSessions:[],holds:[],availableSlots:[slot],providerId:"assigned"}),sendAction:async body=>{sent.push(body);return body.action==="hold"?{holdId:"H",expiresAt:1000}:{status:"confirmed",sessionIds:["S"]};}}});
  await machine.load();machine.select({...slot,start:"2026-10-10T04:30:00.000Z"});await machine.hold();
  assert.equal(sent.length,0,"a non-offered slot cannot create a hold");assert.match(machine.state.error,/slots your trainer offered/);machine.select(slot);
  assert.equal(sent.length,0,"choosing a slot creates no write");await machine.confirm();assert.equal(sent.length,0,"no confirmation before a hold");
  await machine.hold();assert.deepEqual(sent[0].slots,[slot]);assert.equal(sent[0].actorKind,"customer");assert.equal(sent[0].bookingId,"BK");
  await machine.confirm();assert.equal(sent[1].holdId,"H");assert.notEqual(sent[1].idempotencyKey,sent[0].idempotencyKey);assert.equal(sent[1].action,"confirm");assert.equal(machine.state.phase,"confirmed");assert.deepEqual(machine.state.confirmedSessionIds,["S"]);
});
