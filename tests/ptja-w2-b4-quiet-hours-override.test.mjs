/**
 * The quiet-hours override: bounded, reasoned, single-attempt and audited. [PTJA-W2-B4-M06]
 *
 * WHAT WAS MEASURED. The clock stubbed to 03:00 IST, deep inside the 21:00-09:00 quiet window, with two
 * POSTs to /api/haptik-outbound as an admin holding marketing.manage:
 *
 *   (a) {campaign:"new_lead_followup", limit:5000}
 *       -> 201 {connected:true, dialled:0, reason:"Quiet hours (21:00-09:00 IST): no outbound calls
 *               placed. Pass force to override for an urgent callback."}   - refused at the gate
 *   (b) {campaign:"new_lead_followup", limit:5000, force:true}
 *       -> 201 with NO quiet-hours reason at all - the gate was passed and execution continued into the
 *               dial loop
 *
 * A request-body boolean turned off the bar on a FIVE THOUSAND contact lead-follow-up campaign, at three
 * in the morning, and the security audit row for it read outcome 'completed' with nothing saying an
 * override had been used. The earlier fix in this audit made the override auditable; it did not bound
 * it, and "an urgent callback" was left as a phrase in an error message rather than a rule.
 *
 * THE APPROVED RULE. An override is allowed only for a customer-requested callback at that specific
 * time, an active service safety incident, a provider or customer unable to access or complete an
 * imminent booking, a payment or booking failure affecting service within the next 12 hours, an active
 * relocation/travel/taxi movement, or an emergency escalation from an existing conversation. It is NOT
 * allowed for promotions, lead follow-ups, subscription sales, payment chasing unrelated to an imminent
 * service, or routine operations. It requires manager permission except for designated emergency roles,
 * a mandatory reason code AND a booking or case id, ONE call attempt initially, no bulk overrides, a
 * complete audit log, and compliance review of repeated overrides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_QUIET_DB__", "__PTJA_QUIET_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** 03:00 IST - the exact hour the defect was measured at. */
const QUIET_AT = Date.parse("2026-08-25T21:30:00.000Z");
const MANAGER = { email: "ops-manager@pawspace.test", roleCode: "manager", permissions: ["communications.manage", "marketing.manage"] };
const ASSOCIATE = { email: "associate@pawspace.test", roleCode: "associate", permissions: ["communications.call"] };
const SAFETY_LEAD = { email: "safety@pawspace.test", roleCode: "associate", permissions: ["communications.call", "incidents.respond"] };

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_QUIET_DB__ = db;
  globalThis.__PTJA_QUIET_ENV__ = {};
  const { ensureQuietHoursOverrideTables } = await import("../lib/quiet-hours-override.ts");
  await ensureQuietHoursOverrideTables(db);
  return { sqlite, db };
}

const request = async (w, input) => {
  const { requestQuietHoursOverride } = await import("../lib/quiet-hours-override.ts");
  return requestQuietHoursOverride(w.db, { actor: MANAGER, at: QUIET_AT, ...input });
};

const VALID = { reasonCode: "customer_requested_callback", caseReference: "BK-1", contactCount: 1,
  reason: "Customer asked us to ring back at 3am before their flight" };

test("M06-1: every approved reason code is accepted", async () => {
  const w = await world();
  for (const reasonCode of ["customer_requested_callback", "active_safety_incident", "imminent_booking_access_failure",
    "payment_or_booking_failure_within_12h", "active_relocation_or_transit", "emergency_escalation_existing_conversation"]) {
    const result = await request(w, { ...VALID, reasonCode, caseReference: `BK-${reasonCode}` });
    assert.equal(result.allowed, true, `${reasonCode} is an approved override reason: ${JSON.stringify(result)}`);
  }
});

test("M06-2: the reasons the policy forbids are refused by name", async () => {
  const w = await world();
  for (const reasonCode of ["promotion", "lead_followup", "subscription_sales", "payment_chasing", "routine_operations"]) {
    const result = await request(w, { ...VALID, reasonCode });
    assert.equal(result.allowed, false, `${reasonCode} must never override quiet hours`);
    assert.equal(result.reason, "reason_code_not_permitted");
  }
});

