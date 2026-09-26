/*
 * Staging testers must always find a trainer. [owner request 2026-09-26: "during testing no trainer
 * availability shouldn't come, keep this open"]
 *
 * A tester on staging /v2/training (East Bengaluru, Basic Obedience, 8 sessions from 12 Oct 2026 10:00 IST
 * every 4 days) was told "No available trainer has been confirmed in East Bengaluru for this programme".
 * Appointment scheduling excludes a provider for the WHOLE programme when any one session sits inside the
 * travel buffer of an existing booking, provider.capacity is ignored for appointments, and staging's few
 * UAT trainers keep every tester's bookings - so a long programme soon clashes with all of them.
 *
 * The fix has three parts, each executed here:
 *   1. backend/src/scheduling.ts parallelAppointments: capacity bounds overlapping appointments, an exact
 *      duplicate window is still refused, and with the flag off (or capacity 1) nothing changes.
 *   2. app/api/uat-scheduling sets it for Training only on a DECLARED UAT runtime
 *      (PAWSPACE_SCHEDULING_ENV=uat). Preview, reserve, the commit guard and the Ops restore agree.
 *   3. scripts/uat-staging-provider-capacity.sql gives the city-wide UAT team trainer capacity 25 and
 *      200 daily jobs, and repairs the row an earlier seed already loaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, sessionCookie, routeCall } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const { schedule, parallelAppointmentCapacity } = await import("../backend/src/scheduling.ts");

const DAY_MS = 86_400_000, MINUTE_MS = 60_000;
const iso = (ms) => new Date(ms).toISOString();

// ---- 1. Engine ----------------------------------------------------------------------------------

/** 10:00 IST on a fixed date; the engine itself has no "must be in the future" rule. */
const S = Date.parse("2026-10-12T04:30:00.000Z");
const trainer = (id, extra = {}) => ({
  id, cityId: "blr", name: id, model: "full_time", services: ["dog_training"], zones: ["blr-east"], live: true,
  rating: 4.9, qualityScore: 95, capacity: 1, travelBufferMinutes: 45, maxDailyJobs: 8, ...extra,
});
const booking = (id, providerId, startMs, minutes = 60, serviceCode = "dog_training") => ({
  id, providerId, serviceCode, status: "assigned", scheduledStart: iso(startMs), scheduledEnd: iso(startMs + minutes * MINUTE_MS), petIds: ["x"], capacityUnits: 1,
});
function memoryRepo({ providers, bookings = [] }) {
  return {
    async listEligibleProviders() { return providers; },
    async listBookings(_cityId, providerId) { return bookings.filter((item) => item.providerId === providerId); },
    async listAvailability(providerId, date) { return [{ id: `a_${providerId}_${date}`, providerId, cityId: "blr", zoneId: "blr-east", date, windows: ["06:00-22:00"], source: "roster", updatedAt: "2026-09-26T00:00:00.000Z" }]; },
    async getPet(id) { return { id, customerId: "c", legacyIds: [], name: id, species: "dog", allergies: [], vaccinationStatus: "verified", createdAt: "", updatedAt: "" }; },
    async close() {},
  };
}
const training = (extra = {}) => ({
  cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", petIds: ["Bruno"],
  scheduledStart: iso(S), scheduledEnd: iso(S + 60 * MINUTE_MS), occurrences: 1, cadenceDays: 4, ...extra,
});
/** offerExpiresAt is wall-clock; everything else must match exactly. */
const comparable = (decision) => JSON.parse(JSON.stringify({ ...decision, offerExpiresAt: decision.offerExpiresAt ? "set" : undefined }));
const evaluation = (decision, id) => decision.evaluations.find((item) => item.providerId === id);

test("engine, flag off: an overlapping booking excludes the provider whatever its capacity, exactly as before", async () => {
  for (const capacity of [1, 25]) {
    const providers = [trainer("team", { capacity })];
    const busy = [booking("b1", "team", S + 30 * MINUTE_MS)];
    const absent = await schedule(memoryRepo({ providers, bookings: busy }), training());
    const off = await schedule(memoryRepo({ providers, bookings: busy }), training({ parallelAppointments: false }));
    assert.deepEqual(comparable(off), comparable(absent), "an explicit false must be the same as leaving the flag out");
    assert.equal(absent.provider, null, `capacity ${capacity} must not matter for appointments without the flag`);
    assert.deepEqual(evaluation(absent, "team"), {
      providerId: "team", providerName: "team", eligible: false, score: 95 + 5 + 6 - 2,
      reasons: ["Existing booking conflicts with travel/service buffer"], workload: 1, distanceKm: Number.POSITIVE_INFINITY, residualCapacity: 6,
    });
    const free = await schedule(memoryRepo({ providers }), training({ parallelAppointments: false }));
    assert.equal(free.provider?.id, "team");
    assert.deepEqual(evaluation(free, "team").reasons, ["Roster, interval leave, conflicts, travel buffer and daily limit passed"]);
  }
});

