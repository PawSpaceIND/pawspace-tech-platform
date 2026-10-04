/**
 * Workbook "Final testing 27th Sep", Boarding/Sitting rows 41-59, customer UI lane.
 *
 * Executed diagnostics first: the real preview and reserve routes behind the real gateway, against the staging
 * capacity seed, reproduce the "sitter-empty" and "reservation refused" failures and pin what the server actually
 * answers. Then the Plan-step time rules, the diagnosis copy, the rendered Plan step (top back control, whole-hour
 * controls, gated chat, host privacy) and the source wiring. Nothing here claims a sitter or host exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import * as h from "./helpers/stay-taxi-latency-harness.mjs";

installWorkersHooks("__STAY_WORKBOOK_DB__", "__STAY_WORKBOOK_ENV__", { authoredRosterFixture: false });
h.stubGeocoding();
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: StayFlow } = await import("../app/mobile-app/stay-flow.tsx");
const d = await import("../lib/stay-search-diagnosis.ts");
const requests = await import("../lib/boarding-host-requests.ts");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const world = () => h.stayWorld({ dbGlobal: "__STAY_WORKBOOK_DB__", envGlobal: "__STAY_WORKBOOK_ENV__", env: { PAWSPACE_SCHEDULING_ENV: "uat" } });
const preview = (w, label, scheduledStart, scheduledEnd, careMode) => h.timed(w, h.schedulingRequest(w, { action: "preview", clientRequestId: `preview:${label}`, petIds: [h.PETS.dog], serviceCode: "pet_sitting", careMode, scheduledStart, scheduledEnd }), scheduling.POST);
const reserve = (w, label, body) => h.timed(w, h.schedulingRequest(w, { clientRequestId: `reserve:${label}`, petIds: [h.PETS.dog], serviceCode: "pet_sitting", ...body }), scheduling.POST);
/** The staging seed publishes sitter availability yesterday..+15 days (scripts/uat-staging-provider-capacity.sql). */

test("DIAGNOSIS sitter-empty: a Home Visit inside the published roster lists sitters; one past it lists none, with the check finished", async () => {
  const w = await world();
  const inside = await preview(w, "inside", h.ist(3, 10), h.ist(3, 11), "visit");
  assert.equal(inside.status, 200, JSON.stringify(inside.body));
  assert.ok(inside.body.data.providers.length > 0, "sitters inside the published roster");
  const past = await preview(w, "past", h.ist(40, 10), h.ist(40, 11), "visit");
  assert.equal(past.status, 200, JSON.stringify(past.body));
  assert.deepEqual(past.body.data.providers, [], "no sitter has published availability 40 days out");
  assert.equal(past.body.data.availabilityChecked, true, "the server reports a FINISHED check, not a timeout: the screen must not say 'still checking'");
  assert.equal("evaluations" in past.body.data, false, "the preview carries no reason: the diagnosis has to come from what the screen itself knows");
  const published = w.sqlite.prepare("SELECT max(date) last FROM scheduling_availability WHERE source IN ('partner_app','operations','roster')").get();
  assert.ok(published.last < h.ist(40, 10).slice(0, 10), `the published roster ends ${published.last}, before the empty search's date`);
});

test("DIAGNOSIS reservation refused: reserving a sitter past the published roster is SELECTED_SITTER_UNAVAILABLE with the engine's calendar reason, and the screen maps it to a next step", async () => {
  const w = await world();
  const inside = await preview(w, "pick", h.ist(3, 10), h.ist(3, 11), "visit");
  const sitter = inside.body.data.providers[0].id;
  const refused = await reserve(w, "past", { scheduledStart: h.ist(40, 10), scheduledEnd: h.ist(40, 11), careMode: "visit", preferredProviderId: sitter });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "SELECTED_SITTER_UNAVAILABLE");
  const reasons = refused.body.evaluations.filter((item) => item.providerId === sitter).flatMap((item) => item.reasons);
  assert.ok(reasons.some((reason) => /no explicitly Open calendar on \d{4}-\d{2}-\d{2}/.test(reason)), reasons.join(" | "));
  const diagnosis = d.stayReservationDiagnosis({ code: refused.body.error });
  assert.equal(diagnosis.goTo, "caregiver");
  assert.match(diagnosis.headline, /no published availability/);
  // The other refusals the reserve path can return, each with a destination the screen can act on.
  const none = await reserve(w, "nosel", { scheduledStart: h.ist(3, 10), scheduledEnd: h.ist(3, 11), careMode: "visit" });
  assert.equal(none.status, 409); assert.equal(none.body.error, "host_selection_required");
  assert.equal(d.stayReservationDiagnosis({ code: none.body.error }).goTo, "caregiver");
  const soon = await reserve(w, "soon", { scheduledStart: h.ist(0, 23, 59), scheduledEnd: new Date(Date.parse(h.ist(0, 23, 59)) + 3_600_000).toISOString(), careMode: "visit", preferredProviderId: sitter });
  assert.equal(soon.status, 400); assert.equal(soon.body.code, "below_minimum_lead_time");
  assert.equal(d.stayReservationDiagnosis({ code: soon.body.code }).goTo, "plan");
  assert.equal(d.stayReservationDiagnosis(new Error("anything else")), null, "an unrecognised failure gets no invented next step");
});

