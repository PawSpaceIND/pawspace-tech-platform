/**
 * PARTNER-01: the Boarding host workspace showed "Care plan: Ready" and a pet COUNT, never the pets or the
 * plan itself, and the partner job feed returned addOns: [] for a stay whose customer had picked extras.
 *
 * These run the real modules: the stay read against a SQLite-backed D1, the provider-scoped
 * GET /api/boarding-stays as the signed-in host, the partner job feed, and the host's care component
 * rendered with react-dom/server. The privacy rule is the Pet Sitting one: emergency contact, vet and home
 * access reach the host only once it has accepted a paid stay (Boarding acceptance requires captured
 * payment and moves the stay to confirmed, then in_progress at check-in).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, nextKey, seedBoardingStay } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_HOST_CARE_DB__", "__BOARDING_HOST_CARE_ENV__");
globalThis.__BOARDING_HOST_CARE_ENV__ = {};

const { projectBoardingProviderStay, boardingProviderExtras } = await import("../lib/boarding-provider-projection.ts");
const { boardingCareDraft } = await import("../lib/boarding-customer-care.ts");
const { mutateBoardingStay } = await import("../lib/boarding-stay-lifecycle.ts");
const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const route = await import("../app/api/boarding-stays/route.ts");

const EXTRAS = ["Pickup & drop", "Three walks", "Medication support", "1-hour play time", "Grooming add-on", "Training add-on"];
const EMERGENCY = "Asha R. +919800000001", VET = "Cessna Lifeline +919800000002";
const WITHHELD_NOTE = "Shared once the booking is paid and you have accepted it";
/** The plan exactly as the customer Boarding flow saves it (app/mobile-app/stay-flow.tsx -> boardingCareDraft). */
const customerPlan = () => boardingCareDraft(
  { feeding: "Two meals, 8am and 7pm", medication: "Half tablet Apoquel 16mg with breakfast", vet: VET, emergencyContact: EMERGENCY, specialInstructions: "Crate at night" },
  ["Senior care"], EXTRAS, "Pet food from home",
);

test("the extras line boardingCareDraft writes is the one the host projection reads back", () => {
  const plan = customerPlan();
  assert.match(plan.specialInstructions, /Requested extras \(subject to host agreement\): Pickup & drop, Three walks/);
  assert.deepEqual(boardingProviderExtras(plan.specialInstructions), EXTRAS);
  assert.deepEqual(boardingProviderExtras(boardingCareDraft({}, [], [], "").specialInstructions), []);
  assert.deepEqual(boardingProviderExtras(undefined), []);
});

function stayAt(status) {
  return projectBoardingProviderStay({
    id: "S1", booking_id: "B1", status, host_provider_id: "host_maya_rohan", customer_id: "c1", pet_count: 2,
    pets: [{ id: "p1", name: "Bruno", species: "dog", breed: "Indie" }, { id: "p2", name: "Misty", species: "cat", breed: null }],
    carePlan: { status: "ready", plan: { ...customerPlan(), homeAccess: "Gate code 4455" }, updatedAt: 1 },
    events: [],
  });
}

test("before acceptance the host sees the pets, the routine and the extras, and no contact or access detail", () => {
  for (const status of ["awaiting_host_acceptance", "recovery_pending", "completed", "cancelled"]) {
    const out = stayAt(status);
    assert.deepEqual(out.pets, [{ name: "Bruno", species: "dog", breed: "Indie" }, { name: "Misty", species: "cat", breed: null }], status);
    assert.equal(out.carePlan.plan.feeding, "Two meals, 8am and 7pm", status);
    assert.equal(out.carePlan.plan.medication, "Half tablet Apoquel 16mg with breakfast", status);
    // The extras are listed once, as extras, not repeated inside the special instructions.
    assert.equal(out.carePlan.plan.specialInstructions, "Crate at night\nCare requests: Senior care\nFood preference: Pet food from home", status);
    assert.deepEqual(out.carePlan.requestedExtras, EXTRAS, status);
    for (const key of ["emergencyContact", "vet", "homeAccess"]) assert.equal(out.carePlan.plan[key], undefined, `${status}: ${key}`);
    assert.deepEqual(out.carePlan.withheldUntilAccepted, ["emergencyContact", "vet", "homeAccess"], status);
    const serialized = JSON.stringify(out);
    for (const secret of ["9800000001", "9800000002", "Cessna", "4455"]) assert.ok(!serialized.includes(secret), `${status} leaked ${secret}`);
  }
});

