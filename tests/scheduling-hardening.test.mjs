import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Two test-only resolve hooks so the REAL route/engine sources run unmodified in node:
// 1. "cloudflare:workers" resolves to a stub whose env.DB reads the current per-test D1 shim.
// 2. Extensionless relative imports fall back to .ts (Node's ESM loader vs the bundler).
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__SCHED_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;},get PAWSPACE_SCHEDULING_ENV(){return 'uat';}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

// ---- Minimal D1 shim over a real SQLite engine ------------------------------------------------
// hideActiveReservationReads simulates the concurrency race deterministically: while true, the
// ENGINE's conflict reads see an empty table (as if the competing transaction had not committed
// yet), while the guarded INSERT and all writes still hit the real table.
function makeD1(sqlite, options = {}) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => {
        if (options.hide?.() && /FROM scheduling_reservations WHERE city_id=/.test(sql)) return { results: [] };
        return { results: sqlite.prepare(sql).all(...args) };
      },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

const IST = 330 * 60_000;
function istInstant(daysAhead, hour, minute = 0) { const s = new Date(Date.now() + IST); return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + daysAhead, hour, minute) - IST); }
const istDateKey = (d) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const istWeekday = (d) => new Date(d.getTime() + IST).getUTCDay();

let sqlite, hideReservations = false;
function freshDb() {
  sqlite = new DatabaseSync(":memory:");
  hideReservations = false;
  globalThis.__SCHED_DB__ = makeD1(sqlite, { hide: () => hideReservations });
  seedCanonicalPets();
}

/**
 * Boarding now refuses before reserving unless every selected pet is a canonical record owned by the
 * booking customer with verified vaccination (issue #197 item 4 — a modified client must not be able to
 * hold capacity for someone else's pet or an unvaccinated one). These fixtures predate that rule, so the
 * pets the boarding cases book are seeded here. Ownership and vaccination refusals are proven separately
 * in tests/boarding-reservation-authority.test.mjs; this file is about capacity and assignment.
 */