test("Plan-step time rules: whole hours 08:00-20:00 for check-in and check-out, a Home Visit has no check-out rule, and a past check-in is named as past", () => {
  assert.equal(d.stayTimeProblem({ startTime: "09:00", endTime: "09:00", visitMode: false }), null);
  assert.equal(d.stayTimeProblem({ startTime: "20:00", endTime: "08:00", visitMode: false }), null);
  assert.equal(d.stayTimeProblem({ startTime: "09:30", endTime: "09:00", visitMode: false }).code, "start_not_whole_hour");
  assert.equal(d.stayTimeProblem({ startTime: "07:00", endTime: "09:00", visitMode: false }).code, "start_outside_hours");
  assert.equal(d.stayTimeProblem({ startTime: "21:00", endTime: "09:00", visitMode: false }).code, "start_outside_hours");
  assert.equal(d.stayTimeProblem({ startTime: "09:00", endTime: "21:00", visitMode: false }).code, "end_outside_hours");
  assert.equal(d.stayTimeProblem({ startTime: "09:00", endTime: "09:15", visitMode: false }).code, "end_not_whole_hour");
  assert.equal(d.stayTimeProblem({ startTime: "09:00", endTime: "21:00", visitMode: true }), null, "a visit's end is derived, never typed");
  assert.match(d.stayTimeProblem({ startTime: "07:00", endTime: "09:00", visitMode: false }).message, /between 08:00 and 20:00 IST/);
  const now = Date.UTC(2026, 9, 1, 4, 30);
  assert.equal(d.stayPastProblem(now - 60_000, now).code, "in_past");
  assert.equal(d.stayPastProblem(now + 60_000, now), null);
  assert.match(d.EMERGENCY_CARE_NOTE, /24 hours' notice/);
});

test("search diagnosis says what was checked and gives a support reference; it never claims a sitter exists", () => {
  const empty = d.staySearchDiagnosis({ mode: "sitting", zoneId: "blr-east", area: "Indiranagar", date: "2026-11-13", startTime: "10:00", windowSummary: "1 hour · 13 Nov, 10:00 am → 13 Nov, 11:00 am", careMode: "visit", petCount: 1, species: ["dog"] });
  assert.equal(empty.reference, "SIT-EMPTY-blr-east-2026-11-13-1000-visit-1P");
  assert.match(empty.headline, /No sitter has published availability covering this care window in Indiranagar/);
  assert.ok(empty.checked.some((line) => /finished; this is not a timeout/.test(line)));
  assert.doesNotMatch(JSON.stringify(empty), /Verified|100\+|will be available/);
  const hosts = d.staySearchDiagnosis({ mode: "boarding", zoneId: "blr-east", date: "2026-11-13", startTime: "09:00", windowSummary: "2 nights", careMode: "overnight", petCount: 2, species: ["dog", "cat"], requirements: ["Medication"] });
  assert.equal(hosts.reference, "BRD-EMPTY-blr-east-2026-11-13-0900-overnight-2P");
  assert.ok(hosts.checked.some((line) => line === "Must-haves: Medication"));
});

for (const mode of ["boarding", "sitting"]) test(`${mode}: the rendered Plan step carries the top back control, whole-hour 08:00-20:00 time controls, the emergency note, and no pre-confirmation chat`, () => {
  const html = renderToStaticMarkup(React.createElement(StayFlow, { mode, customer: { customerId: "test-customer", customerName: "Test", phone: "9000000000" } }));
  assert.match(html, /<nav class="topBack" aria-label="Booking navigation"><a href="\/mobile-app">← Back to My PawSpace<\/a><\/nav>/);
  assert.equal((html.match(/type="time" step="3600" min="08:00" max="20:00"/g) || []).length, 2);
  assert.match(html, /Check-in and check-out are on the hour, 08:00 to 20:00 IST/);
  assert.match(html, /emergency path is handled by PawSpace support/);
  assert.doesNotMatch(html, /Chat securely|Verified<\/|100\+/);
});

test("stay-flow source: diagnostics, filters, gated chat, host privacy, add-on honesty and post-payment care copy are wired; the reservation contract is unchanged", () => {
  const flow = read("app/mobile-app/stay-flow.tsx");
  for (const needle of [
    'data-testid="stay-search-diagnosis"', 'data-testid="stay-reservation-diagnosis"',
    "setScheduleDiagnosis(stayReservationDiagnosis(error))", "const searchFinishedEmpty = caregivers.length === 0 &&",
    'aria-label="Host filters"', "{visibleCaregivers.map((c) => (", "No host matches these filters.",
    "Exact home address is shared only after your booking is confirmed.", "Private chat is linked to the confirmed stay",
    "{ADD_ON_PRICE_NOTE}", "Complete their Care Card after payment, before your host can check them in.", "← Back to {STAGE_NAMES[stage - 2]}",
    "{timeRuleProblem && <p className={styles.hint} role=\"alert\">{timeRuleProblem.message}</p>}",
    "const datesValid = windowOk && !windowProblem && !timeRuleProblem;",
  ]) assert.ok(flow.includes(needle), `missing: ${needle}`);
  assert.equal(flow.split('data-testid="stay-search-diagnosis"').length, 2);
  assert.doesNotMatch(flow, /setChatOpen|Chat securely|styles\.secureChat/);
  // The reservation keeps caregiver choice and price re-check; mandatory care moves after payment, before check-in.
  assert.match(flow, /preferredProviderId:mode==="boarding"\?governedHost\?\.providerId:selectedSitter\?\.providerId/);
  assert.match(flow, /if\(!sameReviewedStayQuote\(activeQuote,refreshed\)\)/);
  assert.doesNotMatch(flow, /if\(missingStayCareFields\(mode,careDraft\)\.length\)\{setScheduleError/);
  assert.match(flow, /mode === "boarding" \? "Host area" : "Service address"/);
  assert.match(flow, /caregiver\.area \|\| "Your selected host area"/);
  assert.match(flow, /serviceLocation\?\.address\|\|"Verify your saved address"/);
  assert.match(flow, /\{sitterError\|\|"No sitter is available for this care window\. Try different dates\."\}/);
  // A host filter never widens the search: it only filters hosts the search returned.
  assert.match(flow, /const visibleCaregivers = mode === "boarding" \? caregivers\.filter\(\(host\) => matchesHostFilters\(host, hostFilters\)\) : caregivers;/);
});

test("host privacy: nothing the customer screens receive or render carries a host's exact address", () => {
  const client = read("lib/boarding-commercial-client.ts"), discovery = read("lib/boarding-host-discovery.ts"), card = read("app/mobile-app/host-profile-card.tsx"), profile = read("app/api/provider-public-profile/route.ts");
  assert.doesNotMatch(client.match(/export type BoardingHost=\{[^}]*\}/)[0], /address|latitude|longitude|pincode/);
  assert.doesNotMatch(discovery.match(/export type BoardingDiscoveredHost=\{[^}]*\}/)[0], /address|latitude|longitude|pincode/);
  assert.doesNotMatch(card, /address|latitude|longitude|pincode/i);
  assert.match(profile, /no address, no phone/);
});

