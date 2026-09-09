import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

function config() {
  const start = new Date(Date.now() + 9 * 86400000);
  start.setUTCHours(5, 30, 0, 0);
  return { customerId: "OPS-CLOSURE-CUSTOMER", customerName: "Synthetic recovery parent",
    phone: "+919900000707", petSourceId: "OPS-CLOSURE-PET", petName: "Test dog", cityId: "blr",
    zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946,
    preferredProviderId: "groom_kiran", groupId: "OPS-CLOSURE-GROUP", start: start.toISOString(), stopAfterCapture: true };
}
async function recovery(job, cookie, action, reason) {
  const { POST } = await import("../app/api/provider-assignment-recovery/route.ts");
  const response = await POST(new Request("https://uat.pawspace.in/api/provider-assignment-recovery", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ bookingId: job.bookingId, providerId: job.provider.id, action, reason }),
  }));
  return { status: response.status, body: await response.json() };
}
async function fixture(t) {
  const ctx = await setupJourney(); t.after(ctx.close);
  const input = config(), job = await runCompletedJourney(ctx, input);
  const cookie = await sessionCookie(ctx.db, "provider", job.provider.id, `provider:${job.provider.id}`);
  return { ctx, input, job, cookie };
}
function onlyReplacement(ctx, input, providerId) {
  const row = ctx.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(input.groupId);
  const payload = JSON.parse(row.shortlist_json);
  const choice = payload.choices.find(choice => choice.provider.id !== providerId);
  assert.ok(choice, "fixture must contain an actual governed alternative");
  payload.choices = [choice];
  ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(JSON.stringify(payload), input.groupId);
  return choice.provider.id;
}

test("two provider accepts that read the same pending offer cannot both commit", async t => {
  const { ctx, job, cookie } = await fixture(t);
  let winner;
  ctx.db.beforeBatch = async statements => {
    if (!statements.some(s => s._sql.includes("UPDATE provider_assignment_offers SET status='accepted'"))) return;
    ctx.db.beforeBatch = null;
    winner = await recovery(job, cookie, "accept", "Second request wins before first commit");
  };
  const loser = await recovery(job, cookie, "accept", "First request resumes after winner");
  assert.ok(winner, "both real route calls must reach the mutation boundary");
  assert.equal(winner.status, 200, JSON.stringify(winner.body));
  assert.equal(loser.status, 409, JSON.stringify(loser.body));
  assert.equal(loser.body.code, "RECOVERY_STATE_CONFLICT");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='provider_assignment_accepted'").get(job.bookingId).n, 1);
  const telemetry = ctx.sqlite.prepare("SELECT id FROM provider_performance_events WHERE booking_id=? AND event_type='assignment_accepted'").all(job.bookingId);
  assert.equal(telemetry.length, 1); assert.ok(telemetry[0].id.endsWith(":1"));
  assert.equal(ctx.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(job.bookingId).status, "assigned");
});

test("an expired commission offer is refused without assignment writes", async t => {
  const { ctx, job, cookie, input } = await fixture(t);
  ctx.sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").run(Date.now() - 1000, input.groupId);
  const before = ctx.sqlite.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").get(job.bookingId);
  const result = await recovery(job, cookie, "accept", "Expired test offer");
  assert.equal(result.status, 409, JSON.stringify(result.body)); assert.match(result.body.error, /expired/);
  assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").get(job.bookingId), before);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_performance_events WHERE booking_id=?").get(job.bookingId).n, 0);
});

test("replacement selection counts a previous-UTC-date reservation on the same IST service day", async t => {
  const { ctx, job, cookie, input } = await fixture(t);
  const replacementId = onlyReplacement(ctx, input, job.provider.id);
  ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET max_daily_jobs=1 WHERE id=?").run(replacementId);
  const start = new Date(input.start); start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(20, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60000);
  assert.notEqual(start.toISOString().slice(0, 10), input.start.slice(0, 10));
  assert.equal(new Date(start.getTime() + 330 * 60000).toISOString().slice(0, 10), new Date(Date.parse(input.start) + 330 * 60000).toISOString().slice(0, 10));
  const row = { ...ctx.sqlite.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? LIMIT 1").get(input.groupId),
    id: "OPS-IST-EXISTING", group_id: "OPS-IST-OTHER-GROUP", provider_id: replacementId,
    scheduled_start: start.toISOString(), scheduled_end: end.toISOString(), status: "confirmed" };
  const keys = Object.keys(row);
  ctx.sqlite.prepare(`INSERT INTO scheduling_reservations (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
  const result = await recovery(job, cookie, "decline", "Synthetic same-IST-day capacity case");
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "ops_escalation", "exhausted candidates must escalate, not select a provider then fail final capacity validation");
  assert.equal(ctx.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get(job.bookingId).provider_id, job.provider.id);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_recovery_cases WHERE booking_id=? AND status='ops_escalation'").get(job.bookingId).n, 1);
});

test("replacement selection excludes a profile expired before the IST service date", async t => {
  const { ctx, job, cookie, input } = await fixture(t);
  const replacementId = onlyReplacement(ctx, input, job.provider.id);
  const beforeServiceDay = new Date(Date.parse(input.start) - 86400000).toISOString().slice(0, 10);
  ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET effective_to=? WHERE id=?").run(beforeServiceDay, replacementId);
  const result = await recovery(job, cookie, "decline", "Synthetic expired provider profile");
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "ops_escalation");
  assert.equal(ctx.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get(job.bookingId).provider_id, job.provider.id);
});