test("M06-3: an unknown reason code is refused, not waved through", async () => {
  // Absence of a rule is not permission. An override the policy has never heard of is not an emergency.
  const w = await world();
  const result = await request(w, { ...VALID, reasonCode: "seemed_important" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "reason_code_not_permitted");
});

test("M06-4: a booking or case reference is mandatory", async () => {
  const w = await world();
  const result = await request(w, { ...VALID, caseReference: "" });
  assert.equal(result.allowed, false, "an override that cannot be traced to a booking or case is not reviewable");
  assert.equal(result.reason, "case_reference_required");
});

test("M06-5: a free-text reason is mandatory alongside the code", async () => {
  const w = await world();
  const result = await request(w, { ...VALID, reason: "" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "reason_required");
});

test("M06-6: an override is ONE call attempt - a bulk campaign is refused", async () => {
  /*
   * The measured defect exactly: a five-thousand contact lead-follow-up campaign at three in the morning.
   * Even carrying a permitted reason code, a bulk override is not an override.
   */
  const w = await world();
  const result = await request(w, { ...VALID, contactCount: 5000 });
  assert.equal(result.allowed, false, "no bulk overrides");
  assert.equal(result.reason, "bulk_override_not_permitted");
  assert.equal(result.maxContacts, 1, "the limit is stated, so the refusal is actionable");
});

test("M06-7: manager permission is required, and a plain associate cannot override", async () => {
  const w = await world();
  const result = await request(w, { ...VALID, actor: ASSOCIATE });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "override_permission_required");
});

test("M06-8: a designated emergency role may override without manager permission", async () => {
  // The approved carve-out. Somebody responding to a safety incident at 3am should not need to find a
  // manager first - but only for the emergency reasons, which the next case pins.
  const w = await world();
  const result = await request(w, { ...VALID, actor: SAFETY_LEAD, reasonCode: "active_safety_incident" });
  assert.equal(result.allowed, true, `an emergency role may act: ${JSON.stringify(result)}`);
});

test("M06-9: the emergency carve-out does not extend to non-emergency reasons", async () => {
  // Otherwise "designated emergency role" would simply be a second manager permission.
  const w = await world();
  const result = await request(w, { ...VALID, actor: SAFETY_LEAD, reasonCode: "customer_requested_callback" });
  assert.equal(result.allowed, false, "an emergency role's licence is for emergencies");
  assert.equal(result.reason, "override_permission_required");
});

test("M06-10: outside quiet hours no override is needed at all", async () => {
  // Non-vacuity, and it matters: if the gate applied around the clock, ordinary daytime calling would
  // start requiring override paperwork and the whole control would be worked around.
  const w = await world();
  const daytime = await request(w, { ...VALID, reasonCode: "lead_followup", at: Date.parse("2026-08-25T09:30:00.000Z") });
  assert.equal(daytime.allowed, true, "14:00 IST is not quiet hours");
  assert.equal(daytime.reason, "not_quiet_hours");
  assert.equal(daytime.overrideUsed, false, "and nothing is recorded as an override, because none was used");
});

test("M06-11: every override is logged with actor, code, case, count and time", async () => {
  const w = await world();
  await request(w, VALID);
  const log = w.sqlite.prepare("SELECT actor_id,actor_role,reason_code,case_reference,reason,contact_count,created_at FROM quiet_hours_overrides ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(log.actor_id, "ops-manager@pawspace.test");
  assert.equal(log.actor_role, "manager");
  assert.equal(log.reason_code, "customer_requested_callback");
  assert.equal(log.case_reference, "BK-1");
  assert.match(String(log.reason), /before their flight/);
  assert.equal(log.contact_count, 1);
  assert.equal(log.created_at, QUIET_AT);
});

test("M06-12: a refused override is logged too", async () => {
  // A refusal is the more interesting record: it is the one that shows somebody tried.
  const w = await world();
  await request(w, { ...VALID, reasonCode: "promotion" });
  const log = w.sqlite.prepare("SELECT reason_code,allowed,refusal_reason FROM quiet_hours_overrides ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(log.reason_code, "promotion");
  assert.equal(log.allowed, 0);
  assert.equal(log.refusal_reason, "reason_code_not_permitted");
});

test("M06-13: repeated overrides are flagged for compliance review", async () => {
  const w = await world();
  const { quietHoursOverrideReview } = await import("../lib/quiet-hours-override.ts");
  for (let index = 0; index < 4; index += 1) {
    await request(w, { ...VALID, caseReference: `BK-${index}`, at: QUIET_AT + index * 60_000 });
  }
  const review = await quietHoursOverrideReview(w.db, { at: QUIET_AT + 5 * 60_000 });
  const actor = review.find((entry) => entry.actorId === "ops-manager@pawspace.test");
  assert.ok(actor, `a repeat overrider must surface for review: ${JSON.stringify(review)}`);
  assert.ok(actor.overrides >= 4);
  assert.equal(actor.reviewRequired, true);
});

test("M06-14: a single override does not trigger a compliance review", async () => {
  // Non-vacuity for the case above. A review queue that lists everybody is a queue nobody reads.
  const w = await world();
  const { quietHoursOverrideReview } = await import("../lib/quiet-hours-override.ts");
  await request(w, VALID);
  const review = await quietHoursOverrideReview(w.db, { at: QUIET_AT + 60_000 });
  assert.deepEqual(review.filter((entry) => entry.reviewRequired), []);
});

// =====================================================================================================
// The route the defect was measured on. A bounded library that the unbounded boolean still bypasses
// would leave the five-thousand contact 3am campaign exactly where it was found.
// =====================================================================================================

test("M06-15b: a permitted, single-contact override still reaches the campaign path", async () => {
  // Non-vacuity for the route case: if the gate refused everything, the urgent callback it exists to
  // permit would be impossible and staff would route around it.
  const w = await world();
  globalThis.__PTJA_QUIET_ENV__ = { HAPTIK_OUTBOUND_API_KEY: "scratch-not-a-real-key", HAPTIK_OUTBOUND_URL: "https://haptik.invalid/outbound" };
  const { requestQuietHoursOverride } = await import("../lib/quiet-hours-override.ts");
  const granted = await requestQuietHoursOverride(w.db, { actor: MANAGER, at: QUIET_AT,
    reasonCode: "customer_requested_callback", caseReference: "BK-77", reason: "Customer asked for a 3am callback", contactCount: 1 });
  assert.equal(granted.allowed, true, JSON.stringify(granted));
  assert.equal(granted.overrideUsed, true);
});

test("M06-15: the measured campaign can no longer be forced through quiet hours", async () => {
  /*
   * MEASURED before: POST /api/haptik-outbound {campaign:"new_lead_followup", limit:5000, force:true} at
   * 03:00 IST returned 201 with no quiet-hours reason - the gate was passed and execution continued into
   * the dial loop. `lead_followup` is now a named forbidden reason, so this cannot be forced at all, and
   * a bulk count of 5000 would be refused even under a permitted one.
   */
  const w = await world();
  const { requestQuietHoursOverride } = await import("../lib/quiet-hours-override.ts");

  const asMeasured = await requestQuietHoursOverride(w.db, { actor: MANAGER, at: QUIET_AT,
    reasonCode: "lead_followup", caseReference: "CAMPAIGN-1", reason: "New lead follow-up campaign", contactCount: 5000 });
  assert.equal(asMeasured.allowed, false, "the exact campaign measured is refused by reason code alone");
  assert.equal(asMeasured.reason, "reason_code_not_permitted");

  const withGoodReason = await requestQuietHoursOverride(w.db, { actor: MANAGER, at: QUIET_AT,
    reasonCode: "customer_requested_callback", caseReference: "BK-9", reason: "Customer asked for a 3am callback", contactCount: 5000 });
  assert.equal(withGoodReason.allowed, false, "and refused again on the count, even with a permitted reason");
  assert.equal(withGoodReason.reason, "bulk_override_not_permitted");
});

test("M06-16: the outbound route refuses a forced call that the policy does not permit", async () => {
  /*
   * The boundary is stubbed exactly as the original finding stubbed it: HAPTIK_OUTBOUND_API_KEY and
   * HAPTIK_OUTBOUND_URL set to non-routable scratch values so haptikOutboundConfigured(env) is true and
   * the QUIET-HOURS gate is what the request lands on, rather than the not-connected refusal. A first
   * version of this case omitted them, so reverting the route still passed - it was measuring the
   * missing API key, not the override. Sabotage caught it.
   */
  const w = await world();
  globalThis.__PTJA_QUIET_ENV__ = { HAPTIK_OUTBOUND_API_KEY: "scratch-not-a-real-key", HAPTIK_OUTBOUND_URL: "https://haptik.invalid/outbound" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(w.db);
  const now = Date.now();
  await w.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-QH','ops-admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();

  // The clock is stubbed to 03:00 IST, exactly as the finding stubbed it, because the route reads the
  // real time and the quiet-hours gate is the whole point of the case.
  const route = await import("../app/api/haptik-outbound/route.ts");
  const realNow = Date.now;
  Date.now = () => QUIET_AT;
  let response, body;
  try {
    response = await route.POST(new Request("https://uat.pawspace.in/api/haptik-outbound", {
      method: "POST",
      headers: { "content-type": "application/json", "oai-authenticated-user-email": "ops-admin@pawspace.test" },
      body: JSON.stringify({ campaign: "new_lead_followup", limit: 5000, force: true, reasonCode: "lead_followup", caseReference: "C-1", reason: "campaign" }),
    }));
    body = await response.json().catch(() => null);
  } finally { Date.now = realNow; }

  assert.equal(response.status, 409, `a forbidden reason must be refused at the override gate: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  assert.equal(body?.code, "reason_code_not_permitted");
  assert.equal(body?.maxContactsPerOverride, 1, "and the refusal states the single-attempt limit");
});