test("routine text carrying a phone number waits for acceptance with the contacts instead of vanishing", () => {
  const out = projectBoardingProviderStay({ id: "S1", status: "awaiting_host_acceptance", carePlan: { status: "ready", plan: { feeding: "Kibble", medication: "Ring 9876543210 before any dose" } } });
  assert.equal(out.carePlan.plan.medication, undefined);
  assert.deepEqual(out.carePlan.withheldUntilAccepted, ["medication"]);
  assert.ok(!JSON.stringify(out).includes("9876543210"));
  assert.equal(projectBoardingProviderStay({ id: "S1", status: "confirmed", carePlan: { status: "ready", plan: { medication: "Ring 9876543210 before any dose" } } }).carePlan.plan.medication, "Ring 9876543210 before any dose");
});

test("once the host has accepted the paid stay, emergency contact, vet and home access are released", () => {
  for (const status of ["confirmed", "in_progress"]) {
    const out = stayAt(status);
    assert.equal(out.carePlan.plan.emergencyContact, EMERGENCY, status);
    assert.equal(out.carePlan.plan.vet, VET, status);
    assert.equal(out.carePlan.plan.homeAccess, "Gate code 4455", status);
    assert.equal(out.carePlan.withheldUntilAccepted, undefined, status);
    assert.deepEqual(out.carePlan.requestedExtras, EXTRAS, status);
  }
});

// ---------------------------------------------------------------------------------------------
// Real execution: the stay as the host reads it through GET /api/boarding-stays.

const HOST_EMAIL = "host.care@pawspace.test", HOST_ID = "host_maya_rohan";

async function hostWorld() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users(id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'service_provider','active',?,?)").run("U-host-care", HOST_EMAIL, "Host", now, now);
  sqlite.prepare("INSERT INTO provider_identity_links(email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(HOST_EMAIL, HOST_ID, now, now);
  const seed = await seedBoardingStay(db, sqlite, { providerId: HOST_ID, petCount: 2 });
  // DDL verbatim from app/api/canonical-bookings/route.ts, which owns canonical_pets.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const pet = sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,?,'verified',?,?)");
  pet.run("PET-BRUNO", seed.customerId, "Bruno", "dog", "Indie", now, now);
  pet.run("PET-MISTY", seed.customerId, "Misty", "cat", null, now, now);
  pet.run("PET-OTHER", "SOMEONE-ELSE", "Not yours", "dog", "Beagle", now, now);
  sqlite.prepare("UPDATE canonical_bookings SET pet_ids_json=? WHERE id=?").run(JSON.stringify(["PET-BRUNO", "PET-MISTY", "PET-OTHER"]), seed.bookingId);
  await mutateBoardingStay(db, { stayId: seed.stayId, action: "submit_care_plan", actorId: seed.customerId, idempotencyKey: nextKey("PARTNER-01"), carePlan: customerPlan() });
  const read = async (query = "") => {
    const response = await runWithWorkersDb(db, () => route.GET(new Request(`https://ops.pawspace.example/api/boarding-stays${query}`, { headers: { "oai-authenticated-user-email": HOST_EMAIL } })));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.data.length, 1);
    return body.data[0];
  };
  return { sqlite, db, seed, read };
}

test("the host's own stay read carries the pets, the care plan and the extras, and holds contacts until acceptance", async t => {
  const world = await hostWorld(); t.after(() => world.sqlite.close());

  const offered = await world.read();
  assert.equal(offered.status, "awaiting_host_acceptance");
  assert.deepEqual(offered.pets, [{ name: "Bruno", species: "dog", breed: "Indie" }, { name: "Misty", species: "cat", breed: null }], "only this customer's booked pets");
  assert.equal(offered.carePlan.plan.medication, "Half tablet Apoquel 16mg with breakfast");
  assert.equal(offered.carePlan.plan.feeding, "Two meals, 8am and 7pm");
  assert.match(offered.carePlan.plan.specialInstructions, /Crate at night/);
  assert.deepEqual(offered.carePlan.requestedExtras, EXTRAS);
  assert.equal(offered.carePlan.plan.emergencyContact, undefined);
  assert.equal(offered.carePlan.plan.vet, undefined);
  assert.deepEqual(offered.carePlan.withheldUntilAccepted, ["emergencyContact", "vet"]);
  assert.ok(!JSON.stringify(offered).includes("9800000001") && !JSON.stringify(offered).includes("9800000002"));
  assert.ok(!JSON.stringify(offered).includes("Not yours"));
  // Reading the same stay by booking ID is the same host read, so it gets the same gate, not the raw row.
  const byBooking = await world.read(`?bookingId=${encodeURIComponent(world.seed.bookingId)}`);
  assert.deepEqual(byBooking.carePlan, offered.carePlan);
  assert.equal(byBooking.pet_ids_json, undefined, "the projection, not the raw stay row");

  // The seeded payment is captured, so this is the real paid acceptance.
  const accepted = await mutateBoardingStay(world.db, { stayId: world.seed.stayId, action: "accept", actorId: HOST_ID, idempotencyKey: nextKey("PARTNER-01") });
  assert.equal(accepted.status, "confirmed");
  const confirmed = await world.read();
  assert.equal(confirmed.carePlan.plan.emergencyContact, EMERGENCY);
  assert.equal(confirmed.carePlan.plan.vet, VET);
  assert.equal(confirmed.carePlan.withheldUntilAccepted, undefined);
  assert.deepEqual(confirmed.carePlan.requestedExtras, EXTRAS);
  assert.equal(confirmed.pets.length, 2);
  assert.equal((await world.read(`?bookingId=${encodeURIComponent(world.seed.bookingId)}`)).carePlan.plan.vet, VET);
});

