import test from "node:test";
import assert from "node:assert/strict";
import {
  projectTrainerSession, projectTrainingSessionEvent, sanitizeTrainingEventDetail,
} from "../lib/training-provider-projection.ts";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TRAINING_PROJECTION_DB__", "__TRAINING_PROJECTION_ENV__");
const SECRET = "synthetic@example.invalid";
const STAFF_NOTE = "Private internal assessment";
const REF = "media://asset/MA-PROJECTION-1";

test("trainer projection preserves required operational fields and masks no ownership check", () => {
  const out = projectTrainerSession({ id: "TS-1", customer_name: "S***", customer_id: "CUS-1",
    provider_id: "PRV-1", staff_email: SECRET, notes: STAFF_NOTE, petIds: ["PET-1"],
    requirements: ["Recall practice", SECRET, "a".repeat(241)], evidenceRefs: [REF] });
  assert.equal(out.id, "TS-1"); assert.equal(out.customer_name, "S***");
  assert.equal(out.provider_id, "PRV-1"); assert.deepEqual(out.petIds, ["PET-1"]);
  assert.deepEqual(out.requirements, ["Recall practice"]); assert.deepEqual(out.evidenceRefs, [REF]);
  assert.equal(out.staff_email, undefined); assert.equal(out.notes, undefined);
});

test("attendance accepts only the three trainer-editor fields, never raw contacts or notes", () => {
  const out = projectTrainerSession({ attendance: { mode: "parent", safeAreaConfirmed: true,
    parentOrCaretakerConfirmed: false, staffEmail: SECRET, internalNote: STAFF_NOTE, phone: 9876543210 } });
  assert.deepEqual(out.attendance, { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: false });
});

test("progress retains known 1-10 numeric scores and rejects unknown or malformed fields", () => {
  const out = projectTrainerSession({ progress: { focus: 7, recall: 8, impulse: 9, parent: 10,
    contactEmail: SECRET, staffPhone: 9876543210, internalScore: 5 } });
  assert.deepEqual(out.progress, { focus: 7, recall: 8, impulse: 9, parent: 10 });
  for (const score of [NaN, Infinity, -1, 0, 11, "7", true, {}]) {
    assert.deepEqual(projectTrainerSession({ progress: { focus: score } }).progress, {});
  }
});

test("homework retains intended text, not internal fields", () => {
  const out = projectTrainerSession({ homework: { text: "Practice recall daily", internalNote: STAFF_NOTE, staffEmail: SECRET } });
  assert.deepEqual(out.homework, { text: "Practice recall daily" });
  const longAssignment = "Practice recall in short positive sessions. ".repeat(12);
  assert.deepEqual(projectTrainerSession({ homework: { text: longAssignment } }).homework, { text: longAssignment });
  for (const text of [SECRET, "Call 9876543210", { internalNote: STAFF_NOTE }]) {
    assert.deepEqual(projectTrainerSession({ homework: { text } }).homework, {});
  }
});

test("operational event objects use exact per-object field allowlists", () => {
  const out = sanitizeTrainingEventDetail({
    from: "in_session", to: "completed", consumedExactlyOnce: true, ownerHandoverMinutes: 15,
    nextSession: { sessionId: "TS-2", sequenceNo: 2, status: "scheduled", internalNote: STAFF_NOTE },
    programme: { total: 4, completed: 1, noShow: 0, cancelled: 0, status: "in_progress", terminal: false,
      internalNote: STAFF_NOTE, staffEmail: SECRET, contactNumber: 9876543210 },
    closure: { certificateNumber: "PS-TRN-123", reviewDispatched: true, reason: STAFF_NOTE },
    reason: STAFF_NOTE, actor_id: SECRET, detail_json: SECRET,
  });
  assert.deepEqual(out.nextSession, { sessionId: "TS-2", sequenceNo: 2, status: "scheduled" });
  assert.deepEqual(out.programme, { total: 4, completed: 1, noShow: 0, cancelled: 0, status: "in_progress", terminal: false });
  assert.deepEqual(out.closure, { certificateNumber: "PS-TRN-123", reviewDispatched: true });
  assert.equal(out.consumedExactlyOnce, true); assert.equal(out.ownerHandoverMinutes, 15);
  assert.equal(out.from, "in_session"); assert.equal(out.to, "completed");
  assert.equal(out.reason, undefined); assert.equal(out.actor_id, undefined); assert.equal(out.detail_json, undefined);
});