test("engine, flag on with capacity 1: every decision is identical to flag off", async () => {
  const providers = [trainer("zone"), trainer("other", { qualityScore: 90 })];
  const scenarios = {
    free: [],
    overlapping: [booking("b1", "zone", S + 30 * MINUTE_MS)],
    exactWindow: [booking("b1", "zone", S)],
    insideBuffer: [booking("b1", "zone", S + 100 * MINUTE_MS)],
    outsideBuffer: [booking("b1", "zone", S + 105 * MINUTE_MS)],
    dailyLimit: Array.from({ length: 8 }, (_, i) => booking(`d${i}`, "zone", S + (180 + i * 10) * MINUTE_MS, 5)),
    bothBusy: [booking("b1", "zone", S), booking("b2", "other", S - 30 * MINUTE_MS)],
  };
  for (const [name, bookings] of Object.entries(scenarios)) {
    for (const occurrences of [1, 8]) {
      const off = await schedule(memoryRepo({ providers, bookings }), training({ occurrences }));
      const on = await schedule(memoryRepo({ providers, bookings }), training({ occurrences, parallelAppointments: true }));
      assert.deepEqual(comparable(on), comparable(off), `${name} x${occurrences}: capacity 1 must behave exactly as today`);
    }
  }
});

test("engine, flag on with capacity 25: overlap is allowed up to capacity, an identical window and the daily limit still exclude", async () => {
  const providers = [trainer("team", { capacity: 25, maxDailyJobs: 200 })];

  const overlapping = await schedule(memoryRepo({ providers, bookings: [booking("b1", "team", S + 30 * MINUTE_MS)] }), training({ parallelAppointments: true }));
  assert.equal(overlapping.provider?.id, "team", "an overlapping session no longer takes the only trainer away");

  const identical = await schedule(memoryRepo({ providers, bookings: [booking("b1", "team", S)] }), training({ parallelAppointments: true }));
  assert.equal(identical.provider, null, "the unique (provider, start, end) index would refuse this write, so the engine must too");
  assert.deepEqual(evaluation(identical, "team").reasons, ["Existing booking already holds this exact window"]);

  const around = (count) => Array.from({ length: count }, (_, i) => booking(`o${i}`, "team", S + (i % 2 ? 1 : -1) * (5 + i) * MINUTE_MS));
  const twentyFour = await schedule(memoryRepo({ providers, bookings: around(24) }), training({ parallelAppointments: true }));
  assert.equal(twentyFour.provider?.id, "team", "24 overlapping holds leave room for the 25th");
  const twentyFive = await schedule(memoryRepo({ providers, bookings: around(25) }), training({ parallelAppointments: true }));
  assert.equal(twentyFive.provider, null, "the 25th overlapping hold fills the capacity");
  assert.deepEqual(evaluation(twentyFive, "team").reasons, ["Parallel appointment capacity 25 reached"]);

  const limited = [trainer("team", { capacity: 25, maxDailyJobs: 3 })];
  const sameDay = Array.from({ length: 3 }, (_, i) => booking(`d${i}`, "team", S + (4 + i) * 60 * MINUTE_MS));
  const daily = await schedule(memoryRepo({ providers: limited, bookings: sameDay }), training({ parallelAppointments: true }));
  assert.equal(daily.provider, null);
  assert.deepEqual(evaluation(daily, "team").reasons, ["Daily job limit 3 reached"], "parallel capacity never lifts the daily job limit");
});

