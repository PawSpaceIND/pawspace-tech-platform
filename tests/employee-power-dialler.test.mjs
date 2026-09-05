import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1 } from "./helpers/voice-harness.mjs";

installWorkersHooks("__DIAL_DB__", "__DIAL_ENV__");
const dialler = await import("../lib/employee-power-dialler.ts");

const ACTOR = "agent@pawspace.in";
const PHONE1 = "+919876543210";
const PHONE2 = "+919876543211";

function istAt(hour, minute = 0) {
  return Date.UTC(2026, 8, 15, hour, minute, 0) - 330 * 60_000;
}

function env(extra = {}) {
  return {
    PAWSPACE_DIALLER_ENV: "uat",
    PAWSPACE_DIALLER_UAT_APPROVED: "true",
    PAWSPACE_DIALLER_AGENT_MAP_JSON: JSON.stringify({ [ACTOR]: "+919999999999" }),
    PAWSPACE_DIALLER_UAT_CUSTOMER_ALLOWLIST: `${PHONE1},${PHONE2}`,
    PAWSPACE_DIALLER_STATUS_CALLBACK_URL: "https://uat.pawspace.in/api/dialler/callback",
    EXOTEL_API_KEY: "test-key",
    EXOTEL_API_TOKEN: "test-token",
    EXOTEL_SID: "test-sid",
    EXOTEL_WEBHOOK_SECRET: "test-webhook-secret",
    EXOTEL_PROMO_CALLER_ID: "1401234567",
    EXOTEL_SERVICE_CALLER_ID: "1601234567",
    ...extra,
  };
}

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const now = istAt(12);
  sqlite.exec(`
    CREATE TABLE lead_work_items (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL,
      owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1',
      work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL,
      manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0,
      whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER,
      recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_customers (
      id TEXT PRIMARY KEY, city_id TEXT NOT NULL, name TEXT NOT NULL, primary_phone TEXT NOT NULL,
      secondary_phone TEXT, email TEXT, consent_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT,
      area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT, owner TEXT, source TEXT, lifetime_value REAL DEFAULT 0,
      next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_pets (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT NOT NULL, species TEXT NOT NULL,
      breed TEXT, vaccination_status TEXT DEFAULT 'not_provided', source_pet_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_bookings (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, service_code TEXT, scheduled_start TEXT, status TEXT,
      total_amount REAL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE lead_attempts (
      id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, channel TEXT NOT NULL, sequence_number INTEGER NOT NULL,
      outcome TEXT NOT NULL, note TEXT, provider_status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE crm_activities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE crm_tasks (id TEXT PRIMARY KEY, contact_id TEXT, title TEXT NOT NULL, owner TEXT NOT NULL, due_at INTEGER, priority TEXT, status TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE communication_messages (
      id TEXT PRIMARY KEY, thread_id TEXT, customer_id TEXT, booking_id TEXT, lead_id TEXT, ticket_id TEXT,
      direction TEXT, channel TEXT, purpose TEXT, template_key TEXT, payload_json TEXT, status TEXT, provider TEXT,
      provider_reference TEXT, idempotency_key TEXT, policy_json TEXT, created_at INTEGER
    );
    CREATE TABLE revenue_opportunities (
      id TEXT PRIMARY KEY, opportunity_date TEXT NOT NULL, customer_id TEXT NOT NULL, lead_id TEXT, booking_id TEXT,
      opportunity_type TEXT NOT NULL, reason TEXT NOT NULL, score INTEGER NOT NULL, rank INTEGER NOT NULL,
      expected_revenue REAL NOT NULL, margin_percent REAL NOT NULL, suggested_offer TEXT NOT NULL,
      preferred_channel TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', due_at INTEGER NOT NULL,
      signals_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  function seedLead({ id, customerId, phone, score, optOut = 0, service = "grooming" }) {
    sqlite.prepare("INSERT INTO canonical_customers VALUES (?,?,?,?,?,?,?,?,?)").run(customerId, "blr", `Customer ${id}`, phone, null, `${id.toLowerCase()}@example.com`, "{}", now, now);
    sqlite.prepare("INSERT INTO crm_contacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(customerId, `Customer ${id}`, phone, null, `${id.toLowerCase()}@example.com`, "Bengaluru", "Buddy", "Buddy, Labrador, 3 years", "Qualified", ACTOR, "test", 12000, "Call customer", "", now, now);
    sqlite.prepare("INSERT INTO canonical_pets VALUES (?,?,?,?,?,?,?,?,?)").run(`PET-${id}`, customerId, "Buddy", "dog", "Labrador", "verified", null, now, now);
    sqlite.prepare("INSERT INTO lead_work_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, customerId, "test", service, ACTOR, "manager@pawspace.in", "active", "day_1", 1, now, now, now, null, 0, 0, null, null, null, 0, optOut, null, now, now);
    sqlite.prepare("INSERT INTO lead_scores (lead_id,engagement_score,profile_score,recency_score,value_score,total_score,grade,factors_json,computed_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, 80, 90, 95, 90, score, score >= 85 ? "A" : "B", JSON.stringify({ historicalValue: 12000 }), now);
  }
  return { sqlite, db, seedLead, now };
}

function mockExotel(expectedTo) {
  let calls = 0;
  const fetcher = async (_url, init) => {
    calls++;
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("From"), "+919999999999");
    assert.equal(form.get("To"), expectedTo);
    assert.equal(form.get("CallerId"), "1401234567");
    assert.match(form.get("StatusCallback") || "", /\/api\/dialler\/callback$/);
    assert.ok(form.get("CustomField"));
    return new Response(JSON.stringify({ Call: { Sid: `EXO-${calls}`, Status: "initiated" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher, calls: () => calls };
}

test("employee dialler fails closed outside the 09:00-21:00 IST calling window", async () => {
  const { db, seedLead } = world();
  await dialler.ensureEmployeeDiallerTables(db);
  seedLead({ id: "LEAD-1", customerId: "CUST-1", phone: PHONE1, score: 95 });
  let contacted = false;
  await assert.rejects(
    () => dialler.startNextDiallerCall(db, env(), { actorEmail: ACTOR, asOf: istAt(21, 1), fetcher: async () => { contacted = true; throw new Error("must not run"); } }),
    error => error?.code === "outside_calling_window",
  );
  assert.equal(contacted, false);
  assert.equal(Number((await db.prepare("SELECT COUNT(*) n FROM employee_dialler_calls").first()).n), 0);
});

test("NCPR/DND lead without newer verified consent is dropped and the next eligible Score 80+ lead is dialled", async () => {
  const { db, seedLead } = world();
  await dialler.ensureEmployeeDiallerTables(db);
  seedLead({ id: "LEAD-DND", customerId: "CUST-DND", phone: PHONE1, score: 98 });
  seedLead({ id: "LEAD-CLEAR", customerId: "CUST-CLEAR", phone: PHONE2, score: 91 });
  await dialler.upsertDiallerCompliance(db, { phone: PHONE1, ncprDnd: true, source: "ncpr_sync", reason: "registered preference", asOf: istAt(11) });
  const exotel = mockExotel(PHONE2);
  const result = await dialler.startNextDiallerCall(db, env(), { actorEmail: ACTOR, asOf: istAt(14), fetcher: exotel.fetcher });
  assert.equal(result.call.leadId, "LEAD-CLEAR");
  assert.equal(exotel.calls(), 1);
  const skip = await db.prepare("SELECT reason_code FROM employee_dialler_queue_skips WHERE lead_id='LEAD-DND' ORDER BY created_at DESC LIMIT 1").first();
  assert.equal(skip.reason_code, "ncpr_dnd");
});

test("verified digital consent newer than a DND flag allows the otherwise suppressed lead", async () => {
  const { db, seedLead } = world();
  await dialler.ensureEmployeeDiallerTables(db);
  seedLead({ id: "LEAD-CONSENT", customerId: "CUST-CONSENT", phone: PHONE1, score: 96 });
  await dialler.upsertDiallerCompliance(db, { phone: PHONE1, ncprDnd: true, source: "ncpr_sync", asOf: istAt(10) });
  await dialler.recordDiallerConsent(db, { phone: PHONE1, source: "customer_web_form", evidenceRef: "CONSENT-EVIDENCE-1", purpose: "voice_marketing", granted: true, verified: true, capturedAt: istAt(11) });
  const exotel = mockExotel(PHONE1);
  const result = await dialler.startNextDiallerCall(db, env(), { actorEmail: ACTOR, asOf: istAt(14), fetcher: exotel.fetcher });
  assert.equal(result.call.leadId, "LEAD-CONSENT");
});

test("authenticated Exotel callback transitions call state and stores duration and recording URL", async () => {
  const { db, seedLead } = world();
  await dialler.ensureEmployeeDiallerTables(db);
  seedLead({ id: "LEAD-CB", customerId: "CUST-CB", phone: PHONE1, score: 96 });
  const exotel = mockExotel(PHONE1);
  const started = await dialler.startNextDiallerCall(db, env(), { actorEmail: ACTOR, asOf: istAt(14), fetcher: exotel.fetcher });
  const rawBody = new URLSearchParams({ CallSid: "EXO-1", CallStatus: "completed", CustomField: started.call.id, Duration: "42", RecordingUrl: "https://recordings.example.test/call.mp3" }).toString();
  const headers = new Headers({ authorization: `Basic ${btoa("exotel:test-webhook-secret")}` });
  const result = await dialler.applyDiallerCallback(db, env(), { rawBody, headers, asOf: istAt(14, 5) });
  assert.equal(result.call.state, "call_ended");
  assert.equal(result.call.outcome, "completed");
  assert.equal(result.call.durationSeconds, 42);
  assert.equal(result.call.recordingUrl, "https://recordings.example.test/call.mp3");
  const stored = await db.prepare("SELECT duration_seconds,recording_url FROM employee_dialler_calls WHERE id=?").bind(started.call.id).first();
  assert.equal(Number(stored.duration_seconds), 42);
  assert.equal(stored.recording_url, "https://recordings.example.test/call.mp3");
});

test("disposition updates CRM feedback and the next dial advances to the next prioritized customer", async () => {
  const { db, seedLead } = world();
  await dialler.ensureEmployeeDiallerTables(db);
  seedLead({ id: "LEAD-A", customerId: "CUST-A", phone: PHONE1, score: 97 });
  seedLead({ id: "LEAD-B", customerId: "CUST-B", phone: PHONE2, score: 90 });
  const exotel1 = mockExotel(PHONE1);
  const first = await dialler.startNextDiallerCall(db, env(), { actorEmail: ACTOR, asOf: istAt(14), fetcher: exotel1.fetcher });
  await db.prepare("UPDATE employee_dialler_calls SET state='call_ended',outcome='completed',ended_at=?,updated_at=? WHERE id=?").bind(istAt(14, 10), istAt(14, 10), first.call.id).run();
  await dialler.submitDiallerDisposition(db, { callId: first.call.id, actorEmail: ACTOR, disposition: "Interested", note: "Wants grooming next week", asOf: istAt(14, 11) });
  const attempt = await db.prepare("SELECT outcome FROM lead_attempts WHERE lead_id='LEAD-A' ORDER BY created_at DESC LIMIT 1").first();
  assert.equal(attempt.outcome, "Interested");
  const exotel2 = mockExotel(PHONE2);
  const next = await dialler.startNextDiallerCall(db, env(), { actorEmail: ACTOR, asOf: istAt(14, 12), fetcher: exotel2.fetcher });
  assert.equal(next.call.leadId, "LEAD-B");
});
