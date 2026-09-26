/**
 * Boarding host search and Pet Sitting sitter search on STAGING (owner: "during booking, host / sitter / driver
 * not available shouldn't come"). At staging's ~250 ms per D1 call the host search took 7-15 s with 4 hosts and
 * 22-65 s with 7+ hosts per zone, and a sitter preview took 5-36 s, often hitting the 20 s deadline; the screen
 * then read "No sitter is available".
 *
 * Like tests/scheduling-preview-latency.test.mjs (PR #1105), these EXECUTE the real routes behind the real
 * gateway modules against node:sqlite loaded with scripts/uat-staging-provider-capacity.sql, with every D1 call
 * counted and, for the timing cases, delayed. They pin: a bounded number of D1 calls that does not grow with the
 * hosts or sitters in a zone; no writes; the answer inside 20 round trips (5 s at 250 ms); and the SAME hosts and
 * sitters, in the same order, as before the change. The page cases pin "still checking" instead of "none
 * available", one search per settled Plan step, and plain sentences instead of JSON parse errors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import * as h from "./helpers/stay-taxi-latency-harness.mjs";

installWorkersHooks("__STAY_SEARCH_DB__", "__STAY_SEARCH_ENV__");
h.stubGeocoding();
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const boarding = await import("../app/api/boarding-commercial/route.ts");
const { discoverBoardingHosts } = await import("../lib/boarding-host-discovery.ts");
const { hostMeetsRequirements, requireBoardingRequirements } = await import("../lib/stay-host-requirements.ts");
const client = await import("../lib/uat-scheduling-client.ts");
const boardingClient = await import("../lib/boarding-commercial-client.ts");
const sittingClient = await import("../lib/sitting-commercial-client.ts");
const sittingBookingClient = await import("../lib/sitting-booking-client.ts");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const world = (extra = 0) => h.stayWorld({ dbGlobal: "__STAY_SEARCH_DB__", envGlobal: "__STAY_SEARCH_ENV__", extra });
const STAY = () => ({ scheduledStart: h.ist(3, 10), scheduledEnd: h.ist(3, 14) });
const search = (w, query = {}) => h.timed(w, h.boardingSearchRequest(w, { ...STAY(), petCount: 1, species: ["dog"], ...query }), boarding.GET);
const preview = (w, label, scheduledStart, scheduledEnd, careMode) => h.timed(w, h.schedulingRequest(w, { action: "preview", clientRequestId: `preview:${label}`, petIds: [h.PETS.dog], serviceCode: "pet_sitting", careMode, scheduledStart, scheduledEnd }), scheduling.POST);
/** Cold isolate, first warm request, then steady state - the one that is measured. */
async function steady(w, run) { await run(); await run(); return run(); }
/** 20 round trips is 5 s at staging's ~250 ms per D1 call. */
const ROUND_TRIPS = 20, LATENCY_MS = 40;

test("a warm Boarding host search makes a few D1 calls, writes nothing, and does not grow with the hosts in the zone", async () => {
  const small = await world(), crowded = await world(30);
  const a = await steady(small, () => search(small)), b = await steady(crowded, () => search(crowded));
  for (const [label, result] of [["staging roster", a], ["30 more hosts", b]]) {
    assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
    assert.ok(result.calls.length <= 10, `${label}: ${result.calls.length} D1 calls (limit 10)\n${result.calls.map((call) => call.sql.slice(0, 100)).join("\n")}`);
    assert.deepEqual(result.writes.map((call) => call.sql.slice(0, 80)), [], `${label}: a host search is read-only once the isolate is warm`);
  }
  assert.equal(b.calls.length, a.calls.length, "thirty more hosts must not add D1 calls");
  assert.ok(b.body.data.hosts.length > a.body.data.hosts.length, "and they are all searched");
});

test("a warm Boarding host search answers inside 20 D1 round trips (5 s at 250 ms per call)", async () => {
  const w = await world(30);
  await search(w); await search(w);
  w.latency.ms = LATENCY_MS;
  const result = await search(w);
  w.latency.ms = 0;
  assert.equal(result.status, 200);
  assert.ok(result.elapsedMs < ROUND_TRIPS * LATENCY_MS, `took ${Math.round(result.elapsedMs)} ms at ${LATENCY_MS} ms per call (${result.calls.length} calls)`);
});