test("engine, flag on: only sessions of the same service share; any other overlapping job still needs the provider to itself", async () => {
  const providers = [trainer("team", { services: ["dog_training", "boarding"], capacity: 25, maxDailyJobs: 200 })];
  const stay = booking("stay", "team", S - 12 * 60 * MINUTE_MS, 24 * 60, "boarding");
  const hosting = await schedule(memoryRepo({ providers, bookings: [stay] }), training({ parallelAppointments: true }));
  assert.equal(hosting.provider, null, "a trainer hosting a boarding stay is not offered a parallel Training session");
  assert.deepEqual(evaluation(hosting, "team").reasons, ["Existing booking of another service conflicts with travel/service buffer"]);
  const off = await schedule(memoryRepo({ providers, bookings: [stay] }), training());
  assert.deepEqual(evaluation(off, "team").reasons, ["Existing booking conflicts with travel/service buffer"], "flag off keeps today's reason");
  const sameService = await schedule(memoryRepo({ providers, bookings: [booking("t1", "team", S + 30 * MINUTE_MS)] }), training({ parallelAppointments: true }));
  assert.equal(sameService.provider?.id, "team");
});

test("engine: an 8-session programme that clashes on some dates keeps the capacity-25 team trainer only when the flag is on", async () => {
  const providers = [trainer("team", { capacity: 25, maxDailyJobs: 200 }), trainer("zone")];
  const bookings = [0, 3, 7].flatMap((n) => [
    booking(`t${n}`, "team", S + n * 4 * DAY_MS + 30 * MINUTE_MS),
    booking(`z${n}`, "zone", S + n * 4 * DAY_MS - 30 * MINUTE_MS),
  ]);
  const request = training({ occurrences: 8, cadenceDays: 4 });
  const off = await schedule(memoryRepo({ providers, bookings }), request);
  assert.equal(off.provider, null, "today: one clash on any date removes each trainer, which is what the tester saw");
  const on = await schedule(memoryRepo({ providers, bookings }), { ...request, parallelAppointments: true });
  assert.equal(on.provider?.id, "team");
  assert.equal(on.occurrences.length, 8);
  assert.equal(evaluation(on, "zone").eligible, false, "a capacity-1 trainer is still one session at a time");
});

test("engine: parallel capacity is 1 unless declared, and never below 1", () => {
  assert.equal(parallelAppointmentCapacity({ capacity: 25 }, {}), 1);
  assert.equal(parallelAppointmentCapacity({ capacity: 25 }, { parallelAppointments: false }), 1);
  assert.equal(parallelAppointmentCapacity({ capacity: 25 }, { parallelAppointments: true }), 25);
  for (const capacity of [0, -3, Number.NaN, undefined]) assert.equal(parallelAppointmentCapacity({ capacity }, { parallelAppointments: true }), 1);
});

// ---- 3. Staging seed ----------------------------------------------------------------------------

const SEED = readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8");
const seedStatements = (pattern) => SEED.split(";\n").map((chunk) => chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
  .filter((statement) => pattern.test(statement)).map((statement) => `${statement.replace(/;$/, "")};`);
const PROFILE_STATEMENTS = seedStatements(/^(INSERT OR IGNORE INTO|UPDATE) provider_capacity_profiles\b/);
const runProfileSeed = (sqlite) => { for (const statement of PROFILE_STATEMENTS) sqlite.exec(statement); };
const profile = (sqlite, id) => sqlite.prepare("SELECT capacity,max_daily_jobs,version,updated_by FROM provider_capacity_profiles WHERE id=?").get(id);
const TEAM_ROW = `INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft','blr','PawSpace Training Team (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,?,45,?,3,'active',1,'2026-01-01',NULL,?,1789300000000)`;

test("seed: the city-wide UAT team trainer is loaded with capacity 25 / 200 daily jobs, zone trainers stay at 1", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  assert.ok(PROFILE_STATEMENTS.some((statement) => statement.startsWith("UPDATE provider_capacity_profiles SET capacity=")), "the seed must carry the upward repair");
  runProfileSeed(ctx.sqlite);
  assert.deepEqual({ ...profile(ctx.sqlite, "uatcap_train_ft") }, { capacity: 25, max_daily_jobs: 200, version: 1, updated_by: "founder_seed" });
  for (const zone of ["east", "south", "north", "west", "central"]) {
    assert.equal(profile(ctx.sqlite, `uatcap_train_${zone}`).capacity, 1, `uatcap_train_${zone} keeps exercising the one-at-a-time path`);
  }
  for (const seat of [2, 3, 4, 5]) {
    assert.deepEqual({ ...profile(ctx.sqlite, `uatcap_train_ft_${seat}`) }, { capacity: 25, max_daily_jobs: 200, version: 1, updated_by: "founder_seed" }, `Training Team seat ${seat} is a full team profile`);
  }
  runProfileSeed(ctx.sqlite);
  assert.equal(profile(ctx.sqlite, "uatcap_train_ft").version, 1, "re-running the seed on the next deploy changes nothing");
});