test("chargeable add-ons: no priced Boarding add-on catalogue exists, and the screen says so instead of inventing prices", () => {
  assert.match(requests.ADD_ON_PRICE_NOTE, /No priced Boarding add-ons are published yet/);
  const flow = read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /<p className=\{styles\.hint\}>\{HOST_REQUESTS_NOTE\}<\/p><p className=\{styles\.hint\}>\{ADD_ON_PRICE_NOTE\}<\/p>/);
  assert.doesNotMatch(flow, /₹\s*\d+\s*(add-on|extra)/i);
});

test("care card after payment: both manage panels keep editing open until the stay closes and the lifecycle refuses a plan without vet and emergency contact", () => {
  const boarding = read("app/mobile-app/boarding-customer-stay-panel.tsx"), sitting = read("app/mobile-app/sitting-customer-panel.tsx"), lifecycle = read("lib/boarding-stay-lifecycle.ts");
  assert.match(boarding, /saveCustomerBoardingCare\(bookingId,plan,careIntent\.current\.key\)/);
  assert.match(sitting, /required=\{\['emergencyContact','vet','homeAccess'\]\.includes\(key\)\} disabled=\{busy\|\|closed\}/);
  assert.match(sitting, /const closed=Boolean\(data&&\['completed','cancelled'\]\.includes\(data\.status\)\)/);
  assert.match(lifecycle, /if\(\["completed","cancelled"\]\.includes\(status\)\)throw new Response\("Care plan cannot change after the stay is closed"/);
  assert.match(lifecycle, /Boarding care plan requires emergency contact and vet details/);
});