/** The per-host search exactly as it was before this change (frozen here), for the equivalence cases. */
async function legacyDiscover(db, input) {
  const parse = (value, fallback) => { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } };
  const overlaps = (start, end, row) => String(row.scheduled_start ?? row.starts_at) < end && String(row.scheduled_end ?? row.ends_at) > start;
  const bookedDate = String(input.scheduledStart).slice(0, 10);
  input = { ...input, scheduledStart: new Date(input.scheduledStart).toISOString(), scheduledEnd: new Date(input.scheduledEnd).toISOString() };
  const requirements = requireBoardingRequirements(input.requirements), petCount = Number(input.petCount);
  const requestedSpecies = [...new Set(input.species.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const candidates = await db.prepare("SELECT h.provider_id,h.area,h.species_json,h.max_guest_pets,h.one_family_only,h.medication_support,h.resident_pets,h.home_verified,h.kyc_status,h.background_check_status,h.version,p.name,p.provider_model,p.rating,p.quality_score,p.capacity,p.status,p.live,p.services_json,p.zones_json,p.effective_from,p.effective_to FROM boarding_host_profiles h JOIN provider_capacity_profiles p ON p.id=h.provider_id WHERE h.city_id=? AND h.zone_id=? AND h.active=1 AND p.live=1 AND p.status='active'").bind(input.cityId, input.zoneId).all();
  const result = [];
  for (const row of candidates.results) {
    if (!hostMeetsRequirements({ medicationSupport: Number(row.medication_support) === 1, residentPets: String(row.resident_pets || ""), oneFamilyOnly: Number(row.one_family_only) === 1 }, requirements)) continue;
    if (bookedDate < String(row.effective_from || "0000-00-00") || (row.effective_to && bookedDate > String(row.effective_to))) continue;
    if (Number(row.home_verified) !== 1 || String(row.kyc_status) !== "verified" || String(row.background_check_status) !== "verified") continue;
    const services = parse(row.services_json, []), zones = parse(row.zones_json, []), supported = parse(row.species_json, []).map((value) => value.toLowerCase());
    if (!services.includes("boarding") || !zones.includes(input.zoneId) || requestedSpecies.some((species) => !supported.includes(species))) continue;
    const maxCapacity = Math.max(0, Math.min(Number(row.max_guest_pets || 0), Number(row.capacity || row.max_guest_pets || 0))); if (maxCapacity < petCount) continue;
    const blocked = await db.prepare("SELECT id,starts_at,ends_at FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1").bind(row.provider_id, input.scheduledEnd, input.scheduledStart).first(); if (blocked) continue;
    const bookingTable = await db.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first();
    const locks = bookingTable
      ? await db.prepare("SELECT l.booking_id,l.capacity_units,l.starts_at,l.ends_at,b.schedule_group_id FROM boarding_capacity_locks l LEFT JOIN canonical_bookings b ON b.id=l.booking_id WHERE l.provider_id=? AND l.status='active' AND l.starts_at<? AND l.ends_at>?").bind(row.provider_id, input.scheduledEnd, input.scheduledStart).all()
      : await db.prepare("SELECT booking_id,capacity_units,starts_at,ends_at,NULL schedule_group_id FROM boarding_capacity_locks WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>?").bind(row.provider_id, input.scheduledEnd, input.scheduledStart).all();
    let reservations = []; const schedulingTable = await db.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='scheduling_reservations'").first();
    if (schedulingTable) { const scheduled = await db.prepare("SELECT group_id,capacity_units,scheduled_start,scheduled_end FROM scheduling_reservations WHERE provider_id=? AND service_code='boarding' AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?").bind(row.provider_id, input.scheduledEnd, input.scheduledStart).all(); reservations = scheduled.results.filter((item) => overlaps(input.scheduledStart, input.scheduledEnd, item)).map((item) => ({ group_id: String(item.group_id), capacity_units: Number(item.capacity_units || 0) })); }
    const lockedGroups = new Set(locks.results.map((item) => String(item.schedule_group_id || "")).filter(Boolean)), lockedUnits = locks.results.reduce((sum, item) => sum + Number(item.capacity_units || 0), 0), pending = reservations.filter((item) => !lockedGroups.has(item.group_id)), used = lockedUnits + pending.reduce((sum, item) => sum + item.capacity_units, 0), commitments = locks.results.length + pending.length, available = Math.max(0, maxCapacity - used);
    if (Number(row.one_family_only) === 1 && commitments > 0) continue; if (available < petCount) continue;
    result.push({ providerId: String(row.provider_id), name: String(row.name), capacity: maxCapacity, availableGuestPets: available, commitments, qualityScore: Number(row.quality_score || 0), rating: Number(row.rating || 0), species: supported });
  }
  return result.sort((a, b) => b.qualityScore - a.qualityScore || b.rating - a.rating || a.name.localeCompare(b.name));
}
const summary = (hosts) => hosts.map((host) => ({ providerId: host.providerId, name: host.name, capacity: host.capacity, availableGuestPets: host.availableGuestPets, commitments: host.commitments, qualityScore: host.qualityScore, rating: host.rating, species: host.species }));

test("the set-based host search returns exactly what the per-host search returned: leave, locks, pending stays, one family, species, needs", async () => {
  const w = await world(6);
  const { sqlite, db } = w, s = STAY();
  await search(w); // runtime set-up
  const hostId = (index) => `extra_host_${index}`;
  // Leave overlapping the stay, and leave that ends exactly at check-in (not overlapping).
  sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'leave','active','test',1,1)").run("LEAVE-1", hostId(0), s.scheduledStart, s.scheduledEnd);
  sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'leave','active','test',1,1)").run("LEAVE-2", hostId(1), new Date(Date.parse(s.scheduledStart) - 3_600_000).toISOString(), s.scheduledStart);
  // A capacity lock whose booking links to a pending reservation of the same group (counted once), a lock with no booking, and a pending stay.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT NOT NULL,schedule_group_id TEXT,service_code TEXT NOT NULL,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,schedule_group_id,service_code,status,created_at,updated_at) VALUES ('BK-LOCK','k1','C1','GRP-LOCK','boarding','confirmed',1,1)").run();
  const lock = sqlite.prepare("INSERT INTO boarding_capacity_locks (stay_id,booking_id,provider_id,starts_at,ends_at,capacity_units,family_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',1,1)");
  lock.run("STAY-1", "BK-LOCK", hostId(2), s.scheduledStart, s.scheduledEnd, 3, "fam-1");
  lock.run("STAY-2", "BK-NONE", hostId(3), s.scheduledStart, s.scheduledEnd, 8, "fam-2");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)");
  const reservation = sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,status,created_at) VALUES (?,?,?,?,'blr','blr-east','C1','[]',?,?,?,?,1)");
  reservation.run("R-LOCKED", "GRP-LOCK", hostId(2), "boarding", s.scheduledStart, s.scheduledEnd, 3, "assigned");
  reservation.run("R-PENDING", "GRP-PENDING", hostId(4), "boarding", s.scheduledStart, s.scheduledEnd, 6, "assigned");
  reservation.run("R-CANCELLED", "GRP-CANCELLED", hostId(5), "boarding", s.scheduledStart, s.scheduledEnd, 8, "cancelled");
  reservation.run("R-SITTING", "GRP-SIT", hostId(5), "pet_sitting", s.scheduledStart, s.scheduledEnd, 8, "assigned");
  reservation.run("R-ONE-FAMILY", "GRP-FAMILY", "host_sana", "boarding", s.scheduledStart, s.scheduledEnd, 1, "assigned");
  // Needs and verification.
  sqlite.prepare("UPDATE boarding_host_profiles SET medication_support=0 WHERE provider_id=?").run(hostId(1));
  sqlite.prepare("UPDATE boarding_host_profiles SET resident_pets='two cats' WHERE provider_id=?").run(hostId(3));
  sqlite.prepare("UPDATE boarding_host_profiles SET kyc_status='pending' WHERE provider_id='host_arjun_tara'").run();
  let compared = 0;
  for (const species of [["dog"], ["cat"], ["dog", "cat"]]) for (const petCount of [1, 2, 3, 4]) for (const requirements of [{}, { medicationRequired: true }, { noResidentPets: true }, { oneFamilyOnly: true }]) {
    const input = { cityId: "blr", zoneId: "blr-east", ...s, petCount, species, requirements };
    assert.deepEqual(summary(await discoverBoardingHosts(db, input)), summary(await legacyDiscover(db, input)), JSON.stringify({ species, petCount, requirements }));
    compared++;
  }
  const hosts = summary(await discoverBoardingHosts(db, { cityId: "blr", zoneId: "blr-east", ...s, petCount: 1, species: ["dog"] }));
  assert.ok(!hosts.some((host) => host.providerId === hostId(0)), "a host on leave is not offered");
  assert.ok(hosts.some((host) => host.providerId === hostId(1)), "leave that ends at check-in does not block");
  assert.deepEqual(hosts.find((host) => host.providerId === hostId(2)).availableGuestPets, 5, "a locked stay and its reservation count once");
  assert.ok(!hosts.some((host) => host.providerId === hostId(3)), "a lock with no booking still fills the home");
  assert.equal(hosts.find((host) => host.providerId === hostId(4)).availableGuestPets, 2, "a pending stay counts");
  assert.equal(hosts.find((host) => host.providerId === hostId(5)).availableGuestPets, 8, "cancelled stays and other services do not count");
  assert.ok(!hosts.some((host) => host.providerId === "host_sana"), "a one-family home with a family in residence is not offered");
  assert.ok(compared >= 48);
});