test("seed: a team trainer an earlier seed loaded at capacity 1 is raised once, and an Ops-edited one is left alone", async (t) => {
  const stale = await setupJourney(); t.after(stale.close);
  stale.sqlite.prepare(TEAM_ROW).run(1, 12, "founder_seed");
  runProfileSeed(stale.sqlite);
  assert.deepEqual({ ...profile(stale.sqlite, "uatcap_train_ft") }, { capacity: 25, max_daily_jobs: 200, version: 2, updated_by: "founder_seed" });
  runProfileSeed(stale.sqlite);
  assert.equal(profile(stale.sqlite, "uatcap_train_ft").version, 2, "the repair is idempotent");

  const human = await setupJourney(); t.after(human.close);
  human.sqlite.prepare(TEAM_ROW).run(2, 6, "ops.manager@pawspace.in");
  runProfileSeed(human.sqlite);
  assert.deepEqual({ ...profile(human.sqlite, "uatcap_train_ft") }, { capacity: 2, max_daily_jobs: 6, version: 1, updated_by: "ops.manager@pawspace.in" }, "a seed must never overrule a person");
});

// ---- 2. Route: /api/uat-scheduling, declared UAT vs production-like -----------------------------

const ROUTE = "../../app/api/uat-scheduling/route.ts";
const SESSIONS = 8, CADENCE = 4;
/** 10:00 IST six days out, like the tester's programme; every session lands on the same IST day as its UTC day. */
const FIRST = (() => { const date = new Date(Date.now() + 6 * DAY_MS); date.setUTCHours(4, 30, 0, 0); return date.getTime(); })();
const sessionDates = Array.from({ length: SESSIONS }, (_, i) => iso(FIRST + i * CADENCE * DAY_MS).slice(0, 10));

/**
 * Staging, reduced to one trainer: the seed's own uatcap_train_ft rows (profile and home base) are
 * executed, the runtime's built-in blr-east trainers are taken offline, and Ops-published availability
 * covers every session date - so a declared and an undeclared runtime see exactly the same roster and
 * the ONLY difference is the scheduling environment declaration.
 */