test("event values cannot smuggle objects/arrays into scalar fields", () => {
  const out = sanitizeTrainingEventDetail({ status: { secret: SECRET }, action: [STAFF_NOTE],
    distanceMeters: SECRET, thresholdMeters: Infinity, consumedExactlyOnce: "true",
    nextSession: [STAFF_NOTE], programme: { total: "4", terminal: "false" }, closure: null });
  assert.deepEqual(out, { nextSession: {}, programme: {}, closure: null });
});

test("root and event evidence refs are opaque media refs, not signed URLs or contact strings", () => {
  const refs = [REF, SECRET, "https://files.example.invalid/asset?signature=private", "media://asset/a?secret=x", null, 9];
  assert.deepEqual(projectTrainerSession({ evidenceRefs: refs }).evidenceRefs, [REF]);
  assert.deepEqual(sanitizeTrainingEventDetail({ evidenceRefs: refs }).evidenceRefs, [REF]);
});

test("raw DB event columns are transformed and actor identity is never returned", () => {
  const out = projectTrainingSessionEvent({ event_type: "complete", actor_id: SECRET, created_at: 123,
    detail_json: JSON.stringify({ from: "in_session", to: "completed", code: "complete", internalNote: STAFF_NOTE }) });
  assert.deepEqual(out, { eventType: "complete", actorId: "provider_or_system",
    detail: { from: "in_session", to: "completed", code: "complete" }, createdAt: 123 });
  assert.equal(out.actor_id, undefined); assert.equal(out.detail_json, undefined);
});

test("malformed JSON, nulls and arrays produce safe empty projections", () => {
  for (const value of [null, undefined, 7, true, [], "not-json"]) {
    assert.deepEqual(sanitizeTrainingEventDetail(value), {});
    assert.deepEqual(projectTrainerSession({ attendance: value, progress: value, homework: value }).attendance, {});
    assert.deepEqual(projectTrainingSessionEvent({ detail_json: value }).detail, {});
  }
  for (const value of ["{", "[]", "null", "42"]) assert.deepEqual(projectTrainingSessionEvent({ detail_json: value }).detail, {});
  assert.deepEqual(projectTrainerSession({ attendance: { mode: "unknown", safeAreaConfirmed: "true" } }).attendance, {});
  assert.doesNotThrow(() => projectTrainerSession({ events: [null, false, 7] }));
});

test("projection does not mutate the authoritative stored row", () => {
  const input = { attendance: { mode: "trainer_led", staffEmail: SECRET }, progress: { focus: 8, contactEmail: SECRET },
    events: [{ detail_json: { programme: { status: "scheduled", internalNote: STAFF_NOTE } } }] };
  const before = structuredClone(input);
  const out = projectTrainerSession(input);
  assert.deepEqual(input, before);
  out.attendance.mode = "parent";
  assert.equal(input.attendance.mode, "trainer_led");
});