// The sitters customers were shown before this change, captured on the same roster in the same order.
const SITTERS_BEFORE = {
  "visit 11": ["sit_sana", "uatcap_sit_cm", "sit_neha"],
  "visit 19": ["uatcap_sit_cm"],
  overnight: ["sit_sana", "sit_neha", "uatcap_sit_cm"],
  "visit 8am": ["uatcap_sit_cm"],
};
const SITTER_WINDOWS = () => ({ "visit 11": [h.ist(4, 11), h.ist(4, 12), "visit"], "visit 19": [h.ist(4, 19), h.ist(4, 20), "visit"], overnight: [h.ist(4, 20), h.ist(5, 8), "overnight"], "visit 8am": [h.ist(4, 8), h.ist(4, 9), "visit"] });

test("a Pet Sitting preview offers the same sitters in the same order as before, and writes nothing", async () => {
  const w = await world();
  for (const [label, [start, end, care]] of Object.entries(SITTER_WINDOWS())) {
    const result = await preview(w, label, start, end, care);
    assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(result.body.data.providers.map((provider) => provider.id), SITTERS_BEFORE[label], label);
    assert.equal(result.body.data.reserved, false);
  }
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE source='uat_roster'").get().n, 0, "the synthetic UAT roster is served from memory, not written by a preview");
  const warm = await preview(w, "visit 11", ...SITTER_WINDOWS()["visit 11"]);
  assert.deepEqual(warm.writes.map((call) => call.sql.slice(0, 80)), [], "a warm sitter search is read-only");
});