function seedCanonicalPets() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  // A pet belongs to exactly one customer, so each booking customer gets its own. The overnight-capacity
  // case below books as two different customers, which is why it now names two different pets — the same
  // pet id under two owners would (correctly) be refused as someone else's pet.
  for (const [petId, customerId] of [["Bruno", "cus_hardening"], ["Bruno2", "cus_other"], ["x", "c"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO canonical_pets (id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,'dog','verified',?,?)")
      .run(petId, customerId, petId, now, now);
  }
}

const routeModule = await import("../app/api/uat-scheduling/route.ts");
const { schedule } = await import("../backend/src/scheduling.ts");

async function post(body) {
  const response = await routeModule.POST(new Request("http://localhost/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
async function get(query) {
  const response = await routeModule.GET(new Request(`http://localhost/api/uat-scheduling?${query}`));
  return { status: response.status, body: await response.json() };
}
const reserve = (overrides) => ({ clientRequestId: overrides.clientRequestId, customerId: "cus_hardening", petIds: ["Bruno"], zoneId: "blr-east", ...overrides });

// ---- Engine real-execution (real schedule(), in-memory repository) ----------------------------

const mkProvider = (id, quality, extra = {}) => ({ id, cityId: "blr", name: id, model: "commission", services: ["grooming"], zones: ["blr-east"], live: true, rating: 4.8, qualityScore: quality, capacity: 1, travelBufferMinutes: 30, maxDailyJobs: 6, ...extra });
function memoryRepo({ providers, bookings = [], windows = ["09:00-19:00"] }) {
  return {
    async listEligibleProviders() { return providers; },
    async listBookings(_cityId, providerId) { return bookings.filter((b) => b.providerId === providerId); },
    async listAvailability(providerId, date) { return [{ id: `a_${providerId}_${date}`, providerId, cityId: "blr", zoneId: "blr-east", date, windows, source: "roster", updatedAt: new Date().toISOString() }]; },
    async getPet(id) { return { id, customerId: "c", legacyIds: [], name: id, species: "dog", allergies: [], vaccinationStatus: "verified", createdAt: "", updatedAt: "" }; },
    async close() {},
  };
}
const booking = (providerId, start, end) => ({ id: `b_${providerId}_${start}`, providerId, status: "assigned", scheduledStart: start, scheduledEnd: end, petIds: ["x"], capacityUnits: 1 });
const groomingReq = (start, end, extra = {}) => ({ cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", petIds: ["Bruno"], scheduledStart: start, scheduledEnd: end, ...extra });
// 10:00 IST = 04:30Z on a fixed future date — the engine itself has no "must be future" rule.
const S = "2026-09-01T04:30:00.000Z", E = "2026-09-01T06:30:00.000Z";

test("engine: auto-assign picks the highest-scoring eligible provider", async () => {
  const repo = memoryRepo({ providers: [mkProvider("p89", 89), mkProvider("p96", 96), mkProvider("p92", 92)] });
  const decision = await schedule(repo, groomingReq(S, E));
  assert.equal(decision.provider?.id, "p96");
  assert.equal(decision.evaluations.filter((e) => e.eligible).length, 3, "all three were eligible — ranking, not filtering, chose p96");
});

test("engine: preferredProviderId is a soft +20 — wins while eligible, falls back when busy", async () => {
  const providers = [mkProvider("p89", 89), mkProvider("p96", 96)];
  const preferred = await schedule(memoryRepo({ providers }), groomingReq(S, E, { preferredProviderId: "p89" }));
  assert.equal(preferred.provider?.id, "p89", "89+20=109 outranks 96 while the preferred provider is free");
  const busy = await schedule(memoryRepo({ providers, bookings: [booking("p89", S, E)] }), groomingReq(S, E, { preferredProviderId: "p89" }));
  assert.equal(busy.provider?.id, "p96", "a busy preferred provider is skipped, not forced");
  const evaluation = busy.evaluations.find((e) => e.providerId === "p89");
  assert.equal(evaluation.eligible, false);
});

test("engine: travel buffer blocks back-to-back jobs inside the buffer and allows them outside it", async () => {
  const providers = [mkProvider("pa", 96), mkProvider("pb", 80)];
  const existingEnd = "2026-09-01T06:30:00.000Z";
  // gap of 15 min < 30-min buffer -> pa ineligible, lower-scoring pb wins
  const tight = await schedule(memoryRepo({ providers, bookings: [booking("pa", S, existingEnd)] }), groomingReq("2026-09-01T06:45:00.000Z", "2026-09-01T08:45:00.000Z"));
  assert.equal(tight.provider?.id, "pb");
  assert.match(tight.evaluations.find((e) => e.providerId === "pa").reasons.join(" "), /travel\/service buffer/);
  // gap of exactly 30 min -> pa eligible again and outranks pb
  const spaced = await schedule(memoryRepo({ providers, bookings: [booking("pa", S, existingEnd)] }), groomingReq("2026-09-01T07:00:00.000Z", "2026-09-01T09:00:00.000Z"));
  assert.equal(spaced.provider?.id, "pa");
});

test("engine: max daily jobs is enforced per IST day", async () => {
  const providers = [mkProvider("pa", 96, { maxDailyJobs: 1 }), mkProvider("pb", 80)];
  const sameDayOther = booking("pa", "2026-09-01T10:00:00.000Z", "2026-09-01T12:00:00.000Z"); // no time overlap
  const decision = await schedule(memoryRepo({ providers, bookings: [sameDayOther] }), groomingReq(S, E));
  assert.equal(decision.provider?.id, "pb");
  assert.match(decision.evaluations.find((e) => e.providerId === "pa").reasons.join(" "), /Daily job limit 1 reached/);
});

test("engine: roster windows are evaluated in IST — 20:00 IST is outside a 09:00-19:00 roster", async () => {
  const providers = [mkProvider("pa", 96)];
  const late = await schedule(memoryRepo({ providers }), groomingReq("2026-09-01T14:30:00.000Z", "2026-09-01T16:30:00.000Z")); // 20:00-22:00 IST
  assert.equal(late.provider, null);
  assert.match(late.evaluations[0].reasons.join(" "), /outside roster/);
  const morning = await schedule(memoryRepo({ providers }), groomingReq(S, E)); // 10:00-12:00 IST
  assert.equal(morning.provider?.id, "pa");
});

test("engine: recurring weekday calendars land every occurrence on the requested IST weekday", async () => {
  const providers = [mkProvider("w1", 96, { services: ["dog_walking"], travelBufferMinutes: 20 })];
  const start = istInstant(10, 7); // future 07:00 IST
  const weekday = istWeekday(start);
  const decision = await schedule(memoryRepo({ providers, windows: ["06:00-21:00"] }), { cityId: "blr", zoneId: "blr-east", serviceCode: "dog_walking", petIds: ["Bruno"], scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString(), occurrences: 4, weekdays: [weekday] });
  assert.equal(decision.occurrences.length, 4);
  for (const occ of decision.occurrences) assert.equal(istWeekday(new Date(occ.start)), weekday);
});

// ---- Route real-execution (real POST/GET handlers on real SQLite via the cloudflare stub) ------

test("route: founder scope — boarding and pet_sitting without a chosen host return 409 host_selection_required", async () => {
  freshDb();
  const start = istInstant(5, 13), end = istInstant(7, 11);
  for (const serviceCode of ["boarding", "pet_sitting"]) {
    const result = await post(reserve({ clientRequestId: `scope-${serviceCode}`, serviceCode, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), careMode: serviceCode === "pet_sitting" ? "overnight" : undefined }));
    assert.equal(result.status, 409, serviceCode);
    assert.equal(result.body.error, "host_selection_required", serviceCode);
  }
});

test("route: boarding with a chosen host reserves, and overnight capacity still allows parallel stays after the guard", async () => {
  freshDb();
  const start = istInstant(5, 13), end = istInstant(7, 11);
  const first = await post(reserve({ clientRequestId: "board-1", serviceCode: "boarding", preferredProviderId: "host_maya_rohan", scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() }));
  assert.equal(first.status, 200);
  assert.equal(first.body.data.provider.id, "host_maya_rohan");
  // host_maya_rohan has capacity 4: a second overlapping stay must still be insertable (the
  // double-booking guard is per-appointment for slot services, capacity-summed for overnight).
  const second = await post(reserve({ clientRequestId: "board-2", customerId: "cus_other", petIds: ["Bruno2"], serviceCode: "boarding", preferredProviderId: "host_maya_rohan", scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.data.provider.id, "host_maya_rohan");
  const rows = sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE provider_id='host_maya_rohan' AND status!='cancelled'").get();
  assert.equal(rows.c, 2);
});

test("route: auto-assign services pick the highest-scoring provider (pet_taxi -> taxi_rahul, dog_walking -> walk_nisha)", async () => {
  freshDb();
  const taxiStart = istInstant(6, 10);
  const taxi = await post(reserve({ clientRequestId: "taxi-top", serviceCode: "pet_taxi", scheduledStart: taxiStart.toISOString(), scheduledEnd: new Date(taxiStart.getTime() + 45 * 60_000).toISOString() }));
  assert.equal(taxi.status, 200);
  assert.equal(taxi.body.data.provider.id, "taxi_rahul", "96+5(full_time)=101 beats 99 and 97");
  const walkStart = istInstant(6, 7);
  const walk = await post(reserve({ clientRequestId: "walk-top", serviceCode: "dog_walking", scheduledStart: walkStart.toISOString(), scheduledEnd: new Date(walkStart.getTime() + 30 * 60_000).toISOString() }));
  assert.equal(walk.status, 200);
  assert.equal(walk.body.data.provider.id, "walk_nisha", "quality 96 beats 94 and 92");
});

test("route: grooming outside the seeded 09:00-19:00 IST roster window is refused", async () => {
  freshDb();
  const start = istInstant(6, 20); // 20:00 IST
  const result = await post(reserve({ clientRequestId: "groom-late", serviceCode: "grooming", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 120 * 60_000).toISOString() }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "NO_SCHEDULE_AVAILABLE");
});

test("route: double-booking is impossible — of two concurrent reserves for one slot, exactly one wins", async () => {
  freshDb();
  const start = istInstant(8, 10);
  const pin = [{ code: "pin", field: "providerId", operator: "eq", value: "groom_arun" }];
  const slot = { serviceCode: "grooming", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 120 * 60_000).toISOString(), customRules: pin };
  const winner = await post(reserve({ clientRequestId: "race-a", ...slot }));
  assert.equal(winner.status, 200);
  // Simulate the TOCTOU race deterministically: the second request's ENGINE reads see an empty
  // reservations table (the competing transaction "hasn't committed yet"), so evaluation passes —
  // only the atomic in-statement guard stands between it and a double booking.
  hideReservations = true;
  const loser = await post(reserve({ clientRequestId: "race-b", customerId: "cus_other", ...slot }));
  hideReservations = false;
  assert.equal(loser.status, 409, JSON.stringify(loser.body));
  assert.equal(loser.body.error, "SLOT_TAKEN");
  const active = sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE provider_id='groom_arun' AND status!='cancelled'").get();
  assert.equal(active.c, 1, "exactly one reservation row survived the race");
});

test("route: replaying the same clientRequestId is idempotent, never a second reservation", async () => {
  freshDb();
  const start = istInstant(8, 10);
  const body = reserve({ clientRequestId: "idem-1", serviceCode: "grooming", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 120 * 60_000).toISOString() });
  const first = await post(body);
  assert.equal(first.status, 200);
  const replay = await post(body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  const count = sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id='idem-1'").get();
  assert.equal(count.c, 1);
});

test("route: mid-programme provider_unavailability windows now block auto-assignment for those occurrences", async () => {
  freshDb();
  const start = istInstant(10, 7);
  const weekday = istWeekday(start);
  const secondWalkDay = istDateKey(istInstant(17, 7));
  // walk_nisha (top scorer) goes on leave covering the SECOND walk of the fortnight.
  await post(reserve({ clientRequestId: "warm-tables", serviceCode: "dog_walking", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString() })); // ensures all tables + roster exist
  sqlite.prepare("UPDATE scheduling_reservations SET status='cancelled'").run();
  sqlite.prepare("DELETE FROM scheduling_assignment_decisions").run();
  sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES ('leave1','walk_nisha',?,?,'annual leave','active','ops',0,0)")
    .run(new Date(`${secondWalkDay}T00:00:00+05:30`).toISOString(), new Date(new Date(`${secondWalkDay}T00:00:00+05:30`).getTime() + 86_400_000).toISOString());
  const result = await post(reserve({ clientRequestId: "leave-aware", serviceCode: "dog_walking", occurrences: 2, weekdays: [weekday], scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString() }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.provider.id, "walk_asha", "nisha is on leave for occurrence 2, so the next scorer (94) takes the whole programme");
});

test("route: staff reassign excludes the current provider, records the real actor and writes an audit event", async () => {
  freshDb();
  const start = istInstant(6, 7);
  const created = await post(reserve({ clientRequestId: "reassign-1", serviceCode: "dog_walking", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString() }));
  assert.equal(created.body.data.provider.id, "walk_nisha");
  const result = await post({ action: "reassign", groupId: "reassign-1", reason: "Customer asked for a different walker" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.data.provider.id, "walk_nisha");
  assert.equal(result.body.data.previousProviderId, "walk_nisha");
  const oldRows = sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id='reassign-1' AND provider_id='walk_nisha' AND status!='cancelled'").get();
  assert.equal(oldRows.c, 0, "old provider's reservations are cancelled");
  const newRows = sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id='reassign-1' AND status='assigned'").get();
  assert.equal(newRows.c, 1, "replacement reservation is live");
  const decision = sqlite.prepare("SELECT actor_id FROM scheduling_assignment_decisions WHERE group_id='reassign-1'").get();
  assert.equal(decision.actor_id, "preview@pawspace.test", "the REAL staff identity is recorded, not a hardcoded 'ops_uat'");
  const audit = sqlite.prepare("SELECT actor_email,outcome FROM security_audit_events WHERE action='scheduling.reassign' AND resource_id='reassign-1'").get();
  assert.ok(audit, "reassignment writes a security audit event");
  assert.equal(audit.outcome, "completed");
});

test("route: a reassign with no eligible replacement RESTORES the original assignment instead of destroying it", async () => {
  freshDb();
  const start = istInstant(9, 10);
  const pin = [{ code: "pin", field: "providerId", operator: "eq", value: "groom_arun" }];
  const created = await post(reserve({ clientRequestId: "restore-1", serviceCode: "grooming", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 120 * 60_000).toISOString(), customRules: pin }));
  assert.equal(created.body.data.provider.id, "groom_arun");
  // reassign excludes groom_arun; the pinned custom rule disqualifies everyone else -> must fail
  const result = await post({ action: "reassign", groupId: "restore-1", reason: "trying to move this booking" });
  assert.equal(result.status, 409);
  assert.equal(result.body.restored, true);
  const active = sqlite.prepare("SELECT provider_id,status FROM scheduling_reservations WHERE group_id='restore-1' AND status!='cancelled'").all();
  assert.equal(active.length, 1, "the customer keeps their original reservation");
  assert.equal(active[0].provider_id, "groom_arun");
  assert.equal(active[0].status, "assigned");
  const audit = sqlite.prepare("SELECT outcome FROM security_audit_events WHERE action='scheduling.reassign' AND resource_id='restore-1'").get();
  assert.equal(audit.outcome, "rejected");
});

test("route: GET day board groups reservations into per-provider columns for one IST day", async () => {
  freshDb();
  const start = istInstant(6, 7);
  await post(reserve({ clientRequestId: "board-day", serviceCode: "dog_walking", scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString() }));
  const board = await get(`date=${istDateKey(start)}`);
  assert.equal(board.status, 200);
  const column = board.body.data.providers.find((p) => p.providerId === "walk_nisha");
  assert.ok(column, "the assigned walker has a column");
  assert.equal(column.providerName, "Nisha P.");
  assert.equal(column.reservations[0].groupId, "board-day");
  assert.equal(column.reservations[0].serviceCode, "dog_walking");
  const emptyDay = await get(`date=${istDateKey(istInstant(60, 7))}`);
  assert.equal(emptyDay.body.data.providers.length, 0);
  const bad = await get("date=13-08-2026");
  assert.equal(bad.status, 400);
});

// ---- Contract tests ----------------------------------------------------------------------------

const routeSource = fs.readFileSync("app/api/uat-scheduling/route.ts", "utf8");
const gatewaySource = fs.readFileSync("lib/api-gateway.ts", "utf8");
const pageSource = fs.readFileSync("app/team/scheduling/page.tsx", "utf8");

test("contract: the route gets the DB via cloudflare:workers only and keeps the founder service-scope rule", () => {
  assert.match(routeSource, /await import\("cloudflare:workers"\)/);
  assert.doesNotMatch(routeSource, /globalThis/);
  assert.match(routeSource, /AUTO_ASSIGN_SERVICES=new Set\(\["grooming","dog_training","pet_taxi","dog_walking"\]\)/);
  assert.match(routeSource, /host_selection_required/);
});

test("contract: GET /api/uat-scheduling is staff-gated to scheduling.manage in the gateway", () => {
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/uat-scheduling"\)\{if\(method==="GET"\)return "scheduling\.manage";/);
});

test("contract: the staff scheduling board is standalone and uses only the governed endpoints", () => {
  assert.match(pageSource, /^"use client";/m);
  assert.match(pageSource, /\/api\/uat-scheduling\?date=/);
  assert.match(pageSource, /action:"reassign"/);
  assert.doesNotMatch(pageSource, /globalThis/);
  assert.doesNotMatch(pageSource, /from\s*["'][^"']*(grooming-flow|stay-flow|training-flow|walking-flow|food-flow)/);
});

test("contract: the double-booking guard and restore-on-failure are present in source", () => {
  assert.match(routeSource, /class SlotConflictError extends Error/);
  assert.match(routeSource, /WHERE NOT EXISTS \(SELECT 1 FROM scheduling_reservations WHERE provider_id=\? AND status!='cancelled' AND scheduled_start<\? AND scheduled_end>\?\)/);
  assert.match(routeSource, /COALESCE\(SUM\(capacity_units\),0\)/, "overnight services guard on capacity, not blanket overlap");
  // Declared in a combined const list alongside `previousRows`; the guarantee is the restore closure and
  // that a rejected decision and a lost slot race both run it.
  assert.match(routeSource, /restore=async\(\)/);
  assert.equal(routeSource.match(/await restore\(\)/g)?.length, 2, "both the rejection and the conflict path must restore");
  assert.match(routeSource, /securityAudit\(db,actor,`scheduling\.\$\{input\.action\}`/);
});