async function routeWorld(t) {
  // Real handler + SQL + provider authorization, never the localhost preview superuser.
  const { sqlite, db } = world("__TRAINING_PROJECTION_DB__", "__TRAINING_PROJECTION_ENV__", {
    PAWSPACE_LOCAL_PREVIEW: "off", PAWSPACE_UAT_LOGIN: "off", PAWSPACE_DEPLOYMENT_ENV: "staging",
    PAWSPACE_WORKSPACE_IDENTITY_TRUST: "openai-dispatch", PAWSPACE_PAYMENT_ENV: "sandbox",
  });
  t.after(() => sqlite.close());
  await seedActors(sqlite, db, [{ id: "TRN-USER", email: "trainer@example.invalid", role: "service_provider" }]);
  sqlite.prepare("INSERT INTO provider_identity_links(email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',1,1)")
    .run("trainer@example.invalid", "PRV-1");
  const { ensureTrainingSessionLifecycleTables } = await import("../lib/training-session-lifecycle.ts");
  await ensureTrainingSessionLifecycleTables(db);
  // Only the customer display join is needed; this fixture contains no real customer data.
  sqlite.exec("CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,name TEXT)");
  sqlite.prepare("INSERT INTO canonical_customers VALUES (?,?)").run("CUS-1", "Synthetic Customer");
  sqlite.prepare("INSERT INTO training_programmes(id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,total_sessions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,4,1,1)")
    .run("TP-1", "BK-1", "CUS-1", "PRV-1", "blr", "blr-east", "training-4-puppy", "Puppy Training Plan", '["PET-1"]');
  sqlite.prepare("INSERT INTO training_sessions(id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,attendance_json,homework_json,progress_json,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,?,?,1,1)")
    .run("TS-1", "TP-1", "BK-1", "RES-1", "PRV-1", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z",
      JSON.stringify({ mode: "parent", staffEmail: SECRET }), JSON.stringify({ text: "Practice recall daily", internalNote: STAFF_NOTE }),
      JSON.stringify({ focus: 7, contactEmail: SECRET }));
  sqlite.prepare("INSERT INTO training_session_events(id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,1)")
    .run("EV-1", "TS-1", "TP-1", "BK-1", "complete", SECRET, "IDEM-1",
      JSON.stringify({ programme: { status: "scheduled", internalNote: STAFF_NOTE } }));
  return { sqlite, db, GET: (await import("../app/api/training-sessions/route.ts")).GET };
}

test("GET actually projects a real trainer-owned SQL row and event, retaining masked customer display", async (t) => {
  const { GET } = await routeWorld(t);
  const response = await GET(asActor("trainer@example.invalid", "/api/training-sessions?providerId=PRV-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  const item = body.data[0];
  assert.equal(item.id, "TS-1"); assert.notEqual(item.customer_name, "Synthetic Customer");
  assert.notEqual(item.customer_name, "Customer");
  assert.deepEqual(item.attendance, { mode: "parent" });
  assert.deepEqual(item.homework, { text: "Practice recall daily" }); assert.deepEqual(item.progress, { focus: 7 });
  assert.equal(item.events[0].actorId, "provider_or_system");
  assert.deepEqual(item.events[0].detail.programme, { status: "scheduled" });
  assert.ok(!JSON.stringify(body).includes(SECRET)); assert.ok(!JSON.stringify(body).includes(STAFF_NOTE));
  assert.equal(item.attendance_json, undefined); assert.equal(item.events[0].detail_json, undefined);
});

test("GET still refuses another provider and an anonymous caller before returning session data", async (t) => {
  const { GET } = await routeWorld(t);
  const wrong = await GET(asActor("trainer@example.invalid", "/api/training-sessions?providerId=PRV-OTHER"));
  assert.equal(wrong.status, 403); assert.equal((await wrong.json()).data, undefined);
  const anonymous = await GET(new Request("https://app.pawspace.in/api/training-sessions?providerId=PRV-1"));
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).data, undefined);
});

test("reconciled projection retains typed operational metadata without nested private labels", () => {
  const out = sanitizeTrainingEventDetail({caseId: "CASE-1", phase: "handover", durationMinutes: 15,
    reportSaved: true, geofence: {distanceMeters: 42, thresholdMeters: 150, verified: true,
      privateLabel: "private assessment", latitude: 12.97}, reason: "private assessment"});
  assert.deepEqual(out, {caseId: "CASE-1", phase: "handover", durationMinutes: 15, reportSaved: true,
    geofence: {distanceMeters: 42, thresholdMeters: 150, verified: true}});
  assert.deepEqual(projectTrainerSession({homework: {text: "x".repeat(1001)}}).homework, {});
  assert.deepEqual(projectTrainerSession({homework: {text: "Message @parent"}}).homework, {});
});
