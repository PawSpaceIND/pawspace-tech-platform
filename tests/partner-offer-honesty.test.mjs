/**
 * Owner report from STAGING: "Sitter is not able to accept the order".
 *
 * The sitter's Partner app counted two stale seeded bookings (13-14 Aug, today 26 Sep) as "active jobs",
 * and the Sitting workspace showed "confirmed" with an enabled "Accept booking" button while the lifecycle
 * answered 409 sitting_offer_expired: commission sitter and host offers expire acceptance_timeout_minutes
 * after booking and nothing on screen said so. Hosts and drivers had the same blind spot.
 *
 * These cases pin the fix end to end: the server reads each job's offer the way the accept path does
 * (lib/provider-offer-state.ts), every partner surface renders Accept only for an open offer, and expired,
 * reassigned or past jobs are filed under Needs Operations / Past instead of being counted as active.
 * Every case fails on the code before the fix.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { makeD1, seedBoardingStay, seedCanonicalStayBooking, seedSittingBooking } from "./helpers/stay-harness.mjs";

installWorkersHooks("__OFFER_HONESTY_DB__", "__OFFER_HONESTY_ENV__");
globalThis.__OFFER_HONESTY_ENV__ = {};

const offerState = await import("../lib/provider-offer-state.ts");
const offerCopy = await import("../lib/provider-offer-copy.ts");
const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const sittingRoute = await import("../app/api/sitting-lifecycle/route.ts");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const HOUR = 3_600_000, DAY = 24 * HOUR;
const SITTER = "sitter_ananya", SITTER_EMAIL = "sitter.offer@pawspace.test";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY");
  const db = makeD1(sqlite);
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users(id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'service_provider','active',?,?)").run(`U-${SITTER}`, SITTER_EMAIL, "Sitter", now, now);
  sqlite.prepare("INSERT INTO provider_identity_links(email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(SITTER_EMAIL, SITTER, now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT,breed TEXT,vaccination_status TEXT,source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  return { sqlite, db };
}
const windowAt = (startOffsetMs, hours = 1) => { const start = Math.floor((Date.now() + startOffsetMs) / 1000) * 1000; return { scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(start + hours * HOUR).toISOString() }; };
const setOffer = (sqlite, groupId, fields) => { const sets = Object.keys(fields).map((key) => `${key}=?`).join(","); sqlite.prepare(`UPDATE provider_assignment_offers SET ${sets} WHERE group_id=?`).run(...Object.values(fields), groupId); };
const providerGet = (db, path) => runWithWorkersDb(db, () => sittingRoute.GET(new Request(`https://ops.pawspace.example${path}`, { headers: { "oai-authenticated-user-email": SITTER_EMAIL } })));
const providerPost = (db, body) => runWithWorkersDb(db, () => sittingRoute.POST(new Request("https://ops.pawspace.example/api/sitting-lifecycle", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": SITTER_EMAIL }, body: JSON.stringify(body) })));

// ---------------------------------------------------------------------------------------------
test("the offer view reads an offer exactly as the accept path judges it", () => {
  const now = Date.now(), pending = (overrides = {}) => ({ provider_id: "sit_neha", status: "pending", offered_at: now - 40 * 60_000, expires_at: now - 10 * 60_000, ...overrides });
  const view = (offer, status = "confirmed", options) => offerState.providerOfferView(offer, { providerId: "sit_neha", phase: offerState.acceptancePhase(status, options), now });
  assert.deepEqual(view(pending()), { state: "expired", expiresAt: now - 10 * 60_000, offeredAt: now - 40 * 60_000 }, "pending past expires_at is what the lifecycle refuses with sitting_offer_expired");
  assert.equal(view(pending({ expires_at: now + 20 * 60_000 })).state, "open");
  assert.equal(view(pending({ provider_id: "sit_sana", expires_at: now + DAY })).state, "withdrawn", "an offer that moved to another sitter");
  assert.equal(view(pending({ status: "cancelled", expires_at: now + DAY })).state, "withdrawn");
  assert.equal(view(null).state, "open", "no offer row: nothing gates the accept");
  assert.equal(view(pending(), "assigned").state, "accepted");
  assert.equal(view(pending(), "reassignment_needed").state, "withdrawn", "Operations is recovering the booking");
  assert.equal(view(pending(), "payment_pending").state, "awaiting_payment");
  assert.equal(view(pending(), "confirmed", { boardingStay: true }).state, "accepted", "a Boarding stay's confirmed means the host accepted");
  assert.equal(view(pending({ expires_at: now + HOUR }), "awaiting_host_acceptance", { boardingStay: true }).state, "open");

  const bucket = (phase, state, end, extra = {}) => offerState.providerJobBucket({ phase, offerState: state, scheduledEnd: new Date(end).toISOString(), now, ...extra });
  assert.equal(bucket("awaiting", "open", now + DAY), "active");
  assert.equal(bucket("awaiting", "expired", now + DAY), "needs_operations");
  assert.equal(bucket("awaiting", "open", now - 44 * DAY), "past", "a 13 Aug job is not active on 26 Sep");
  assert.equal(bucket("accepted", "accepted", now - HOUR), "past");
  assert.equal(bucket("in_service", "accepted", now - HOUR), "active", "a partner mid-service must still be able to check out");
  assert.equal(bucket("closed", "closed", now - HOUR), "completed");
});

test("the words for each state never offer an Accept the lifecycle would refuse", () => {
  const deadline = Date.UTC(2026, 8, 26, 10, 15);
  const open = offerCopy.describeProviderOffer({ state: "open", expiresAt: deadline }, { noun: "booking" });
  assert.match(open.label, /Offer open · accept by 26 Sept?, 3:45 pm IST/);
  assert.equal(offerCopy.acceptAvailable({ state: "open", expiresAt: deadline }), true);
  const expired = offerCopy.describeProviderOffer({ state: "expired", expiresAt: deadline }, { noun: "booking" });
  assert.match(expired.label, /Offer expired · Operations arranging cover/);
  assert.match(expired.detail, /PawSpace Operations is arranging cover, so you do not need to do anything else/);
  for (const state of ["expired", "withdrawn", "accepted", "awaiting_payment", "closed", ""]) assert.equal(offerCopy.acceptAvailable({ state }), false, state);
  assert.equal(offerCopy.acceptAvailable({ state: "open" }, "past"), false, "a past job is never acceptable");
  assert.match(offerCopy.describeProviderOffer({ state: "open" }, { bucket: "past" }).label, /^Past$/);
});

// ---------------------------------------------------------------------------------------------
test("the sitter's own booking read carries the offer state, its expiry and the booked pets", async (t) => {
  const { sqlite, db } = await world(); t.after(() => sqlite.close());
  const seeded = await seedSittingBooking(db, sqlite, { bookingId: "SIT-OFFER", providerId: SITTER, groupId: "GRP-SIT-OFFER", reservationId: "RES-SIT-OFFER" });
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,created_at,updated_at) VALUES ('PET-BRUNO',?,'Bruno','dog','Indie',1,1),('PET-OTHER','SOMEONE-ELSE','Not yours','cat',NULL,1,1)").run(seeded.customerId);
  sqlite.prepare("UPDATE canonical_bookings SET pet_ids_json=? WHERE id='SIT-OFFER'").run(JSON.stringify(["PET-BRUNO", "PET-OTHER"]));
  sqlite.prepare("INSERT INTO sitting_care_plan_snapshots(booking_id,customer_id,plan_json,status,updated_by,updated_at) VALUES ('SIT-OFFER',?,?,'ready','customer',1)")
    .run(seeded.customerId, JSON.stringify({ feeding: "Kibble at 7", emergencyContact: "Asha 9000000002", vet: "Dr Rao", homeAccess: "Door code 4455" }));

  let response = await providerGet(db, "/api/sitting-lifecycle?bookingId=SIT-OFFER");
  assert.equal(response.status, 200, await response.clone().text());
  let row = (await response.json()).data[0];
  assert.equal(row.status, "confirmed");
  assert.equal(row.offer.state, "open");
  assert.ok(row.offer.expiresAt > Date.now(), "the workspace can show the accept-by time");
  assert.deepEqual(row.pets, [{ name: "Bruno", species: "dog", breed: "Indie" }], "only the booking customer's own pets, name/species/breed only");
  // SIT-02 is unchanged: before a paid, accepted booking the door code, emergency contact and vet stay back.
  assert.deepEqual(row.carePlan.withheldUntilAccepted, ["emergencyContact", "vet", "homeAccess"]);
  assert.ok(!JSON.stringify(row).includes("4455"));

  // The offer runs out: the read says so, and the accept path refuses in agreement with it.
  setOffer(sqlite, "GRP-SIT-OFFER", { expires_at: Date.now() - 60_000 });
  response = await providerGet(db, "/api/sitting-lifecycle?bookingId=SIT-OFFER");
  row = (await response.json()).data[0];
  assert.equal(row.status, "confirmed", "the booking status alone still reads confirmed");
  assert.equal(row.offer.state, "expired", "which is why the workspace must read the offer, not the status");
  const accept = await providerPost(db, { bookingId: "SIT-OFFER", action: "accept", idempotencyKey: "offer-honesty-late" });
  assert.equal(accept.status, 409);
  assert.equal((await accept.json()).code, "sitting_offer_expired");

  // Moved to another sitter.
  setOffer(sqlite, "GRP-SIT-OFFER", { provider_id: "sitter_neha", expires_at: Date.now() + DAY });
  row = (await (await providerGet(db, "/api/sitting-lifecycle?bookingId=SIT-OFFER")).json()).data[0];
  assert.equal(row.offer.state, "withdrawn");
});

// ---------------------------------------------------------------------------------------------
test("the partner feed files expired and past jobs apart and never counts them as active", async (t) => {
  const { sqlite, db } = await world(); t.after(() => sqlite.close());
  // Open offer, two days ahead: active work.
  await seedSittingBooking(db, sqlite, { bookingId: "SIT-OPEN", providerId: SITTER, groupId: "GRP-OPEN", reservationId: "RES-OPEN", window: windowAt(2 * DAY) });
  // Same, but the 30-minute offer already ran out: Operations' job now.
  await seedSittingBooking(db, sqlite, { bookingId: "SIT-EXPIRED", providerId: SITTER, groupId: "GRP-EXPIRED", reservationId: "RES-EXPIRED", window: windowAt(3 * DAY) });
  setOffer(sqlite, "GRP-EXPIRED", { expires_at: Date.now() - 5 * 60_000 });
  // A seeded 13 Aug booking still "confirmed" on 26 Sep, with no offer row at all.
  await seedSittingBooking(db, sqlite, { bookingId: "SIT-STALE", providerId: SITTER, groupId: "GRP-STALE", reservationId: "RES-STALE", window: windowAt(-44 * DAY) });
  sqlite.prepare("DELETE FROM provider_assignment_offers WHERE group_id='GRP-STALE'").run();
  // Accepted but its window ended without a check-in.
  await seedSittingBooking(db, sqlite, { bookingId: "SIT-MISSED", providerId: SITTER, groupId: "GRP-MISSED", reservationId: "RES-MISSED", status: "assigned", window: windowAt(-2 * DAY) });
  // Mid-service past the end: still the sitter's (they must check out).
  await seedSittingBooking(db, sqlite, { bookingId: "SIT-LIVE", providerId: SITTER, groupId: "GRP-LIVE", reservationId: "RES-LIVE", status: "in_progress", window: windowAt(-3 * HOUR, 2) });
  // A Pet Taxi trip with an open driver offer.
  seedCanonicalStayBooking(sqlite, { bookingId: "TAXI-OPEN", providerId: SITTER, serviceCode: "pet_taxi", groupId: "GRP-TAXI", reservationId: "RES-TAXI", ...windowAt(DAY) });
  sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES ('GRP-TAXI','TAXI-OPEN',?,'pending',?,?,1,?)").run(SITTER, Date.now(), Date.now() + 3 * 60_000, Date.now());

  const feed = await listProviderJobs(db, SITTER);
  const ids = (list) => list.map((job) => job.bookingId).sort();
  const active = [...feed.needsAction, ...feed.today, ...feed.upcoming];
  assert.deepEqual(ids(active), ["SIT-LIVE", "SIT-OPEN", "TAXI-OPEN"], "only work the partner can still do is active");
  assert.deepEqual(ids(feed.needsOperations), ["SIT-EXPIRED"]);
  assert.deepEqual(ids(feed.past), ["SIT-MISSED", "SIT-STALE"]);
  const byId = Object.fromEntries([...active, ...feed.needsOperations, ...feed.past].map((job) => [job.bookingId, job]));
  assert.equal(byId["SIT-OPEN"].offer.state, "open"); assert.ok(byId["SIT-OPEN"].offer.expiresAt > Date.now());
  assert.equal(byId["SIT-EXPIRED"].offer.state, "expired"); assert.equal(byId["SIT-EXPIRED"].group, "needs_operations");
  assert.equal(byId["SIT-STALE"].group, "past");
  assert.equal(byId["SIT-LIVE"].offer.state, "accepted");
  assert.equal(byId["TAXI-OPEN"].offer.state, "open");
});

test("a Boarding request whose host offer expired leaves the host's Needs action list", async (t) => {
  const { sqlite, db } = await world(); t.after(() => sqlite.close());
  const stay = await seedBoardingStay(db, sqlite, { bookingId: "BOARD-EXPIRED", providerId: "host_maya_rohan" });
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,1,?)").run(stay.groupId, stay.bookingId, "host_maya_rohan", Date.now() - HOUR, Date.now() - 30 * 60_000, Date.now());
  const status = String(sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(stay.stayId).status);
  assert.equal(status, "awaiting_host_acceptance", "precondition: the stay still says it waits on the host");
  const feed = await listProviderJobs(db, "host_maya_rohan");
  assert.deepEqual(feed.needsAction.map((job) => job.bookingId), [], "no Accept prompt for an offer the lifecycle refuses");
  assert.deepEqual(feed.needsOperations.map((job) => job.bookingId), ["BOARD-EXPIRED"]);
  assert.equal(feed.needsOperations[0].offer.state, "expired");
});

// ---------------------------------------------------------------------------------------------
test("the Sitting workspace renders Accept only for an open offer and shows what a sitter needs", () => {
  const page = read("app/sitter/sitting-workspace.tsx");
  assert.doesNotMatch(page, /disabled=\{busy\|\|!\["confirmed","awaiting_provider_acceptance","reassignment_offered"\]\.includes\(status\)\}/, "the old Accept rendered for every confirmed booking");
  assert.match(page, /const canAccept=AWAITING\.includes\(status\)&&acceptAvailable\(offer,bucket\)/);
  assert.match(page, /\{canAccept&&<button disabled=\{busy\} onClick=\{\(\)=>void act\("accept"\)\}>/);
  assert.match(page, /role="status" aria-label="Offer status"/, "open with expiry / expired / accepted is stated on screen");
  assert.match(page, /aria-label="Pets in this booking"/);
  assert.match(page, /Care starts:/); assert.match(page, /Care ends:/);
  assert.match(page, /Withheld until the booking is paid and you have accepted it/, "the SIT-02 withheld fields are explained");
  assert.match(page, /Open navigation to this address/, "after acceptance: navigation to the released address");
  assert.match(page, /Check in with my location/);
  assert.match(page, /The exact service address, navigation and GPS check-in become available after you accept the booking/);
});

test("the Driver and Host workspaces gate Accept on the offer too", () => {
  const driver = read("app/driver/canonical-driver-page.tsx");
  assert.doesNotMatch(driver, /<button disabled=\{!!busy\|\|bookingStatus!=="confirmed"\} onClick=\{\(\)=>void act\("accept"\)\}>/);
  assert.match(driver, /\{canAccept&&<button disabled=\{!!busy\} onClick=\{\(\)=>void act\("accept"\)\}>Accept trip<\/button>\}/);
  assert.match(driver, /aria-label="Offer status"/);
  const host = read("app/host/page.tsx");
  assert.match(host, /\{selectedCanAccept\?<div className=\{styles\.actions\}>/);
  assert.match(host, /requestBucket\(item\)==="active"/, "only an open, still-ahead offer is a pending host request");
  assert.match(host, /<h3>Needs Operations<\/h3>/);
  assert.match(host, /<h3>Past<\/h3>/);
  // A replacement host (recovery_pending) can accept, as the lifecycle allows, on /partner/jobs too.
  const jobs = read("app/partner/jobs/page.tsx");
  assert.match(jobs, /job\.serviceCode==="boarding"&&\["awaiting_host_acceptance","recovery_pending"\]\.includes\(job\.status\)&&job\.stayId&&acceptAvailable/);
});

test("the Partner app counts only active work and gives non-grooming partners Jobs and GPS that lead somewhere", () => {
  const page = read("app/partner-app/page.tsx");
  assert.match(page, /setOtherJobs\(others\(\[\.\.\.feed\.needsAction,\.\.\.feed\.today,\.\.\.feed\.upcoming\]\)\)/, "active other-service jobs exclude Needs Operations and Past");
  assert.match(page, /<span>\{activeJobs\.length\+otherJobs\.length\}<\/span><small>active jobs<\/small>/);
  assert.doesNotMatch(page, /otherJobs\.filter\(job=>!\["completed","cancelled"\]\.includes\(job\.status\)\)\.length/, "the old count treated every non-completed job as active");
  assert.match(page, /aria-label="Needs Operations"/);
  assert.match(page, /Past \(\{otherPast\.length\}\) · not active/);
  assert.match(page, /\{tab === "jobs" && otherJobSections\}/, "the Jobs tab lists Sitting, Boarding and Taxi jobs");
  assert.match(page, /aria-label="GPS for Sitting, Boarding and Taxi jobs"/, "the GPS tab routes to the job's own workspace");
  assert.match(page, /aria-label="Open GPS and navigation" onClick=\{\(\) => setTab\("tracking"\)\}/, "the GPS tile opens GPS");
  assert.match(page, /if \(state === "open"\) return "Review & accept";/);
  // A 30-second refresh must not blank known work: the lists clear only when the partner changes.
  assert.match(page, /useEffect\(\(\)=>\{queueMicrotask\(\(\)=>\{setOtherJobs\(\[\]\);setOtherCompleted\(\[\]\);setOtherOps\(\[\]\);setOtherPast\(\[\]\);setFeedError\(""\);\}\);\},\[identity\?\.subjectId\]\);/);
  assert.doesNotMatch(page, /if\(!controller\.signal\.aborted\)\{setOtherJobs\(\[\]\)/, "the refresh effect no longer clears the lists");
  assert.doesNotMatch(page, /other verticals sign in but see their jobs elsewhere/);
  const route = read("app/api/partner-job-feed/route.ts");
  assert.match(route, /active:feed\.needsAction\.length\+feed\.today\.length\+feed\.upcoming\.length,needsOperations:feed\.needsOperations\.length,past:feed\.past\.length/);
});

// ---------------------------------------------------------------------------------------------
test("staging data: seeded sitters and hosts get a 24-hour acceptance window, and only they do", () => {
  const sql = read("scripts/uat-staging-provider-capacity.sql");
  const start = sql.indexOf("-- 6. UAT ACCEPTANCE WINDOW");
  assert.ok(start > 0, "the staging repair section exists");
  const statements = sql.slice(start).split(";\n").map((item) => item.trim()).filter(Boolean);
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,services_json TEXT NOT NULL,acceptance_timeout_minutes INTEGER NOT NULL,updated_by TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  const profile = sqlite.prepare("INSERT INTO provider_capacity_profiles (id,services_json,acceptance_timeout_minutes,updated_by,updated_at) VALUES (?,?,?,?,0)");
  profile.run("sit_neha", '["pet_sitting"]', 30, "founder_seed");
  profile.run("host_sana", '["boarding"]', 30, "founder_seed");
  profile.run("uatcap_sit_cm", '["pet_sitting"]', 60, "founder_seed");
  profile.run("uatcap_host_cm", '["boarding"]', 60, "founder_seed");
  profile.run("uatcap_sit_east_2", '["pet_sitting"]', 60, "founder_seed");
  profile.run("sit_ops_owned", '["pet_sitting"]', 45, "ops.manager@pawspace.in");
  profile.run("host_longer", '["boarding"]', 2880, "founder_seed");
  profile.run("uatcap_groom_ft", '["grooming"]', 3, "founder_seed");
  profile.run("taxi_rahul", '["pet_taxi"]', 3, "founder_seed");
  profile.run("uatcap_taxi_ft", '["pet_taxi"]', 3, "founder_seed");
  const now = Date.now(), minutes = (value) => value * 60_000;
  sqlite.exec("CREATE TABLE provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  const offer = sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,provider_id,status,offered_at,expires_at,updated_at) VALUES (?,?,?,?,?,0)");
  offer.run("G-RECENT", "sit_neha", "pending", now - minutes(90), now - minutes(60));
  offer.run("G-OLD", "sit_sana", "pending", now - 3 * DAY, now - 3 * DAY + minutes(30));
  offer.run("G-HOST", "uatcap_host_cm", "pending", now - minutes(10), now + minutes(50));
  offer.run("G-DONE", "sit_asha", "accepted", now - minutes(90), now - minutes(60));
  offer.run("G-TAXI", "taxi_rahul", "pending", now - minutes(10), now - minutes(7));
  const run = () => { for (const statement of statements) sqlite.exec(`${statement};`); };
  run();
  const window = (id) => sqlite.prepare("SELECT acceptance_timeout_minutes m FROM provider_capacity_profiles WHERE id=?").get(id).m;
  for (const id of ["sit_neha", "host_sana", "uatcap_sit_cm", "uatcap_host_cm", "uatcap_sit_east_2"]) assert.equal(window(id), 1440, id);
  assert.equal(window("sit_ops_owned"), 45, "a window a person set is never overruled by a seed");
  assert.equal(window("host_longer"), 2880, "the repair only ever raises");
  for (const id of ["uatcap_groom_ft", "taxi_rahul", "uatcap_taxi_ft"]) assert.equal(window(id), 3, `${id}: live-dispatch windows are not touched`);
  const expires = (group) => sqlite.prepare("SELECT expires_at e FROM provider_assignment_offers WHERE group_id=?").get(group).e;
  assert.equal(expires("G-RECENT"), now - minutes(90) + DAY, "an offer made 90 minutes ago is open again, for 24 hours from when it was offered");
  assert.ok(expires("G-OLD") < now, "an offer older than a day stays expired");
  assert.equal(expires("G-HOST"), now - minutes(10) + DAY);
  assert.equal(expires("G-DONE"), now - minutes(60), "accepted offers are untouched");
  assert.equal(expires("G-TAXI"), now - minutes(7), "driver offers are untouched");
  const before = JSON.stringify(sqlite.prepare("SELECT * FROM provider_capacity_profiles ORDER BY id").all()) + JSON.stringify(sqlite.prepare("SELECT * FROM provider_assignment_offers ORDER BY group_id").all());
  run();
  const after = JSON.stringify(sqlite.prepare("SELECT * FROM provider_capacity_profiles ORDER BY id").all()) + JSON.stringify(sqlite.prepare("SELECT * FROM provider_assignment_offers ORDER BY group_id").all());
  assert.equal(after, before, "idempotent: a second run changes nothing");
  sqlite.close();
  // The product rule stays in code: the runtime roster keeps the 30-minute advance-booking window.
  assert.match(read("lib/provider-capacity-governance.ts"), /\{id:"sit_neha",[^}]*acceptanceTimeoutMinutes:30\}/);
});