test("a warm Pet Sitting preview makes a bounded number of D1 calls that does not grow with the sitters in the zone", async () => {
  const [start, end, care] = SITTER_WINDOWS()["visit 11"];
  const small = await world(), crowded = await world(30);
  const a = await steady(small, () => preview(small, "visit 11", start, end, care)), b = await steady(crowded, () => preview(crowded, "visit 11", start, end, care));
  for (const [label, result] of [["staging roster", a], ["30 more sitters", b]]) {
    assert.equal(result.status, 200, label);
    assert.ok(result.calls.length <= 25, `${label}: ${result.calls.length} D1 calls (limit 25)\n${result.calls.map((call) => call.sql.slice(0, 100)).join("\n")}`);
  }
  assert.equal(b.calls.length, a.calls.length, "thirty more sitters must not add D1 calls");
  const header = a.response.headers.get("server-timing") ?? "";
  assert.match(header, /d1;dur=[\d.]+;desc="n=\d+ seq=\d+/, "the preview still reports where its time went");
});

test("a warm Pet Sitting preview answers inside 20 D1 round trips (5 s at 250 ms per call)", async () => {
  const [start, end, care] = SITTER_WINDOWS().overnight;
  const w = await world(30);
  await preview(w, "o", start, end, care); await preview(w, "o", start, end, care);
  w.latency.ms = LATENCY_MS;
  const result = await preview(w, "o", start, end, care);
  w.latency.ms = 0;
  assert.equal(result.status, 200);
  assert.ok(result.elapsedMs < ROUND_TRIPS * LATENCY_MS, `took ${Math.round(result.elapsedMs)} ms at ${LATENCY_MS} ms per call (${result.calls.length} calls)`);
});

test("the in-memory sitter roster is exactly what the reserve path's roster write publishes", async () => {
  const w = await world();
  const [start, end, care] = SITTER_WINDOWS()["visit 11"];
  await preview(w, "seed-check", start, end, care);
  // sit_asha (runtime default, no authored availability) raised to the top: only the synthetic 09:00-19:00 row decides.
  w.sqlite.prepare("UPDATE provider_capacity_profiles SET quality_score=200 WHERE id='sit_asha'").run();
  assert.equal((await preview(w, "a", start, end, care)).body.data.providers[0].id, "sit_asha", "offered from the in-memory roster");
  const day = new Date(Date.parse(start) + 330 * 60_000).toISOString().slice(0, 10);
  // Authored availability wins, as before.
  w.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES ('ops-asha','sit_asha','blr','blr-east',?,'[\"06:00-07:00\"]','operations',1)").run(day);
  assert.ok(!(await preview(w, "b", start, end, care)).body.data.providers.some((provider) => provider.id === "sit_asha"), "an authored row is the answer for that date");
  w.sqlite.prepare("DELETE FROM scheduling_availability WHERE id='ops-asha'").run();
  // INSERT OR IGNORE semantics: a row the reserve path already seeded keeps its place.
  w.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,'[\"17:00-19:00\"]','uat_roster',1)").run(`uat_sit_asha_${day}_blr-east`, "sit_asha", "blr", "blr-east", day);
  assert.ok(!(await preview(w, "c", start, end, care)).body.data.providers.some((provider) => provider.id === "sit_asha"), "an already-seeded row is not replaced");
});

