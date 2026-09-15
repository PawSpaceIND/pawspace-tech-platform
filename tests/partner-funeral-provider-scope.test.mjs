/*
 * /partner/funeral answered "Permission denied" to every provider that opened it.
 *
 * The screen lives in the partner namespace, is titled "Assigned service requests", and offers a
 * funeral coordinator their milestones. But GET /api/funeral-memorial's list branch demanded
 * customers.view, and every write the screen issues - coordinate_pickup, complete_milestone,
 * register_media, update_ash_collection, close_case - fell through to bookings.manage. The
 * service_provider role holds neither, so the whole screen was staff-only by accident: the route was
 * never wired as provider-scoped at all, and /api/funeral-memorial was the one partner-facing path
 * missing from PROVIDER_SCOPED_API_PATHS.
 *
 * The fix is a SCOPE, not wider permissions. `scope=provider` mirrors the customer surface's
 * `scope=customer`: the coordinator is resolved from their own identity binding and sees only the
 * cases assigned to them, and each coordination write is checked against the provider the CASE names
 * through requireProviderOwnership - the same subject binding every other provider route uses.
 *
 * Driven through the real route handlers with a real provider platform session, so it fails if any
 * link in resolveActor -> binding -> ownership changes shape, not only if this route does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PARTNER_FUNERAL_DB__");

const MINE = "prv_funeral_coord", THEIRS = "prv_other_coord", VENDOR = "prv_crematorium";
const OPS_EMAIL = "ops@pawspace.in";
const NOW = Date.now();

/** A provider platform session cookie, issued the way the partner login issues one. */
async function providerSession(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: `uat-provider:${providerId}`,
    subjectType: "provider", subjectId: providerId, actorId: "test", reason: "partner funeral scope fixture",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: `uat-provider:${providerId}`, subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function fixture() {
  const { sqlite, db } = world("__PARTNER_FUNERAL_DB__", "__PARTNER_FUNERAL_DB___ENV", {});
  const auth = await import("../lib/server-auth.ts");
  const governance = await import("../lib/funeral-memorial-governance.ts");
  const { ensurePlatformSessionTables } = await import("../lib/platform-session.ts");
  await auth.ensureSecurityTables(db);
  await ensurePlatformSessionTables(db);
  await governance.ensureFuneralMemorialTables(db);
  await seedActors(sqlite, db, [{ id: "U-OPS", email: OPS_EMAIL, role: "manager" }]);

  const addCase = (id, over = {}) => {
    const row = { customer_id: "cust_1", pet_name: "Simba", pet_species: "dog", pickup_address: "12 MG Road",
      service_type: "cremation", memorial_option: "ash_collection", status: "pickup_pending",
      assigned_agent_id: null, vendor_id: null, ...over };
    sqlite.prepare("INSERT INTO funeral_cases (id,customer_id,pet_name,pet_species,pickup_address,alternate_contact,service_type,memorial_option,urgency,status,assigned_agent_id,vendor_id,support_status,certificate_status,closure_note,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?,'urgent',?,?,?,'none','not_issued',NULL,?,?)")
      .run(id, row.customer_id, row.pet_name, row.pet_species, row.pickup_address, row.service_type, row.memorial_option, row.status, row.assigned_agent_id, row.vendor_id, NOW, NOW);
    for (const code of ["request_received", "pickup_coordinated", "pickup_complete", "ritual_scheduled", "ritual_complete", "ash_collection_ready", "ash_collected", "memorial_record_created", "closure_confirmed"]) {
      sqlite.prepare("INSERT OR IGNORE INTO funeral_milestones (id,case_id,code,status,updated_at) VALUES (?,?,?,'pending',?)").run(`${id}-${code}`, id, code, NOW);
    }
    sqlite.prepare("INSERT OR IGNORE INTO funeral_ash_collection (id,case_id,preferred_at,status,note,updated_at) VALUES (?,?,NULL,'requested',NULL,?)").run(`${id}-ash`, id, NOW);
    return id;
  };
  addCase("FNL-MINE", { assigned_agent_id: MINE });
  addCase("FNL-VENDOR", { vendor_id: VENDOR });
  addCase("FNL-THEIRS", { assigned_agent_id: THEIRS });
  addCase("FNL-UNASSIGNED");
  return { sqlite, db };
}

const get = async (path, cookie) => {
  const { GET } = await import("../app/api/funeral-memorial/route.ts");
  return GET(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }));
};
const post = async (body, cookie, email) => {
  const { POST } = await import("../app/api/funeral-memorial/route.ts");
  return POST(new Request(`${ORIGIN}/api/funeral-memorial`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(email ? { "oai-authenticated-user-email": email } : {}) },
    body: JSON.stringify(body),
  }));
};

