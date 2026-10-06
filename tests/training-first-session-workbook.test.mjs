import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

/*
 * Workbook "Final testing 27th Sep", Training rows 16-36, customer UI lane (3 Oct 2026):
 *   - no pre-selected programme; a prominent comparison; Meet & Greet is its own package;
 *   - the programme is chosen before the first session's date and time;
 *   - first sessions start on whole hours 08:00-20:00 IST, never in the past, and only after two FULL
 *     preparation days (a booking made 1 Oct may start 4 Oct) - the business decision given on 3 Oct,
 *     mirrored for the screens in lib/training-first-session-rule.ts until the backend owner's module
 *     replaces it;
 *   - address and serviceability are verified before the programme is chosen;
 *   - automatic matching only: no customer trainer selector; "Finding your certified trainer" until the award.
 * Rolling checkout: exactly the first appointment is reserved (occurrences 1, trainingQuoteId, rolling_v1), and the copy
 * says so until the backend single-occurrence reservation and parent booking path land.
 */
installWorkersHooks("__TRAINING_FIRST_SESSION_WORKBOOK__");
const rule = await import("../lib/training-first-session-rule.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flow = read("app/mobile-app/training-flow.tsx");
const page = read("app/training/page.tsx");
// 1 Oct 2026, 10:00 IST: the workbook's worked example.
const OCT_1_10AM = Date.parse("2026-10-01T10:00:00+05:30");

test("two full preparation days: a booking made on 1 October may first start on 4 October, whatever the time of day", () => {
  assert.equal(rule.earliestFirstSessionDate(OCT_1_10AM), "2026-10-04");
  assert.equal(rule.earliestFirstSessionDate(Date.parse("2026-10-01T23:30:00+05:30")), "2026-10-04", "late evening is still 1 October in IST");
  assert.equal(rule.earliestFirstSessionDate(Date.parse("2026-10-01T00:10:00+05:30")), "2026-10-04", "just after midnight IST (still 30 Sep in UTC) counts as 1 October");
  assert.equal(rule.earliestFirstSessionDate(Date.parse("2026-12-30T12:00:00+05:30")), "2027-01-02", "year boundary");
  assert.equal(rule.TRAINING_FIRST_SESSION_UI_MIRROR.fullPreparationDays, 2);
  assert.equal(rule.TRAINING_FIRST_SESSION_UI_MIRROR.temporary, false, "the pre-check mirrors the FINAL backend policy");
  assert.match(rule.TRAINING_FIRST_SESSION_UI_MIRROR.mirrorOf, /final Training backend first-session policy/);
});

test("first-session starts are whole hours from 08:00 to 20:00 IST", () => {
  assert.deepEqual(rule.firstSessionHours(), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(rule.hourLabel(8), "08:00");
  assert.equal(rule.firstSessionStartIso("2026-10-04", 9), "2026-10-04T09:00:00+05:30");
  const at = (date, time) => rule.checkFirstSessionSelection({ date, time, nowMs: OCT_1_10AM });
  assert.deepEqual(at("2026-10-04", "08:00"), { ok: true, startIso: "2026-10-04T08:00:00+05:30" });
  assert.deepEqual(at("2026-10-04", "20:00"), { ok: true, startIso: "2026-10-04T20:00:00+05:30" });
  assert.equal(at("2026-10-04", "07:00").code, "hour_outside_window");
  assert.equal(at("2026-10-04", "21:00").code, "hour_outside_window");
  assert.equal(at("2026-10-04", "10:30").code, "not_whole_hour");
  assert.equal(at("2026-10-04", "").code, "time_invalid");
});

test("past slots and slots inside the preparation days are refused, as are impossible dates and far horizons", () => {
  const at = (date, time) => rule.checkFirstSessionSelection({ date, time, nowMs: OCT_1_10AM });
  assert.equal(at("2026-09-30", "10:00").code, "in_past");
  assert.equal(at("2026-10-01", "09:00").code, "in_past", "earlier today is in the past");
  assert.equal(at("2026-10-01", "11:00").code, "inside_preparation_days", "later today is not two full days ahead");
  assert.equal(at("2026-10-02", "10:00").code, "inside_preparation_days");
  assert.equal(at("2026-10-03", "10:00").code, "inside_preparation_days");
  assert.match(at("2026-10-03", "10:00").reason, /earliest first session is 4 October/);
  assert.equal(at("2026-10-04", "10:00").ok, true);
  assert.equal(at("2026-02-30", "10:00").code, "date_invalid");
  assert.equal(at("2027-05-01", "10:00").code, "beyond_horizon");
  const label = rule.firstSessionRuleLabel(OCT_1_10AM);
  assert.match(label, /two full days/);
  assert.match(label, /booking made on 1 October can start on 4 October/);
  assert.match(label, /booking made today \(1 October\) is 4 October/);
  assert.match(label, /08:00 to 20:00 IST/);
  assert.match(label, /availability and travel time/);
});

test("app flow: the first-appointment dates offered all clear the rule, day by day from the earliest date, on the chosen whole hour", async () => {
  const mod = await import("../app/mobile-app/training-flow.tsx");
  const dates = mod.firstAppointmentStarts("10:00", 42, OCT_1_10AM);
  assert.equal(dates.length, 42);
  assert.equal(dates[0].toISOString(), "2026-10-04T04:30:00.000Z", "4 October at 10:00 IST: two full days after a booking on 1 October");
  for (const [index, date] of dates.entries()) {
    const ist = new Date(date.getTime() + 330 * 60_000);
    assert.equal(ist.getUTCHours(), 10); assert.equal(ist.getUTCMinutes(), 0);
    if (index) assert.equal(date.getTime() - dates[index - 1].getTime(), 86_400_000, "consecutive days: no repeat-schedule filter");
    assert.equal(rule.checkFirstSessionSelection({ date: rule.istDateOf(date.getTime()), time: "10:00", nowMs: OCT_1_10AM }).ok, true);
  }
  assert.equal(mod.firstAppointmentStarts("20:00", 2, OCT_1_10AM)[1].toISOString(), "2026-10-05T14:30:00.000Z", "5 October at 20:00 IST");
  assert.equal(typeof mod.nextTrainingStarts, "undefined", "the repeat-schedule generator is gone");
  assert.equal(typeof mod.MEET_GREET_MIN_LEAD_MINUTES, "number", "the Meet & Greet lead rule is untouched");
});

test("app flow: no programme is pre-selected, the comparison lists every programme and the Meet & Greet as a separate package", () => {
  assert.match(flow, /const emptyPlan:Plan=\{packageCode:"",name:"No programme selected"/);
  assert.doesNotMatch(flow, /next\.find\(item=>item\.packageCode===TRAINING_CORE_PACKAGE_CODE\)/, "no catalogue default");
  assert.doesNotMatch(flow, /appliedRecommendation/, "no recommendation is applied for the customer");
  assert.match(flow, /data-testid="training-plan-compare"/, "the comparison table exists");
  assert.match(flow, /nothing is pre-selected/);
  assert.match(flow, /Meet &amp; Greet<small> · separate package, not part of any programme<\/small>/);
  assert.match(flow, /disabled=\{!plan\.packageCode\} onClick=\{\(\) => setStage\(3\)\}>\{plan\.packageCode\?"Continue to your trainer":"Select a programme to continue"\}/);
  const stageTwo = flow.slice(flow.indexOf("{stage === 2 && ("), flow.indexOf("{stage === 3 && ("));
  assert.ok(stageTwo.indexOf('data-testid="training-plan-compare"') < stageTwo.indexOf('data-testid="training-plan-grid"'), "the comparison comes before the cards");
});

test("app flow: address and coverage are verified at step 1, before any programme or slot", () => {
  const stageOne = flow.slice(flow.indexOf("{stage === 1 && ("), flow.indexOf("{stage === 2 && ("));
  assert.equal((flow.match(/<StayAddress /g) || []).length, 1, "the address control is mounted once");
  assert.match(stageOne, /<StayAddress customerId=\{customer\.customerId\} mode="training" onResolved=\{resolveLocation\}\/>/);
  assert.match(stageOne, /disabled=\{!selectedGoals\.length \|\| selectedPets\.length === 0 \|\| !coverage\}/, "step 1 cannot be left until coverage is confirmed");
  assert.match(stageOne, /Choose your service address so PawSpace can confirm Dog Training covers it/);
  assert.match(flow, /pincode\.length!==6\)\{setScheduleError\("Choose your service address before booking a Meet & Greet\."\)/, "the Meet & Greet address check is kept");
  assert.match(flow, /const serviceCoverage=await resolveServiceCoverage\(pincode\);/, "the server resolves coverage again at reservation");
});

test("app flow: whole-hour first session, the two-day rule on screen, and honest copy about later sessions", () => {
  assert.match(flow, /\[time, setTime\] = useState\("10:00"\)/);
  assert.doesNotMatch(flow, /"9:00 AM"|"3:00 PM"/, "the fixed afternoon chips are gone");
  assert.match(flow, /\{firstSessionHours\(\)\.map\(\(hour\)=><option key=\{hour\} value=\{hourLabel\(hour\)\}>\{hourLabel\(hour\)\}<\/option>\)\}/);
  assert.match(flow, /First session date \(earliest \{earliestFirstSessionDate\(\)\}\)/);
  assert.match(flow, /\{firstSessionRuleLabel\(\)\}/);
  assert.match(flow, /\{ROLLING_CHECKOUT_COPY\}/);
  assert.doesNotMatch(flow, /provisional holds|weekdayMap|Repeat schedule|trainingSessionPreviewDates|Full session calendar|cadenceDays/, "no repeat schedule, no per-session reservation array, no cadence");
  assert.doesNotMatch(flow, /TRAINING_MIN_NOTICE_MS/, "the private 24-hour copy of the rule is gone");
});

test("app flow: automatic matching only - no customer trainer selector, providerSelection auto, no preferredProviderId, no hold provider shown as assigned", () => {
  for (const source of [flow, page]) {
    assert.doesNotMatch(source, /trainerId|selectedTrainer|showTrainerChoice|setProviderSelection|preferredProviderId:|preferredProviderId\?|Choose a specific trainer|Trainers free for every session/, "no selector state, no preferredProviderId property on any request");
    assert.doesNotMatch(source, /assigns one when you reserve|assigned when you reserve|confirmed when you reserve|see the name before you pay|assignment pending until a trainer accepts/);
    assert.match(source, /AUTO_MATCH_COPY/);
    assert.match(source, /AssignedTrainerName|FINDING_TRAINER/, "the trainer slot is always the honest view, never a name from the reservation");
  }
  assert.match(flow, /const selection:RollingSelection=\{customerId:customer\.customerId,petIds:selectedPets,cityId:serviceCoverage\.cityId,zoneId:serviceCoverage\.zoneId,scheduledStart:selectedStart\.toISOString\(\),quote,schedulingMode:TRAINING_SCHEDULING_MODE\};/, "the FULL selection, with the rolling scheduling mode");
  assert.match(flow, /reserveUatSchedule\(trainingReservationForChoice\(selection,\{mode:"auto"\}\)\);/, "the programme reservation goes through the frozen helper in auto mode");
  assert.match(flow, /reserveUatSchedule\(trainingReservationForChoice\(meetSelection,\{mode:"auto"\}\)\);/, "so does the Meet & Greet reservation");
  assert.doesNotMatch(flow, /occurrences:|weekdays:|cadenceDays/, "the screen never builds or stamps occurrences");
  assert.equal((flow.match(/trainerName:FINDING_TRAINER/g) || []).length, 2, "payment pages never name the scheduling hold's provider");
  assert.match(flow, /setConfirmedTrainerName\(FINDING_TRAINER\);/);
  assert.doesNotMatch(flow, /trainerName:decision\.provider\.name|setConfirmedTrainerName\(decision\.provider\.name\)|setMeetTrainerName\(decision\.provider\.name\)/);
  assert.equal((flow.match(/provider:decision\.provider,/g) || []).length, 2, "the canonical booking API still receives the scheduling response provider");
  assert.match(flow, /const ledgerAssignment=trainerAssignmentView\(\{assignment:programmeAssignment\(ledger\)\}\),assignedName=useAssignedTrainerName\(ledgerAssignment\),shownTrainer=ledgerAssignment\.state==="assigned"\?assignedName\?\?ledgerAssignment\.label:trainerName;/, "the dashboard shows the public name only once assigned and resolved");
  assert.match(flow, /<b>PawSpace certified trainer<\/b>/);
  assert.match(page, /const providerSelection="auto" as const;/);
  assert.match(page, /const selection:RollingSelection=\{customerId:customer\.id,petIds:selectedPets\.map\(pet=>pet\.id\),cityId:location\.cityId,zoneId:location\.zoneId,scheduledStart,quote,schedulingMode:TRAINING_SCHEDULING_MODE\};/);
  assert.match(page, /const request=trainingReservationForChoice\(selection,\{mode:providerSelection\}\);/, "auto mode through the frozen helper: one occurrence, trainingQuoteId, trainingSchedulingMode, no preferredProviderId");
  assert.doesNotMatch(page, /trainingScheduleRequest\(|occurrences:|cadenceDays/);
  assert.match(page, /provider:schedule\.provider,requirements:goals/, "the canonical booking API still receives the scheduling response provider");
  assert.doesNotMatch(page, /providerName:schedule\.provider\.name|confirmedProviderName/);
  assert.match(page, /<p>Trainer: \{checkoutAssignment\?\.label\} · \{pendingCheckout\.summary\.petNames\}<\/p><p>\{checkoutAssignment\?\.detail\}<\/p>/);
  assert.match(page, /<strong className=\{styles\.block\}>\{programmeView&&<AssignedTrainerName view=\{programmeView\}\/>\}<\/strong><span>\{programmeView\?\.detail\}<\/span>/);
  for (const source of [page, flow]) assert.doesNotMatch(source, /reminders go|expiry alerts|In-app reminders queued|alerts start/, "no external reminder or expiry delivery is claimed: internal workflow events do not prove delivery");
});

test("trainer assignment view: frozen shape - pending, needs_operations and assigned; no provisional or internal identity is ever shown", async () => {
  const v = await import("../lib/training-assignment-view.ts");
  assert.equal(v.trainerAssignmentView({}).label, v.FINDING_TRAINER, "no assignment (assessment, or before the award): finding");
  const pending = v.trainerAssignmentView({ assignment: { mode: "contractor_broadcast", state: "pending", providerId: null, offerExpiresAt: Date.UTC(2026, 9, 1, 6, 30) } });
  assert.equal(pending.state, "pending"); assert.equal(pending.label, v.FINDING_TRAINER); assert.match(pending.detail, /first valid acceptance/); assert.match(pending.detail, /Answer expected by 1 Oct, 12:00 pm IST/);
  const fullTimePending = v.trainerAssignmentView({ assignment: { mode: "full_time", state: "pending", providerId: null, offerExpiresAt: null } });
  assert.match(fullTimePending.detail, /full-time trainer is being assigned/); assert.doesNotMatch(fullTimePending.detail, /Answer expected/);
  const ops = v.trainerAssignmentView({ assignment: { mode: "contractor_broadcast", state: "needs_operations", providerId: null, offerExpiresAt: null } });
  assert.equal(ops.state, "needs_operations"); assert.equal(ops.label, v.FINDING_TRAINER); assert.match(ops.detail, /PawSpace Operations is arranging your trainer/);
  const fullTime = v.trainerAssignmentView({ assignment: { mode: "full_time", state: "assigned", providerId: "ft_kiran", offerExpiresAt: null } });
  assert.deepEqual([fullTime.state, fullTime.label, fullTime.providerId], ["assigned", v.ASSIGNED_TRAINER, "ft_kiran"]); assert.match(fullTime.detail, /full-time trainer is assigned/);
  const contractor = v.trainerAssignmentView({ assignment: { mode: "assigned", state: "assigned", providerId: "ct_sana", offerExpiresAt: null } });
  assert.equal(contractor.label, v.ASSIGNED_TRAINER, "the view itself carries no name: the public profile resolves it by providerId");
  assert.equal(v.trainerAssignmentView({ assignment: { mode: "assigned", state: "assigned", providerId: null, offerExpiresAt: null } }).state, "pending", "assigned without a providerId is not shown as assigned");
  assert.equal(v.programmeAssignment({ programme: { id: "x" } }), null, "a programme payload without data.assignment reads as no assignment");
  assert.deepEqual(v.programmeAssignment({ assignment: { mode: "contractor_broadcast", state: "pending", providerId: null, offerExpiresAt: 5 } }), { mode: "contractor_broadcast", state: "pending", providerId: null, offerExpiresAt: 5 });
  // The winner's public name is resolved only from the public provider profile, only once assigned.
  const resolver = readFileSync(new URL("../app/training/assigned-trainer.tsx", import.meta.url), "utf8");
  assert.match(resolver, /const providerId = view\?\.state === "assigned" \? view\.providerId : null;/);
  assert.match(resolver, /\/api\/provider-public-profile\?/);
  assert.match(resolver, /body\.data\.displayName/);
  assert.doesNotMatch(resolver + v.FINDING_TRAINER, /provider_id|scheduler|hold/i, "no scheduler hold or internal identity source");
  for (const source of [page, flow]) assert.doesNotMatch(source, /schedule\.provider\.name|decision\.provider\.name|confirmedProviderName|providerName:/, "the scheduling response's provider is never displayed");
});

test("app flow renders: step 1 carries the address control and no programme before the catalogue loads", async () => {
  const Flow = (await import("../app/mobile-app/training-flow.tsx")).default;
  const html = renderToStaticMarkup(React.createElement(Flow, { customer: { customerId: "CUS-FIX-1", customerName: "Asha Rao", phone: "9000000111" } }));
  assert.match(html, /aria-label="Care location"/, "the saved-address control is on step 1");
  assert.match(html, /Choose your service address so PawSpace can confirm Dog Training covers it/);
  assert.match(html, /Choose a package to see session duration/);
  assert.doesNotMatch(html, /Basic Obedience Plan/, "no programme is named as chosen");
  assert.match(html, /<button disabled=""[^>]*>Select a dog to continue<\/button>/, "step 1 stays closed until a dog and coverage exist");
});

test("web page: no default plan, package before first session, whole hours, two-day minimum, certified trainer", () => {
  assert.match(page, /const\[packageCode,setPackageCode\]=useState\(""\)/);
  assert.match(page, /petCount>0&&packageCode\?quoteTraining\(/);
  assert.match(page, /const initialDate=\(\)=>earliestFirstSessionDate\(\);/);
  const sections = ["<h2>1. Your dogs and service address</h2>", "<h2>2. Programme</h2>", "<h2>3. First session</h2>", "<h2>4. Available trainer</h2>", "<h2>What you are buying</h2>"].map((heading) => page.indexOf(heading));
  assert.ok(sections.every((index) => index > 0), "all sections exist");
  assert.deepEqual([...sections].sort((a, b) => a - b), sections, "programme, then first session, then trainer");
  assert.doesNotMatch(page, /type="time"/, "no free-form time input");
  assert.match(page, /<select disabled=\{accountLoading\|\|catalogueLoading\} value=\{time\} onChange=\{event=>setTime\(event\.target\.value\)\} className=\{styles\.input\}>\{firstSessionHours\(\)\.map\(/);
  assert.match(page, /<input type="date" min=\{earliestFirstSessionDate\(\)\} disabled=\{accountLoading\|\|catalogueLoading\} value=\{date\}/);
  assert.match(page, /const firstSession=checkFirstSessionSelection\(\{date,time\}\);/);
  assert.match(page, /\{!firstSession\.ok&&<p role="alert">\{firstSession\.reason\}<\/p>\}/);
  assert.match(page, /petCount===0\|\|!firstSession\.ok\} onClick=\{\(\)=>void confirm\(\)\}/, "the reserve button respects the rule");
  assert.match(page, /selectedPets\.length===0\|\|!firstSession\.ok\)return;/, "confirm() refuses an invalid first session even if the button were forced");
  assert.match(page, /<strong>PawSpace certified trainer<\/strong>/);
  assert.match(page, /\{AUTO_MATCH_COPY\}/);
  assert.match(readFileSync(new URL("../lib/training-assignment-view.ts", import.meta.url), "utf8"), /You do not choose a trainer and none is pre-selected\./);
  assert.doesNotMatch(page, /Choose a specific trainer instead|PawSpace chooses the best available trainer/);
  assert.match(page, /\{ROLLING_CHECKOUT_COPY\}/);
  assert.doesNotMatch(page, /not live yet|provisional holds|Days between sessions|trainingCalendarWindows|Review your session calendar/);
  assert.match(page, /section aria-label="Training service address"/, "the address section is kept");
  assert.match(page, /trainingLocationPincode\(account\)/, "the identity-bound pincode guard is kept");
  assert.doesNotMatch(page, /cadenceDays/, "no cadence in the new checkout");
});

test("comparison component: always expanded, and the Meet & Greet is labelled a separate package", async () => {
  const Choices = (await import("../app/training/training-family-choices.tsx")).default;
  const plans = [
    { package_code: "trainer-meet-greet", name: "Meet & Greet", sessions: 1, base_price: 499, validity_days: 7, meet_and_greet: 1, direct_minutes_per_pet: 30, coaching_minutes_per_pet: 15 },
    { package_code: "training-8-basic", name: "Basic", sessions: 8, base_price: 9999, validity_days: 62, meet_and_greet: 0, direct_minutes_per_pet: 45, coaching_minutes_per_pet: 15 },
    { package_code: "training-4-puppy", name: "Puppy", sessions: 4, base_price: 4999, validity_days: 31, meet_and_greet: 0, direct_minutes_per_pet: 45, coaching_minutes_per_pet: 15 },
  ];
  const recommendation = { basis: "goals", packageCode: "training-8-basic", matchedGoals: ["Recall"], puppyPlanAgeExcluded: false };
  const html = renderToStaticMarkup(React.createElement(Choices, { plans, selectedCode: "", recommendation, petCount: 1, renderChoice: (plan) => React.createElement("button", { key: plan.package_code, "data-code": plan.package_code }, plan.name) }));
  assert.match(html, /A separate package: one introduction session, booked and paid on its own/);
  assert.match(html, /<details class="[^"]*" open="">/, "the comparison is open even with a suggestion");
  assert.match(html, /Nothing is pre-selected/);
  assert.doesNotMatch(html, /Selected programme:/, "with no selection nothing is called selected");
  // Three plans, plus the suggested plan repeated inside its own "matched to your goals" block.
  assert.equal((html.match(/data-code=/g) || []).length, 4);
  assert.equal((html.match(/data-code="trainer-meet-greet"/g) || []).length, 1, "the Meet & Greet appears once, in its own section");
});

test("rolling checkout contract: schedulingMode on every quote, the frozen helper reserves the first appointment, entitlement kept, next appointments only through the frozen rolling helpers", async () => {
  const roll = await import("../lib/training-rolling-checkout.ts");
  assert.equal(roll.TRAINING_SCHEDULING_MODE, "rolling_v1");
  assert.equal(roll.trainingEntitlementSummary({ sessions: 8, minutesPerSession: 60, validityDays: 60 }), "8 sessions · 60 min each · valid for 60 days");
  assert.equal((page.match(/,schedulingMode:TRAINING_SCHEDULING_MODE\} as RollingQuoteInput\)/g) || []).length, 1, "the page quote carries schedulingMode");
  assert.equal((flow.match(/,schedulingMode:TRAINING_SCHEDULING_MODE\} as RollingQuoteInput\)/g) || []).length, 2, "programme and Meet & Greet quotes both carry schedulingMode");
  assert.match(page, /scheduledStart,quote:nextQuote,schedulingMode:TRAINING_SCHEDULING_MODE\} as RollingSelection,providerResult\.providers/, "availability is checked for the same rolling selection");
  assert.doesNotMatch(readFileSync(new URL("../lib/training-rolling-checkout.ts", import.meta.url), "utf8"), /occurrences|rollingFirstAppointment|rollingQuoteInput/, "no stamping or session reconstruction on the lane side");
  assert.match(flow, /frequency:TRAINING_SCHEDULING_MODE/, "the programme request identity no longer varies by a repeat schedule");
  for (const source of [page, flow]) assert.match(source, /<NextAppointment key=\{[a-zA-Z.]+\} bookingId=/, "later appointments are booked one at a time from the programme view, one control per booking");
  assert.match(page, /aria-label="Your programme entitlement"/);
  // No raw trainer id ever reaches the customer: only the assignment view and the public name.
  assert.doesNotMatch(page, /provider_id\}|\.provider_id\b/, "the page prints no provider_id");
  assert.doesNotMatch(flow, /\$\{nextSession\.provider_id\}|provider_id\}/, "the app prints no provider_id");
  assert.match(flow, /\$\{serviceMinutes\} min · \$\{shownTrainer\}`/, "the next-session line names the assigned trainer view, never an id");
  assert.match(page, /Your first appointment is reserved\. The rest of your purchased sessions are scheduled later, one at a time/);
  assert.doesNotMatch(page, /Your sessions are reserved/);
  // The raw rolling client is retired (Git history keeps it); only the frozen helpers may book.
  assert.equal(fs.existsSync(new URL("../lib/training-rolling-schedule-client.ts", import.meta.url)), false, "lib/training-rolling-schedule-client.ts is retired");
  const component = readFileSync(new URL("../app/training/next-appointment.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /fetch\(|\/api\/training-rolling-schedule|scheduledStart|programmeId/, "the control never posts on its own");
  assert.match(component, /createRollingBooking\(\{ bookingId, client: client \?\? frozenRollingClient\(\)/);
  const machine = readFileSync(new URL("../lib/training-rolling-booking.ts", import.meta.url), "utf8");
  assert.match(machine, /import \* as programmeClient from "\.\/training-programme-client";/, "bound to the frozen client module");
  assert.match(machine, /exports\.loadTrainingRollingSummary\(bookingId, signal\)/); assert.match(machine, /exports\.sendTrainingRollingAction\(input\)/);
  assert.match(machine, /action: "hold", idempotencyKey: this\.holdKeyFor\(slot\), slots: \[slot\]/);
  assert.match(machine, /action: "confirm", idempotencyKey: this\.confirmKeyFor\(hold\.holdId\), holdId: hold\.holdId/);
  const { default: NextAppointment } = await import("../app/training/next-appointment.tsx");
  const view = await import("../lib/training-assignment-view.ts");
  const pending = renderToStaticMarkup(React.createElement(NextAppointment, { bookingId: "BK1", assignment: view.trainerAssignmentView({}) }));
  assert.match(pending, /Finding your certified trainer/); assert.doesNotMatch(pending, /<button/, "nothing can be sent before the award");
  const assignedView = view.trainerAssignmentView({ assignment: { mode: "assigned", state: "assigned", providerId: "ct_sana", offerExpiresAt: null } });
  const idle = { loadSummary: () => new Promise(() => {}), sendAction: () => Promise.reject(new Error("not in this test")) };
  const assigned = renderToStaticMarkup(React.createElement(NextAppointment, { bookingId: "BK1", assignment: assignedView, trainerName: "Sana F.", client: idle }));
  assert.match(assigned, /Book your next appointment with Sana F\./); assert.match(assigned, /Loading your programme/); assert.doesNotMatch(assigned, /Hold this slot|Confirm this appointment/, "no slot and no action before the summary arrives");
  const unnamed = renderToStaticMarkup(React.createElement(NextAppointment, { bookingId: "BK1", assignment: assignedView, client: idle }));
  assert.match(unnamed, /Book your next appointment with your certified trainer/, "no name is invented while the public profile resolves");
});

test("assessment (Meet & Greet) confirmation reads the execution assignment from the programme ledger, so an immediately assigned full-time trainer is not shown as pending", async () => {
  assert.match(page, /const assessmentBookingId=booking&&!programme\?booking\.bookingId:"";/);
  assert.match(page, /loadTrainingProgramme\(assessmentBookingId,controller\.signal\)/);
  assert.match(page, /Trainer: <AssignedTrainerName view=\{assessmentView\}\/>\. \{assessmentView\.detail\}/);
  assert.match(flow, /loadTrainingProgramme\(meetBookingId,controller\.signal\)/);
  assert.match(flow, /<AssignedTrainerName view=\{meetAssignmentView\}\/>/);
  assert.doesNotMatch(flow, /meetTrainerName|setMeetTrainerName/, "no provisional name is carried from the reservation");
  const view = await import("../lib/training-assignment-view.ts");
  const { default: AssignedTrainerName } = await import("../app/training/assigned-trainer.tsx");
  const fullTime = view.trainerAssignmentView({ assignment: view.programmeAssignment({ assignment: { mode: "full_time", state: "assigned", providerId: "ft_kiran", offerExpiresAt: null } }) });
  assert.equal(fullTime.state, "assigned");
  assert.equal(renderToStaticMarkup(React.createElement(AssignedTrainerName, { view: fullTime })), view.ASSIGNED_TRAINER, "assigned at once, before the public name resolves");
  const pendingBroadcast = view.trainerAssignmentView({ assignment: view.programmeAssignment({ assignment: { mode: "contractor_broadcast", state: "pending", providerId: null, offerExpiresAt: null } }) });
  assert.equal(renderToStaticMarkup(React.createElement(AssignedTrainerName, { view: pendingBroadcast })), view.FINDING_TRAINER);
  assert.equal(renderToStaticMarkup(React.createElement(AssignedTrainerName, { view: view.trainerAssignmentView({ assignment: view.programmeAssignment({ programme: {} }) }) })), view.FINDING_TRAINER, "a ledger without data.assignment reads as finding");
});