// --- The page and its clients -----------------------------------------------------------------------------

async function withFetch(respond, run) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (...args) => respond(...args);
  try { return await run(); } finally { globalThis.fetch = saved; }
}
const request = { clientRequestId: "c1", customerId: "C1", petIds: ["P1"], serviceCode: "pet_sitting", cityId: "blr", zoneId: "blr-east", scheduledStart: "2026-10-01T05:30:00.000Z", scheduledEnd: "2026-10-01T06:30:00.000Z" };
const rejection = (promise) => promise.then(() => assert.fail("expected a refusal"), (error) => error);

test("a sitter search that did not finish is 'still checking', never 'no sitter available', and never a JSON error", async () => {
  const deadline = await withFetch(() => Response.json({ error: "Checking availability is taking longer than usual. Please try again in a moment.", code: "SCHEDULING_PREVIEW_TIMEOUT", retryAfterSeconds: 5 }, { status: 503, headers: { "retry-after": "5" } }), () => rejection(client.previewSitters(request)));
  assert.ok(client.isAvailabilityPending(deadline), "the server's deadline answer is not an answer");
  assert.equal(deadline.retryAfterSeconds, 5);
  for (const [status, body] of [[502, "<html>Bad gateway</html>"], [504, ""], [503, "upstream request timeout"]]) {
    const error = await withFetch(() => new Response(body, { status }), () => rejection(client.previewSitters(request)));
    assert.ok(client.isAvailabilityPending(error), `${status} is still checking`);
    assert.match(error.message, /still checking/i);
    assert.doesNotMatch(error.message, /JSON|Unexpected|token/i);
  }
  const empty = await withFetch(() => Response.json({ data: { providers: [], availabilityChecked: true, reserved: false } }), () => client.previewSitters(request));
  assert.deepEqual(empty.providers, [], "a finished search that found nobody is still reported as such");
  const flow = read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /setSitterError\(isAvailabilityPending\(problem\)\?SITTER_STILL_CHECKING:/, "the page says it is still checking");
  assert.match(flow, /const SITTER_STILL_CHECKING = "Still checking sitter availability/);
  assert.match(flow, /\{sitterError\|\|"No sitter is available for this care window\. Try different dates\."\}/, "'no sitter' is shown only when the search finished without an error");
  assert.match(flow, /Retry sitter search/);
});

test("the Plan step starts one search per settled change and cancels a search a newer one replaced", async () => {
  const flow = read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /const STAY_SEARCH_SETTLE_MS = 700;/);
  assert.match(flow, /const settle=window\.setTimeout\(\(\)=>void previewSittersPatiently\(/);
  assert.match(flow, /return\(\)=>\{active=false;window\.clearTimeout\(settle\);controller\.abort\(\);\};/);
  assert.match(flow, /const settle=window\.setTimeout\(\(\)=>void loadBoardingCommercial\(\{cityId:serviceLocation\.assignment\.cityId,zoneId:serviceLocation\.assignment\.zoneId,scheduledStart:/);
  assert.match(flow, /\{signal:controller\.signal\}\)\.then\(data=>\{if\(!active\)return;const hosts=/);
  // The abort really reaches the request.
  const seen = [];
  const controller = new AbortController();
  const pending = withFetch((_url, init) => new Promise((_resolve, reject) => { seen.push(init.signal); init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }),
    () => rejection(client.previewSitters(request, { signal: controller.signal })));
  controller.abort();
  await pending;
  assert.equal(seen[0].aborted, true, "a replaced sitter search is cancelled at the network");
  const hostController = new AbortController(), hostSeen = [];
  const hosts = withFetch((_url, init) => new Promise((_resolve, reject) => { hostSeen.push(init.signal); init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }),
    () => rejection(boardingClient.loadBoardingCommercial({ cityId: "blr", zoneId: "blr-east" }, { signal: hostController.signal })));
  hostController.abort();
  await hosts;
  assert.equal(hostSeen[0].aborted, true, "a replaced host search is cancelled at the network");
});

test("the review screen's reserve, quote and booking clients show a plain retry sentence instead of a JSON parse error", async () => {
  const unreadable = [[502, "<html>upstream request timeout</html>"], [504, ""], [503, "upstream request timeout"], [200, "not json"]];
  for (const [status, body] of unreadable) {
    const respond = () => new Response(body, { status });
    const reserve = await withFetch(respond, () => rejection(client.reserveUatSchedule(request)));
    const sittingQuote = await withFetch(respond, () => rejection(sittingClient.createSittingQuote({ packageCode: "sitting-visit-60", petCount: 1, cityId: "blr", zoneId: "blr-east", scheduledStart: request.scheduledStart, scheduledEnd: request.scheduledEnd })));
    const sittingBooking = await withFetch(respond, () => rejection(sittingBookingClient.createCanonicalSittingBooking({ groupId: "g" })));
    const boardingQuote = await withFetch(respond, () => rejection(boardingClient.quoteBoarding({ packageCode: "boarding-4h", petCount: 1, cityId: "blr", zoneId: "blr-east", scheduledStart: request.scheduledStart, scheduledEnd: request.scheduledEnd, paymentMode: "prepaid" })));
    for (const [label, error] of [["reserve", reserve], ["sitting quote", sittingQuote], ["sitting booking", sittingBooking], ["boarding quote", boardingQuote]]) {
      assert.doesNotMatch(error.message, /JSON|Unexpected|token|SyntaxError/i, `${label} ${status}: ${error.message}`);
      assert.match(error.message, /try again/i, `${label} ${status} offers a retry: ${error.message}`);
    }
    assert.ok(!client.isProviderSlotRefusal(reserve), "an unreadable answer is not 'this slot is taken'");
  }
  // A readable refusal still gives the server's reason.
  const refused = await withFetch(() => Response.json({ error: "SCHEDULING_BUSY", message: "busy" }, { status: 503 }), () => rejection(client.reserveUatSchedule(request)));
  assert.match(refused.message, /busy for a moment\. Please try again/);
  const hostTimeout = await withFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), async () => {
    const savedTimeout = globalThis.setTimeout; globalThis.setTimeout = (callback) => savedTimeout(callback, 1);
    try { return await rejection(boardingClient.loadBoardingCommercial({ cityId: "blr", zoneId: "blr-east" })); } finally { globalThis.setTimeout = savedTimeout; }
  });
  assert.match(hostTimeout.message, /^Still checking host availability/, "a host search that runs out of time is still checking, not 'no host available'");
});