test("the partner job feed carries the Boarding extras the customer picked, and none of the plan's contacts", async t => {
  const world = await hostWorld(); t.after(() => world.sqlite.close());
  const feed = await listProviderJobs(world.db, HOST_ID);
  const jobs = [...feed.needsAction, ...feed.today, ...feed.upcoming, ...feed.completed];
  const job = jobs.find(item => item.bookingId === world.seed.bookingId);
  assert.ok(job, JSON.stringify(feed));
  assert.equal(job.serviceCode, "boarding");
  assert.deepEqual(job.addOns, EXTRAS);
  const serialized = JSON.stringify(feed);
  for (const secret of ["9800000001", "9800000002", "Cessna", "Apoquel"]) assert.ok(!serialized.includes(secret), `feed leaked ${secret}`);
});

test("a Boarding stay without a saved care plan still lists no extras rather than failing the feed", async t => {
  const sqlite = freshSqlite(), db = makeD1(sqlite); t.after(() => sqlite.close());
  const seed = await seedBoardingStay(db, sqlite, { bookingId: "BKG-NO-PLAN" });
  const feed = await listProviderJobs(db, "host_maya_rohan");
  const job = feed.needsAction.find(item => item.bookingId === seed.bookingId);
  assert.ok(job);
  assert.deepEqual(job.addOns, []);
});

// ---------------------------------------------------------------------------------------------
// Rendered: what the host actually reads in the workspace.

async function renderCare(stay) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: HostStayCare } = await import("../app/host/host-stay-care.tsx");
  return renderToStaticMarkup(React.createElement(HostStayCare, { stay })).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
/** The fields the host workspace reads, taken from the provider projection (as lib/boarding-stay-client.ts normalizes it). */
const workspaceStay = projected => ({ id: projected.id, booking_id: projected.bookingId, status: projected.status, pet_count: projected.petCount, pets: projected.pets, carePlan: projected.carePlan, events: [] });

test("the host workspace renders the pets, the care plan and the extras, with the contacts held back before acceptance", async () => {
  const text = await renderCare(workspaceStay(stayAt("awaiting_host_acceptance")));
  for (const shown of ["Pets coming", "Bruno · Dog · Indie", "Misty · Cat · Breed not provided", "Half tablet Apoquel 16mg with breakfast", "Two meals, 8am and 7pm", "Crate at night", ...EXTRAS]) assert.ok(text.includes(shown), `missing "${shown}": ${text}`);
  assert.match(text, new RegExp(`Emergency contact ${WITHHELD_NOTE}`));
  assert.match(text, new RegExp(`Vet ${WITHHELD_NOTE}`));
  for (const secret of ["9800000001", "9800000002", "4455"]) assert.ok(!text.includes(secret), `rendered ${secret}`);
});

test("after acceptance the host workspace renders the emergency contact and vet", async () => {
  const text = await renderCare(workspaceStay(stayAt("confirmed")));
  assert.ok(text.includes(EMERGENCY), text);
  assert.ok(text.includes(VET), text);
  assert.ok(!text.includes(WITHHELD_NOTE), text);
});

test("a stay whose customer has not shared the plan says so, and still names the pets", async () => {
  const text = await renderCare({ id: "S", booking_id: "B", status: "awaiting_host_acceptance", pet_count: 1, pets: [{ name: "Bruno", species: "dog", breed: "Indie" }], carePlan: null, events: [] });
  assert.match(text, /Bruno · Dog · Indie/);
  assert.match(text, /The customer has not shared the care plan yet/);
  assert.match(text, /No extras requested/);
});

test("the host page shows that card for the live stay and for the request being decided, and the jobs list shows Boarding extras", () => {
  const host = readFileSync(new URL("../app/host/page.tsx", import.meta.url), "utf8");
  assert.match(host, /<HostStayCare stay=\{liveStay\}\/>/);
  assert.match(host, /<HostStayCare stay=\{selected\}\/>/);
  assert.match(host, /petSummary\(liveStay\)/);
  const jobs = readFileSync(new URL("../app/partner/jobs/page.tsx", import.meta.url), "utf8");
  assert.match(jobs, /job\.serviceCode==="boarding"&&job\.addOns\.length\?/);
});