// --- the queue ------------------------------------------------------------------------------------

test("FNL-P1 an assigned coordinator gets their own queue instead of a 403", async () => {
  const { db } = await fixture();
  const cookie = await providerSession(db, MINE);
  const response = await get("/api/funeral-memorial?scope=provider", cookie);
  const body = await response.json();
  assert.equal(response.status, 200, `the partner screen's read must succeed: ${JSON.stringify(body)}`);
  assert.deepEqual(body.data.map((item) => item.id), ["FNL-MINE"], "and it must be THEIR queue, not the roster");
});

test("FNL-P2 a vendor slot is an assignment too", async () => {
  const { db } = await fixture();
  const response = await get("/api/funeral-memorial?scope=provider", await providerSession(db, VENDOR));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.map((item) => item.id), ["FNL-VENDOR"]);
});

test("FNL-P3 the scope is a scope: nobody sees another coordinator's cases, or an unassigned one", async () => {
  const { db } = await fixture();
  const body = await (await get("/api/funeral-memorial?scope=provider", await providerSession(db, THEIRS))).json();
  assert.deepEqual(body.data.map((item) => item.id), ["FNL-THEIRS"]);
  assert.ok(!JSON.stringify(body.data).includes("FNL-UNASSIGNED"), "an unassigned case belongs to no coordinator");
});

test("FNL-P4 a provider cannot pass someone else's providerId to widen the scope", async () => {
  const { db } = await fixture();
  const response = await get(`/api/funeral-memorial?scope=provider&providerId=${THEIRS}`, await providerSession(db, MINE));
  assert.equal(response.status, 403, "requireProviderOwnership must refuse a subject this session is not bound to");
});

test("FNL-P5 the unscoped staff listing is unchanged and still closed to providers", async () => {
  const { db } = await fixture();
  const providerView = await get("/api/funeral-memorial", await providerSession(db, MINE));
  assert.equal(providerView.status, 403, "the ops listing still needs customers.view");

  const opsView = await get("/api/funeral-memorial", undefined);
  assert.equal(opsView.status, 401, "with no identity at all nothing is listed");
});

test("FNL-P6 a single case reads back under the provider scope, and only for its own coordinator", async () => {
  const { db } = await fixture();
  const mine = await get("/api/funeral-memorial?scope=provider&caseId=FNL-MINE", await providerSession(db, MINE));
  assert.equal(mine.status, 200, await mine.clone().text());
  assert.equal((await mine.json()).data.id, "FNL-MINE");

  const theirs = await get("/api/funeral-memorial?scope=provider&caseId=FNL-THEIRS", await providerSession(db, MINE));
  assert.equal(theirs.status, 403);
});

// --- the milestones the screen drives -------------------------------------------------------------