async function stagingWorld(t, { uat, seats = false }) {
  const ctx = await setupJourney(); t.after(ctx.close);
  if (!uat) delete globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_SCHEDULING_ENV;
  const { sqlite, db } = ctx;
  for (const statement of seedStatements(/^(INSERT OR IGNORE INTO provider_capacity_profiles .*'uatcap_train_ft'|UPDATE provider_capacity_profiles SET capacity=|CREATE TABLE IF NOT EXISTS (provider_home_base|scheduling_availability) )/)) sqlite.exec(statement);
  sqlite.exec(seedStatements(/^INSERT INTO provider_home_base .*'UAT-PHB-uatcap_train_ft'/)[0]);
  const team = ["uatcap_train_ft"];
  if (seats) {
    // The seed's four more Training Team seats: their own profile and home base statements, verbatim.
    const statements = seedStatements(/^(INSERT OR IGNORE INTO provider_capacity_profiles .*'uatcap_train_ft_\d'|INSERT INTO provider_home_base .*'UAT-PHB-uatcap_train_ft_\d')/);
    assert.equal(statements.length, 8, "four seat profiles and four seat home bases");
    for (const statement of statements) sqlite.exec(statement);
    team.push("uatcap_train_ft_2", "uatcap_train_ft_3", "uatcap_train_ft_4", "uatcap_train_ft_5");
  }
  sqlite.exec("UPDATE provider_capacity_profiles SET live=0 WHERE id IN ('train_kiran','train_ramesh','train_meera')");
  const publish = sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  for (const providerId of team) for (const date of sessionDates) publish.run(`ops_${providerId}_${date}`, providerId, "blr", "blr-east", date, '["06:00-22:00"]', "operations", Date.now());
  const customers = {};
  for (const id of ["A", "B", "C", "D", "E", "F"]) {
    await seedOwnedPet(db, `CUST-PAR-${id}`, `PET-PAR-${id}`, `Dog ${id}`);
    customers[id] = await sessionCookie(db, "customer", `CUST-PAR-${id}`, `customer:CUST-PAR-${id}`);
  }
  const call = (id, over = {}) => {
    const start = FIRST + (over.shiftMinutes ?? 0) * MINUTE_MS;
    return routeCall(ROUTE, "POST", "/api/uat-scheduling", {
      clientRequestId: `PAR-${id}-${over.action ?? "reserve"}`, customerId: `CUST-PAR-${id}`, petIds: [`PET-PAR-${id}`], serviceCode: "dog_training",
      serviceAddress: "42 Indiranagar Double Road, Bengaluru", servicePincode: "560038",
      scheduledStart: iso(start), scheduledEnd: iso(start + 60 * MINUTE_MS), occurrences: over.occurrences ?? SESSIONS, cadenceDays: CADENCE,
      // Training is customer_select: the tester reserves the trainer they picked from the preview.
      ...(over.action ? { action: over.action } : { preferredProviderId: over.preferredProviderId ?? "uatcap_train_ft" }),
    }, customers[id]);
  };
  const held = (customerId) => sqlite.prepare("SELECT provider_id,scheduled_start,status FROM scheduling_reservations WHERE customer_id=? AND status!='cancelled' ORDER BY scheduled_start").all(customerId);
  // Tester A already holds the team trainer for the whole programme at 10:30 IST: every one of B's
  // 10:00 IST sessions overlaps one of A's.
  const first = await call("A", { shiftMinutes: 30 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.provider.id, "uatcap_train_ft");
  assert.equal(held("CUST-PAR-A").length, SESSIONS);
  return { ...ctx, call, held };
}

test("route, declared UAT: an 8-session Training programme still offers and reserves the team trainer that already has overlapping sessions", async (t) => {
  const world = await stagingWorld(t, { uat: true });
  const preview = await world.call("B", { action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.providers.map((provider) => provider.id), ["uatcap_train_ft"], "the tester is offered a trainer instead of 'No available trainer'");
  assert.equal(preview.body.data.occurrences.length, SESSIONS);

  const reserved = await world.call("B");
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  assert.equal(reserved.body.data.status, "assigned");
  assert.equal(reserved.body.data.provider.id, "uatcap_train_ft");
  const sessions = world.held("CUST-PAR-B");
  assert.equal(sessions.length, SESSIONS, "the commit guard accepts every overlapping session up to capacity");
  assert.ok(sessions.every((row) => row.provider_id === "uatcap_train_ft" && row.status === "assigned"));
  assert.equal(world.held("CUST-PAR-A").length, SESSIONS, "the earlier tester's programme is untouched");

  // One 11:40 IST session on the first date touches A's (10:30) and B's (10:00) sessions only through the
  // 45-minute travel buffer: neither overlaps the session itself. The engine sees reservations only through
  // the route's bounded booking read, so this is the check that the read keeps every buffer-overlapping hold
  // the capacity count needs: at capacity 2 the trainer is full, at 3 there is room for exactly one more.
  const single = { shiftMinutes: 100, occurrences: 1 };
  world.sqlite.exec("UPDATE provider_capacity_profiles SET capacity=2 WHERE id='uatcap_train_ft'");
  const full = await world.call("C", { action: "preview", ...single });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.deepEqual(full.body.data.providers, [], "both buffer-overlapping holds count against capacity 2");
  const refused = await world.call("C", single);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.ok(refused.body.evaluations[0].reasons.includes("Parallel appointment capacity 2 reached"), JSON.stringify(refused.body.evaluations[0].reasons));
  world.sqlite.exec("UPDATE provider_capacity_profiles SET capacity=3 WHERE id='uatcap_train_ft'");
  const room = await world.call("C", { action: "preview", ...single });
  assert.deepEqual(room.body.data.providers.map((provider) => provider.id), ["uatcap_train_ft"]);
  const third = await world.call("C", single);
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(world.held("CUST-PAR-C").length, 1, "the commit guard counts the same two overlapping holds and accepts the third");
});

test("route, declared UAT: a hold of another service on the team trainer still blocks the overlapping Training session", async (t) => {
  const world = await stagingWorld(t, { uat: true });
  // A boarding hold straddling B's first 10:00 IST session (the seeded trainer offers Training only, so this
  // stands in for any other job a multi-service provider could hold).
  world.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,occurrence_number,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("R-OTHER", "G-OTHER", "uatcap_train_ft", "boarding", "blr", "blr-east", "CUST-OTHER", "[]", iso(FIRST - 2 * 60 * MINUTE_MS), iso(FIRST + 3 * 60 * MINUTE_MS), 1, "assigned", "{}", Date.now());
  const preview = await world.call("B", { action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.providers, []);
  const refused = await world.call("B");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.ok(refused.body.evaluations[0].reasons.includes("Existing booking of another service conflicts with travel/service buffer"), JSON.stringify(refused.body.evaluations[0].reasons));
  assert.equal(world.held("CUST-PAR-B").length, 0);
});

test("route, declared UAT: the identical window is still refused, because the same trainer can never hold it twice", async (t) => {
  const world = await stagingWorld(t, { uat: true });
  const preview = await world.call("C", { action: "preview", shiftMinutes: 30 });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.providers, []);
  const refused = await world.call("C", { shiftMinutes: 30 });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "SELECTED_PROVIDER_UNAVAILABLE");
  assert.ok(refused.body.evaluations[0].reasons.includes("Existing booking already holds this exact window"));
  assert.equal(world.held("CUST-PAR-C").length, 0);
});

test("route, declared UAT: testers who pick the identical window each get another Training Team seat", async (t) => {
  const world = await stagingWorld(t, { uat: true, seats: true });
  // A holds the team trainer for the whole programme at 10:30 IST; B to E keep exactly the same choices.
  const taken = [];
  for (const id of ["B", "C", "D", "E"]) {
    const preview = await world.call(id, { action: "preview", shiftMinutes: 30 });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const offered = preview.body.data.providers.map((provider) => provider.id);
    assert.ok(offered.length > 0, `tester ${id} is offered a trainer instead of "No available trainer"`);
    assert.ok(!offered.includes("uatcap_train_ft") && offered.every((seat) => !taken.includes(seat)), `a seat that already holds this exact window is never offered again: ${offered}`);
    const reserved = await world.call(id, { shiftMinutes: 30, preferredProviderId: offered[0] });
    assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
    assert.equal(world.held(`CUST-PAR-${id}`).length, SESSIONS, "every session of the programme is held");
    taken.push(reserved.body.data.provider.id);
  }
  assert.deepEqual([...taken].sort(), ["uatcap_train_ft_2", "uatcap_train_ft_3", "uatcap_train_ft_4", "uatcap_train_ft_5"]);
  // Five seats hold five identical programmes; a sixth identical one has no seat left, while a different
  // start time still shares a seat in parallel.
  const sixth = await world.call("F", { action: "preview", shiftMinutes: 30 });
  assert.deepEqual(sixth.body.data.providers, []);
  const shifted = await world.call("F", { action: "preview", shiftMinutes: 15 });
  assert.equal(shifted.status, 200, JSON.stringify(shifted.body));
  assert.ok(shifted.body.data.providers.length > 0, "a quarter of an hour later is offered again");
});

test("route, declared UAT: an Ops reassign with no replacement restores the parallel-held programme instead of losing it", async (t) => {
  const world = await stagingWorld(t, { uat: true });
  assert.equal((await world.call("B")).status, 200);
  const reassign = await routeCall(ROUTE, "POST", "/api/uat-scheduling", { action: "reassign", groupId: "PAR-B-reserve", reason: "Trainer asked to swap this programme" });
  assert.equal(reassign.status, 409, JSON.stringify(reassign.body));
  assert.equal(reassign.body.error, "No eligible provider is available for this action; the existing assignment was left in place");
  assert.equal(reassign.body.restored, true);
  assert.equal(world.held("CUST-PAR-B").length, SESSIONS, "every session is back, next to the overlapping ones it was reserved beside");
});

test("route, production-like (no scheduling environment declared): the same programme is refused exactly as before", async (t) => {
  const world = await stagingWorld(t, { uat: false });
  const preview = await world.call("B", { action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.data.providers, [], "capacity 25 unlocks nothing without the UAT declaration");
  const refused = await world.call("B");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "SELECTED_PROVIDER_UNAVAILABLE");
  assert.ok(refused.body.evaluations[0].reasons.includes("Existing booking conflicts with travel/service buffer"));
  assert.equal(world.held("CUST-PAR-B").length, 0);
});