test("FNL-P7 the coordinator can run every action the partner screen offers, on their own case", async () => {
  const { sqlite, db } = await fixture();
  const cookie = await providerSession(db, MINE);
  for (const body of [
    { action: "coordinate_pickup", caseId: "FNL-MINE", note: "UAT pickup coordinated by service partner" },
    { action: "complete_milestone", caseId: "FNL-MINE", milestoneCode: "pickup_complete", note: "UAT pickup completed" },
    { action: "register_media", caseId: "FNL-MINE", mediaType: "photo", objectId: "uat-partner-photo-1", note: "Partner UAT photo metadata" },
    { action: "complete_milestone", caseId: "FNL-MINE", milestoneCode: "ritual_scheduled", note: "UAT ritual scheduled" },
    { action: "complete_milestone", caseId: "FNL-MINE", milestoneCode: "ritual_complete", note: "UAT ritual completed" },
    { action: "update_ash_collection", caseId: "FNL-MINE", ashStatus: "ready", note: "Ash collection ready in UAT" },
    { action: "update_ash_collection", caseId: "FNL-MINE", ashStatus: "collected", note: "Ash collection completed in UAT" },
  ]) {
    const response = await post(body, cookie);
    assert.equal(response.status, 200, `${body.action} must succeed for the assigned coordinator: ${await response.clone().text()}`);
  }
  assert.equal(sqlite.prepare("SELECT status FROM funeral_milestones WHERE case_id='FNL-MINE' AND code='pickup_complete'").get().status, "complete",
    "the milestone must actually be recorded, not merely permitted");
  assert.equal(sqlite.prepare("SELECT status FROM funeral_ash_collection WHERE case_id='FNL-MINE'").get().status, "collected");

  // close_case is the eighth button. It carries a FINANCE precondition of its own (paid customer
  // funds, an assigned vendor and an explicit vendor cost), which no coordinator can satisfy and
  // which this fix does not touch. What matters here is that the coordinator now reaches that rule
  // instead of being turned away at the permission gate: 409, not 403.
  const closure = await post({ action: "close_case", caseId: "FNL-MINE", closureNote: "UAT service closure confirmed by assigned coordinator" }, cookie);
  assert.equal(closure.status, 409, `close_case must reach its own governance rule, not a permission refusal: ${await closure.clone().text()}`);
});

test("FNL-P8 a coordinator cannot drive a case that is not theirs", async () => {
  const { sqlite, db } = await fixture();
  const cookie = await providerSession(db, MINE);
  for (const caseId of ["FNL-THEIRS", "FNL-UNASSIGNED"]) {
    const response = await post({ action: "complete_milestone", caseId, milestoneCode: "pickup_complete" }, cookie);
    assert.equal(response.status, 403, `${caseId} must be refused`);
  }
  assert.equal(sqlite.prepare("SELECT status FROM funeral_milestones WHERE case_id='FNL-THEIRS' AND code='pickup_complete'").get().status, "pending",
    "a refused write must change nothing");
});

test("FNL-P9 the scope does not hand a coordinator the customer, finance or ops actions", async () => {
  const { db } = await fixture();
  const cookie = await providerSession(db, MINE);
  for (const body of [
    { action: "qualify", caseId: "FNL-MINE", agentId: MINE },
    { action: "assign_vendor", caseId: "FNL-MINE", vendorId: MINE },
    { action: "set_service_amount", caseId: "FNL-MINE", amount: 5000 },
    { action: "request_refund", caseId: "FNL-MINE", refundAmount: 100, reason: "test" },
    { action: "save_service_config", serviceType: "cremation", enabled: true },
  ]) {
    const response = await post(body, cookie);
    assert.ok(response.status === 403 || response.status === 409, `${body.action} must not become a partner action (got ${response.status})`);
  }
});

test("FNL-P10 staff authority over these actions is unchanged", async () => {
  await fixture();
  const response = await post({ action: "complete_milestone", caseId: "FNL-UNASSIGNED", milestoneCode: "pickup_complete" }, undefined, OPS_EMAIL);
  assert.equal(response.status, 200, `bookings.manage must still carry the coordination actions outright: ${await response.clone().text()}`);
});

// --- the wiring -----------------------------------------------------------------------------------

test("FNL-P11 /api/funeral-memorial is registered as provider-scoped", async () => {
  // Without this a partner presenting the credential the partner login just issued is shadowed by a
  // staff cookie on this route, which is the same 403 by a different mechanism.
  const { providerScopedRequest } = await import("../lib/server-auth.ts");
  assert.equal(providerScopedRequest(new Request(`${ORIGIN}/api/funeral-memorial`)), true);
});

test("FNL-P12 the partner screen reads the provider scope, not the staff listing", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../app/partner/funeral/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("scope=provider"), "the partner screen must ask for its own queue");
  const code = page.split("\n").filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*")).join("\n");
  assert.ok(!code.includes("loadFuneralStaff"), "the staff-scoped reader must not be imported or called from a partner screen");
});
