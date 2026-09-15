/**
 * R3-F — Operations surfaces that acted, and surfaces that measured instead of asserting.
 *
 * Every test below drives the REAL module or the REAL route handler against a real SQLite-backed D1
 * and reads the resulting rows, because each of these defects was a screen that looked right:
 *
 *   F-P0a  the platform raised HIGH "boarding acceptance timeout ... Reassign or contact the host"
 *          and every path an operator could take was a dead end. The staff-capable API existed; the
 *          control did not. So the assertion here is the OUTCOME - canonical_bookings.provider_id
 *          actually changes - not that a button renders.
 *   F-P1   the boarding exception queue rated that same stay "clear" with no flags.
 *   F-P2b  two screens stated scheduler facts they did not measure, and both were wrong.
 *   F-P2c  "refunds pending" counted tasks, and closing one retired a live refund forever.
 *   F-P2d  claiming a task deleted it from the Control Tower.
 *   F-P2e  "Open revenue - due now" counted money already captured.
 *   F-P2f  "NET PROFIT" was gross revenue whenever no expense was posted.
 *   F-P2g  "Privileged APIs 10" was a literal on a page that promises counted numbers.
 *   F-P2h  the daily revenue board had no control that could build its own list.
 *   F-P3a  the work queue's day was a UTC day on an IST platform.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, seedBoardingStay, nextKey } from "./helpers/stay-harness.mjs";

installWorkersHooks("__R3F_DB__", "__R3F_ENV__");

const opsGovernance = await import("../lib/boarding-ops-governance.ts");
const recovery = await import("../lib/service-provider-recovery.ts");
const schedulerObservation = await import("../lib/scheduler-observation.ts");
const workQueue = await import("../lib/ops-work-queue.ts");
const controlTower = await import("../lib/control-tower.ts");
const pnl = await import("../lib/pnl-reporting.ts");

const boardingStaysRoute = await import("../app/api/boarding-stays/route.ts");
const boardingOpsRoute = await import("../app/api/boarding-ops/route.ts");
const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const workQueueRoute = await import("../app/api/ops-work-queue/route.ts");
const staffAlertsRoute = await import("../app/api/staff-alerts/route.ts");
const commandCentreRoute = await import("../app/api/booking-command-center/route.ts");

const HOST = "host_maya_rohan";
const DAY = 86_400_000;

/** A localhost request resolves to the development-preview superuser, so real routes run as staff. */
const staffRequest = (path, body) => (body === undefined
  ? new Request(`http://localhost${path}`)
  : new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text); } catch { return { error: text }; } };

function offersTable(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
}

/** A boarding stay awaiting host acceptance whose acceptance offer has already expired. */
async function overdueBoardingStay(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3F_DB__ = db;
  globalThis.__R3F_ENV__ = {};
  const now = Date.now();
  const seeded = await seedBoardingStay(db, sqlite, {
    window: { scheduledStart: new Date(now + 2 * DAY).toISOString(), scheduledEnd: new Date(now + 4 * DAY).toISOString() },
    ...options,
  });
  offersTable(sqlite);
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,1,?)")
    .run(seeded.groupId, seeded.bookingId, HOST, now - 3_600_000, now - 600_000, now);
  await opsGovernance.ensureBoardingOpsTables(db);
  return { sqlite, db, now, ...seeded };
}

// ================================================================================================
// F-P0a — an operator following the platform's own HIGH alert must change the booking.
// ================================================================================================

test("F-P0a: staff recovery is defined for every non-grooming service line, not grooming alone", () => {
  const base = { bookingId: "BKG-1", bookingStatus: "confirmed", columnProviderId: "p1", bookingProviderId: "p1", canManageBookings: true };
  for (const serviceCode of ["grooming", "boarding", "pet_sitting", "dog_walking", "pet_taxi"]) {
    assert.equal(recovery.canStaffRecover({ ...base, serviceCode }), true, `${serviceCode} must offer a staff recovery control`);
    const plan = recovery.serviceRecoveryPlan(serviceCode);
    assert.ok(plan && plan.endpoint.startsWith("/api/"), `${serviceCode} must name the governed route staff post to`);
  }
  assert.equal(recovery.canStaffRecover({ ...base, serviceCode: "vet_consult" }), false, "a service with no staff recovery path offers no control");
  assert.equal(recovery.canStaffRecover({ ...base, serviceCode: "boarding", canManageBookings: false }), false, "recovery needs bookings.manage");
  assert.equal(recovery.canStaffRecover({ ...base, serviceCode: "boarding", bookingProviderId: "someone_else" }), false, "a column that is not the booking's provider cannot recover it");
  assert.equal(recovery.canStaffRecover({ ...base, serviceCode: "boarding", reservationStatus: "cancelled" }), false, "a cancelled reservation has nothing to recover");
  assert.equal(recovery.canStaffRecover({ ...base, serviceCode: "boarding", bookingStatus: "completed" }), false, "a completed booking has no assignment left to recover");
});

test("F-P0a OUTCOME: the staff control's own request opens a real recovery case AND the replacement changes the booking's provider", async () => {
  const world = await overdueBoardingStay();

  // The exact request the day board and the Boarding queue send, built by the shared module the
  // screens use. Nothing here is hand-written for the test.
  const request = recovery.buildRecoveryRequest({
    serviceCode: "boarding", subjectId: world.stayId, problem: "unavailable",
    reason: "Host did not accept before the acceptance offer expired", idempotencyKey: nextKey("R3F-REC"),
  });
  assert.equal(request.url, "/api/boarding-stays");
  assert.equal(request.body.stayId, world.stayId);
  assert.equal(request.body.action, "host_unavailable");

  const opened = await boardingStaysRoute.POST(staffRequest(request.url, request.body));
  const openedBody = await readJson(opened);
  assert.ok(opened.status < 400, `staff recovery must be accepted: ${opened.status} ${JSON.stringify(openedBody)}`);

  const recoveryCase = world.sqlite.prepare("SELECT id,status,failed_provider_id,reason_code FROM boarding_recovery_cases WHERE stay_id=?").get(world.stayId);
  assert.ok(recoveryCase, "a boarding_recovery_cases row must exist — the alert asked for exactly this");
  assert.equal(recoveryCase.failed_provider_id, HOST);
  assert.equal(world.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(world.bookingId).status, "reassignment_needed");

  // ...and the operator can then actually move the booking to another host from the same screen.
  const snapshot = await opsGovernance.getBoardingOpsSnapshot(world.db);
  const stay = snapshot.stays.find((row) => String(row.id) === world.stayId);
  assert.ok(stay.exceptionFlags.includes("host_recovery"), "the queue must now show the recovery it just opened");
  const candidate = stay.replacementCandidates[0];
  assert.ok(candidate, "a verified replacement host must be offered");

  const assigned = await boardingOpsRoute.POST(staffRequest("/api/boarding-ops", {
    stayId: world.stayId, action: "assign_replacement", providerId: candidate.providerId,
    reason: "Verified replacement selected by Operations", idempotencyKey: nextKey("R3F-ASSIGN"),
  }));
  assert.ok(assigned.status < 400, `replacement assignment must be accepted: ${assigned.status} ${JSON.stringify(await readJson(assigned))}`);

  const booking = world.sqlite.prepare("SELECT provider_id,status FROM canonical_bookings WHERE id=?").get(world.bookingId);
  const stayRow = world.sqlite.prepare("SELECT host_provider_id FROM boarding_stays WHERE id=?").get(world.stayId);
  const workOrder = world.sqlite.prepare("SELECT provider_id,status FROM provider_work_orders WHERE booking_id=?").get(world.bookingId);
  assert.equal(booking.provider_id, candidate.providerId, "the BOOKING's provider changed — not a toast");
  assert.notEqual(booking.provider_id, HOST);
  assert.equal(stayRow.host_provider_id, candidate.providerId);
  assert.equal(workOrder.provider_id, candidate.providerId, "the work order moved with the booking");
});

test("F-P0a: the scheduling day board is served a recovery control for a boarding row, with the id that control needs", async () => {
  const world = await overdueBoardingStay();
  const now = Date.now();
  const day = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
  world.sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,selected_provider_id TEXT,status TEXT,actor_id TEXT,reason TEXT,shortlist_json TEXT,updated_at INTEGER)");
  // One reservation inside the requested IST day, held by the booking's own provider.
  const start = new Date(new Date(`${day}T00:00:00+05:30`).getTime() + 10 * 3_600_000).toISOString();
  world.sqlite.prepare("UPDATE scheduling_reservations SET scheduled_start=?,scheduled_end=?,service_code='boarding' WHERE group_id=?")
    .run(start, new Date(new Date(start).getTime() + 3_600_000).toISOString(), world.groupId);

  const response = await schedulingRoute.GET(staffRequest(`/api/uat-scheduling?date=${day}`));
  const body = await readJson(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  const rows = (body.data.providers || []).flatMap((column) => column.reservations);
  const row = rows.find((item) => item.bookingId === world.bookingId);
  assert.ok(row, `the boarding reservation must be on the day board: ${JSON.stringify(body.data)}`);
  assert.equal(row.canRecover, true, "a boarding row must offer Recover provider — it used to be grooming-only");
  assert.equal(row.recoverySubjectId, world.stayId, "boarding recovery keys on the stay, so the board must carry the stay id");
  assert.equal(row.recoveryQueuePath, "/team/operations/boarding");
});

test("F-P0a: the Boarding queue offers the release control exactly while a host can still be released", async () => {
  const page = recovery;
  assert.equal(page.boardingHostReleasable({ status: "awaiting_host_acceptance", exceptionFlags: [] }), true);
  assert.equal(page.boardingHostReleasable({ status: "confirmed", exceptionFlags: [] }), true);
  assert.equal(page.boardingHostReleasable({ status: "in_progress", exceptionFlags: [] }), true);
  assert.equal(page.boardingHostReleasable({ status: "recovery_pending", exceptionFlags: ["host_recovery"] }), false, "a recovery already open is not released again");
  assert.equal(page.boardingHostReleasable({ status: "completed", exceptionFlags: [] }), false);
  assert.equal(page.boardingHostReleasable(null), false);
});

// ================================================================================================
// F-P1 — the queue called the flagged stay "clear".
// ================================================================================================

test("F-P1: an expired host-acceptance offer is an exception, at the same HIGH the alert engine gives it", async () => {
  const world = await overdueBoardingStay();
  const snapshot = await opsGovernance.getBoardingOpsSnapshot(world.db);
  const stay = snapshot.stays.find((row) => String(row.id) === world.stayId);
  assert.equal(stay.status, "awaiting_host_acceptance");
  assert.ok(stay.exceptionFlags.includes("host_acceptance_due"), `expected host_acceptance_due, got ${JSON.stringify(stay.exceptionFlags)}`);
  assert.equal(stay.priority, "high", "the queue must not rate HIGH work below the alert that raised it");
  assert.equal(snapshot.metrics.needsAttention, 1);
  assert.equal(snapshot.metrics.clear, 0, "NEEDS ATTENTION 0 / CLEAR 2 was the screen; it cannot say that again");
});

test("F-P1: an offer that has NOT expired, and one already accepted, stay clear", async () => {
  const world = await overdueBoardingStay();
  world.sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").run(Date.now() + 3_600_000, world.groupId);
  let stay = (await opsGovernance.getBoardingOpsSnapshot(world.db)).stays.find((row) => String(row.id) === world.stayId);
  assert.equal(stay.exceptionFlags.includes("host_acceptance_due"), false, "a live offer is not overdue");
  assert.equal(stay.priority, "clear");

  world.sqlite.prepare("UPDATE provider_assignment_offers SET status='accepted',expires_at=? WHERE group_id=?").run(Date.now() - 3_600_000, world.groupId);
  stay = (await opsGovernance.getBoardingOpsSnapshot(world.db)).stays.find((row) => String(row.id) === world.stayId);
  assert.equal(stay.exceptionFlags.includes("host_acceptance_due"), false, "an accepted offer is not an outstanding acceptance");
});

// ================================================================================================
// Work-queue world: the source tables the sweep reads, seeded exactly as their owners define them.
// ================================================================================================

function workQueueWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3F_DB__ = db;
  globalThis.__R3F_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  return { sqlite, db };
}

const refundCase = (sqlite, { id = "RC1", bookingId = "E2E-BK-UI-001", amount = 1500, status = "requested" } = {}) => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, bookingId, `PAY-${bookingId}`, amount, "customer cancelled", status, "customer:cus_1", now, now);
};

// ================================================================================================
// F-P2b — the two footers that stated scheduler facts nothing measured.
// ================================================================================================

test("F-P2b: with no scheduled run ever recorded, the scheduler reports itself as NOT sweeping", async () => {
  const world = workQueueWorld();
  const observed = await schedulerObservation.observeBackgroundScheduler(world.db);
  assert.equal(observed.configured, false, "configured was a compile-time `true`; it is now an observation");
  assert.equal(observed.everRan, false);
  assert.equal(observed.running, false);
  assert.equal(observed.runCount, 0);
  assert.equal(observed.lastRunAt, null);
  assert.match(observed.summary, /no worker\.scheduled run has ever been recorded/i);
  assert.match(observed.summary, /worker\.scheduled/, "every branch names the runner, so the claim can be checked against the deployment");
  assert.doesNotMatch(observed.summary, /Swept automatically by/i, "a deployment that has never swept must not claim it is swept automatically");
});

test("F-P2b: the work-queue footer and the alerts footer print the SAME measured sentence, from the same function", async () => {
  const world = workQueueWorld();
  const observed = await schedulerObservation.observeBackgroundScheduler(world.db);

  const queueResponse = await workQueueRoute.GET(staffRequest("/api/ops-work-queue"));
  const queueBody = await readJson(queueResponse);
  assert.equal(queueResponse.status, 200, JSON.stringify(queueBody));
  assert.equal(queueBody.data.truth.backgroundSchedulerConfigured, false);
  assert.equal(queueBody.data.truth.backgroundScheduler.summary, observed.summary, "the work-queue footer prints this string verbatim");

  const alertsResponse = await staffAlertsRoute.GET(staffRequest("/api/staff-alerts"));
  const alertsBody = await readJson(alertsResponse);
  assert.equal(alertsResponse.status, 200, JSON.stringify(alertsBody));
  assert.equal(alertsBody.scheduler.summary, observed.summary, "/team/alerts prints this string verbatim");
  assert.equal(alertsBody.directory.truth.backgroundSchedulerConfigured, false,
    "the page used to print 'not configured yet' under a response that said configured:true — they are now one value");
  assert.equal(alertsBody.scheduler.configured, alertsBody.directory.truth.backgroundSchedulerConfigured,
    "the truth block and the scheduler block can no longer disagree");
});

test("F-P2b: once the scheduled handler HAS run, both surfaces say so, with the run time — and say when it stops", async () => {
  const world = workQueueWorld();
  const now = Date.now();
  // background_scheduler_runs is written only by runBackgroundScheduler, called only from
  // worker/index.ts scheduled(). A row here is a cron firing; that is the whole evidence.
  const record = (scheduledAt, status = "completed") => world.sqlite.prepare("INSERT OR REPLACE INTO background_scheduler_runs (slot_key,scheduled_at,cron,status,attempts,result_json,started_at,updated_at) VALUES (?,?,'*/5 * * * *',?,1,'{}',?,?)")
    .run(`five-minute:${scheduledAt}`, scheduledAt, status, scheduledAt, scheduledAt);
  await (await import("../lib/background-scheduler.ts")).ensureBackgroundSchedulerTables(world.db);

  record(now - 60_000);
  let observed = await schedulerObservation.observeBackgroundScheduler(world.db, { now });
  assert.equal(observed.configured, true);
  assert.equal(observed.running, true);
  assert.equal(observed.runCount, 1);
  assert.match(observed.summary, /Swept automatically by worker\.scheduled/);
  assert.match(observed.summary, new RegExp(new Date(now - 60_000).toISOString()), "the sentence names the run it measured");
  const queueBody = await readJson(await workQueueRoute.GET(staffRequest("/api/ops-work-queue")));
  assert.equal(queueBody.data.truth.backgroundSchedulerConfigured, true);

  // The cron stops. Nothing about the deployment's configuration changes; the observation does.
  observed = await schedulerObservation.observeBackgroundScheduler(world.db, { now: now + 60 * 60_000 });
  assert.equal(observed.everRan, true, "history is not erased");
  assert.equal(observed.running, false);
  assert.match(observed.summary, /STOPPED/);
  assert.doesNotMatch(observed.summary, /^Swept automatically/);
});

// ================================================================================================
// F-P2c — refunds pending counted tasks, and closing a task retired a live refund forever.
// ================================================================================================

test("F-P2c OUTCOME: resolving the task cannot make an outstanding refund disappear, and a re-sweep raises it again", async () => {
  const world = workQueueWorld();
  refundCase(world.sqlite);
  const first = await workQueue.sweepWorkQueue(world.db, { actorId: "test" });
  assert.equal(first.created.refund_requested, 1);
  let centre = (await workQueue.workQueueSnapshot(world.db)).commandCentre;
  assert.equal(centre.refundPending, 1);
  assert.equal(centre.refundPendingAmount, 1500);

  const task = world.sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='refund_requested'").get();
  await workQueue.mutateWorkQueueTask(world.db, { taskId: task.id, action: "resolve", actorId: "finance:asha", note: "passed to the gateway team" });
  assert.equal(world.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id='RC1'").get().status, "requested", "the refund itself is untouched");

  centre = (await workQueue.workQueueSnapshot(world.db)).commandCentre;
  assert.equal(centre.refundPending, 1, "the screen read '0 refunds pending' over a live INR 1,500 refund — it counts the refund table now");
  assert.equal(centre.refundPendingAmount, 1500);

  const second = await workQueue.sweepWorkQueue(world.db, { actorId: "test" });
  assert.equal(second.totalReopened, 1, "a resolved task whose condition is still live comes back");
  assert.equal(world.sqlite.prepare("SELECT status FROM ops_work_queue_tasks WHERE id=?").get(task.id).status, "open");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_events WHERE task_id=? AND event_type='reopened'").get(task.id).n, 1,
    "the reopen is recorded, so nobody has to guess why it came back");
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks").get().n, 1, "it comes BACK, it is not duplicated");
});

test("F-P2c: once the refund is actually settled, nothing is raised again and nothing is counted", async () => {
  const world = workQueueWorld();
  refundCase(world.sqlite);
  await workQueue.sweepWorkQueue(world.db, { actorId: "test" });
  const task = world.sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='refund_requested'").get();
  await workQueue.mutateWorkQueueTask(world.db, { taskId: task.id, action: "resolve", actorId: "finance:asha", note: "refund completed at the gateway" });
  world.sqlite.prepare("UPDATE booking_refund_cases SET status='refunded' WHERE id='RC1'").run();

  const again = await workQueue.sweepWorkQueue(world.db, { actorId: "test" });
  assert.equal(again.totalReopened, 0, "a condition that has genuinely cleared does not reopen its task");
  assert.equal(world.sqlite.prepare("SELECT status FROM ops_work_queue_tasks WHERE id=?").get(task.id).status, "resolved");
  const centre = (await workQueue.workQueueSnapshot(world.db)).commandCentre;
  assert.equal(centre.refundPending, 0);
});

test("F-P2c: a DISMISSED task is a judgement about the same facts, so it is not reopened", async () => {
  const world = workQueueWorld();
  refundCase(world.sqlite);
  await workQueue.sweepWorkQueue(world.db, { actorId: "test" });
  const task = world.sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='refund_requested'").get();
  await workQueue.mutateWorkQueueTask(world.db, { taskId: task.id, action: "dismiss", actorId: "finance:asha", note: "duplicate of the manual refund already paid" });
  const again = await workQueue.sweepWorkQueue(world.db, { actorId: "test" });
  assert.equal(again.totalReopened, 0);
  assert.equal(world.sqlite.prepare("SELECT status FROM ops_work_queue_tasks WHERE id=?").get(task.id).status, "dismissed");
  assert.equal((await workQueue.workQueueSnapshot(world.db)).commandCentre.refundPending, 1,
    "the refund is still outstanding and is still counted, even though nobody wants the task");
});

// ================================================================================================
// F-P2d — claiming a task deleted it from the Control Tower.
// ================================================================================================

test("F-P2d OUTCOME: claiming a task does not remove it from the Control Tower, and a claimed task can still escalate", async () => {
  const world = workQueueWorld();
  const now = Date.now();
  await workQueue.ensureWorkQueueTables(world.db);
  for (let index = 0; index < 8; index += 1) {
    world.sqlite.prepare("INSERT INTO ops_work_queue_tasks (id,rule,queue,priority,title,detail_json,entity_type,entity_id,source_key,status,sla_minutes,due_at,escalated,created_at,updated_at) VALUES (?,?,?,?,?,'{}',?,?,?,'open',?,?,0,?,?)")
      .run(`WQT-${index}`, "refund_requested", "finance", "high", `Task ${index}`, "refund_case", `RC-${index}`, `refund_requested:RC-${index}`, 240, now + 240 * 60_000, now, now);
  }
  const opsHealth = (tower) => tower.posture.find((area) => area.code === "ops_queue_health");
  const before = opsHealth(await controlTower.buildControlTower(world.db, { asOf: now }));
  assert.ok(before, "the tower must carry the Operations queue posture area");
  assert.deepEqual({ good: before.good, total: before.total }, { good: 8, total: 8 });
  assert.equal((await workQueue.workQueueSnapshot(world.db)).metrics.open, 8);

  await workQueue.mutateWorkQueueTask(world.db, { taskId: "WQT-0", action: "claim", actorId: "ops:anu" });
  assert.equal(world.sqlite.prepare("SELECT status FROM ops_work_queue_tasks WHERE id='WQT-0'").get().status, "acknowledged");
  assert.equal((await workQueue.workQueueSnapshot(world.db)).metrics.open, 8, "the queue's own count is unchanged by a claim");

  const after = opsHealth(await controlTower.buildControlTower(world.db, { asOf: now }));
  assert.deepEqual({ good: after.good, total: after.total }, { good: 8, total: 8 },
    "claiming one task used to take the tower straight to {good:7,total:7} while the queue still read Open 8");

  // A task claimed BEFORE it breaches must still be able to reach "Escalated operations tasks".
  world.sqlite.prepare("UPDATE ops_work_queue_tasks SET escalated=1,escalated_at=? WHERE id='WQT-0'").run(now);
  const escalatedTower = await controlTower.buildControlTower(world.db, { asOf: now });
  const escalatedSignal = escalatedTower.signals.find((signal) => signal.code === "queue_escalated");
  assert.ok(escalatedSignal, "the tower must carry the escalated-tasks signal");
  assert.equal(Number(escalatedSignal.count), 1, "a claimed task that breaches its SLA could never appear here before");
});

// ================================================================================================
// F-P3a — the work queue's day was a UTC day on an IST platform.
// ================================================================================================

test("F-P3a: at 02:00 IST the Operations day is today's IST date, and work resolved after IST midnight counts", async () => {
  const world = workQueueWorld();
  // 2026-09-15T20:30:00Z is 02:00 IST on 2026-09-16 — the exact window where UTC and IST disagree.
  const now = Date.UTC(2026, 8, 15, 20, 30, 0);
  await workQueue.ensureWorkQueueTables(world.db);
  const created = Date.UTC(2026, 8, 15, 10, 0, 0);
  world.sqlite.prepare("INSERT INTO ops_work_queue_tasks (id,rule,queue,priority,title,detail_json,entity_type,entity_id,source_key,status,sla_minutes,due_at,escalated,resolution_note,resolved_by,resolved_at,created_at,updated_at) VALUES ('WQT-IST','refund_requested','finance','high','Resolved just after IST midnight','{}','refund_case','RC-IST','refund_requested:RC-IST','resolved',240,?,0,'done','ops:anu',?,?,?)")
    .run(created + 240 * 60_000, Date.UTC(2026, 8, 15, 19, 30, 0), created, created);

  // A booking at 01:00 IST on the 16th: still "today" for an operator on shift, and its stored
  // string carries the 15th, which is exactly what substr(scheduled_start,1,10) used to read.
  world.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('B-IST','k-ist','cus_1','[]','[]','blr','blr-east','grooming','pkg','Pkg','g-ist','p1',?,?,'confirmed','customer_app',1200,'INR','{}','uat',?,?)")
    .run(new Date(Date.UTC(2026, 8, 15, 19, 30, 0)).toISOString(), new Date(Date.UTC(2026, 8, 15, 20, 30, 0)).toISOString(), created, created);

  const snapshot = await workQueue.workQueueSnapshot(world.db, { now });
  assert.equal(snapshot.commandCentre.date, "2026-09-16", "the Operations day is an IST day, as lib/control-tower.ts and /api/uat-scheduling already agree");
  assert.equal(snapshot.metrics.resolvedToday, 1, "work resolved at 01:00 IST belongs to today, not to yesterday's 05:30 IST threshold");
  assert.equal(snapshot.commandCentre.bookings, 1, "a booking at 01:00 IST on the 16th is one of the 16th's bookings");
  assert.equal(snapshot.commandCentre.revenue, 1200);
});

test("F-P3a: work resolved BEFORE today's IST midnight is still excluded", async () => {
  const world = workQueueWorld();
  const now = Date.UTC(2026, 8, 15, 20, 30, 0);
  await workQueue.ensureWorkQueueTables(world.db);
  const created = Date.UTC(2026, 8, 14, 10, 0, 0);
  world.sqlite.prepare("INSERT INTO ops_work_queue_tasks (id,rule,queue,priority,title,detail_json,entity_type,entity_id,source_key,status,sla_minutes,due_at,escalated,resolution_note,resolved_by,resolved_at,created_at,updated_at) VALUES ('WQT-Y','refund_requested','finance','high','Resolved yesterday evening IST','{}','refund_case','RC-Y','refund_requested:RC-Y','resolved',240,?,0,'done','ops:anu',?,?,?)")
    .run(created + 240 * 60_000, Date.UTC(2026, 8, 15, 18, 0, 0), created, created);
  const snapshot = await workQueue.workQueueSnapshot(world.db, { now });
  assert.equal(snapshot.commandCentre.date, "2026-09-16");
  assert.equal(snapshot.metrics.resolvedToday, 0, "23:30 IST on the 15th is not the 16th");
});

// ================================================================================================
// F-P2a — "Reassign" was a write-only log, and F-P2e — "Open revenue" counted captured money.
// ================================================================================================

function commandCentreWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3F_DB__ = db;
  globalThis.__R3F_ENV__ = {};
  const now = Date.now();
  // DDL verbatim from app/api/booking-command-center/route.ts ensureTables, which owns these.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('cus_1','blr','Asha Rao','+91-9000000041','asha@example.in',?,?)").run(now, now);
  const addBooking = (id, { paymentStatus, dueNow, amount = 1500 }) => {
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,'cus_1','[]','[]','blr','blr-east','grooming','pkg','Full Groom',?,'p1',?,?,'confirmed','customer_app',?,'INR','{}','uat',?,?)")
      .run(id, `k-${id}`, `g-${id}`, new Date(now + DAY).toISOString(), new Date(now + DAY + 3_600_000).toISOString(), amount, now, now);
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES (?,?,?,'p1','Kiran','commission','grooming',?,?,1,'assigned',?,?)")
      .run(`WO-${id}`, id, `g-${id}`, new Date(now + DAY).toISOString(), new Date(now + DAY + 3_600_000).toISOString(), now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,'cus_1',?,?,'INR','card','prepaid',?,'uat_sandbox',?,'{}',?,?)")
      .run(`PAY-${id}`, id, amount, dueNow, paymentStatus, `pk-${id}`, now, now);
  };
  return { sqlite, db, now, addBooking };
}

test("F-P2e OUTCOME: money already captured is not counted as money still to collect", async () => {
  const world = commandCentreWorld();
  // The exact shape the audit saw: PAYMENT STATUS Captured - Prepaid - Card - INR 1,500, with
  // "Due now INR 1,500" printed underneath it, and that 1,500 inside "Open revenue".
  world.addBooking("E2E-BK-UI-001", { paymentStatus: "captured", dueNow: 1500 });
  world.addBooking("E2E-BK-UI-002", { paymentStatus: "created", dueNow: 900, amount: 900 });

  const response = await commandCentreRoute.GET(staffRequest("/api/booking-command-center"));
  const body = await readJson(response);
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 400));
  const captured = body.bookings.find((row) => row.id === "E2E-BK-UI-001");
  const pending = body.bookings.find((row) => row.id === "E2E-BK-UI-002");
  assert.equal(Number(captured.amount_due_now), 1500, "the stored column is untouched — it is a record of what was due at creation");
  assert.equal(Number(captured.outstanding_amount), 0, "a captured payment owes nothing");
  assert.equal(Number(pending.outstanding_amount), 900, "an uncaptured payment is still genuinely owed");

  const openRevenue = body.bookings.reduce((sum, row) => sum + Number(row.outstanding_amount ?? row.amount_due_now ?? 0), 0);
  assert.equal(openRevenue, 900, "the header tile sums this — it used to include the 1,500 already in the bank");
});

test("F-P2e: a split-payment stay that captured its first instalment still owes the balance", async () => {
  const world = commandCentreWorld();
  // 50/50 boarding stay: the first instalment is captured, so booking_payments reads `captured`,
  // and the balance is genuinely still owed. Payment status alone would report zero outstanding.
  world.addBooking("E2E-BK-SPLIT-1", { paymentStatus: "captured", dueNow: 2000, amount: 4000 });
  world.sqlite.exec("CREATE TABLE IF NOT EXISTS stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT NOT NULL,customer_id TEXT NOT NULL,total_amount REAL NOT NULL,paid_now_amount REAL NOT NULL,balance_amount REAL NOT NULL,balance_due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending_balance',paid_at INTEGER,payment_ref TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const schedule = world.sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES (?, 'boarding','cus_1',4000,2000,2000,?,?,?,?)");
  schedule.run("E2E-BK-SPLIT-1", world.now + DAY, "pending_balance", world.now, world.now);

  let body = await readJson(await commandCentreRoute.GET(staffRequest("/api/booking-command-center")));
  let row = body.bookings.find((item) => item.id === "E2E-BK-SPLIT-1");
  assert.equal(String(row.payment_status), "captured");
  assert.equal(Number(row.outstanding_amount), 2000, "the unpaid half of a split stay is real open revenue");

  world.sqlite.prepare("UPDATE stay_payment_schedules SET status='paid' WHERE booking_id=?").run("E2E-BK-SPLIT-1");
  body = await readJson(await commandCentreRoute.GET(staffRequest("/api/booking-command-center")));
  row = body.bookings.find((item) => item.id === "E2E-BK-SPLIT-1");
  assert.equal(Number(row.outstanding_amount), 0, "once the balance is settled nothing is owed");
});

test("F-P2a OUTCOME: a reassignment request lands in the Operations work queue a human actually reads", async () => {
  const world = commandCentreWorld();
  world.addBooking("E2E-BK-UI-001", { paymentStatus: "captured", dueNow: 1500 });

  const response = await commandCentreRoute.POST(staffRequest("/api/booking-command-center", {
    bookingId: "E2E-BK-UI-001", action: "review_reassignment", reason: "Customer asked for a different groomer",
  }));
  const body = await readJson(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(body.queued?.taskId, `the response must name the task it created: ${JSON.stringify(body)}`);
  assert.match(String(body.deliveryStatus), /^queued_to_operations_work_queue:/, "'recorded' over an unchanged booking is what this replaced");

  const task = world.sqlite.prepare("SELECT id,rule,queue,status,booking_id,sla_minutes FROM ops_work_queue_tasks WHERE booking_id='E2E-BK-UI-001'").get();
  assert.ok(task, "a real, owned, SLA-tracked task — not a booking_admin_actions row nothing reads");
  assert.equal(task.queue, "operations");
  assert.equal(task.status, "open");
  assert.equal(task.rule, "reassignment_requested");

  // And it is genuinely on the screen an operator opens.
  const queueBody = await readJson(await workQueueRoute.GET(staffRequest("/api/ops-work-queue")));
  assert.equal(queueBody.data.queues.operations.open, 1, `the work queue must show it: ${JSON.stringify(queueBody.data.queues)}`);
  assert.equal(queueBody.data.queues.operations.tasks[0].booking_id, "E2E-BK-UI-001");

  // Two requests on the same booking are one task, not a growing pile.
  await commandCentreRoute.POST(staffRequest("/api/booking-command-center", {
    bookingId: "E2E-BK-UI-001", action: "review_reassignment", reason: "Customer chased again this morning",
  }));
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks WHERE booking_id='E2E-BK-UI-001'").get().n, 1);
});

// ================================================================================================
// F-P2f — "NET PROFIT" was gross revenue, and F-P2g — a hardcoded metric on a page promising none.
// ================================================================================================

test("F-P2f: nettProfitAmount may only be called net profit once an expense has actually been posted", () => {
  const noExpenses = pnl.pnlHeadline({ totalTurnoverAmount: 61671, totalExpensesAmount: 0, nettProfitAmount: 61671 });
  assert.equal(noExpenses.isNetProfit, false);
  assert.match(noExpenses.label, /^Turnover/);
  assert.doesNotMatch(noExpenses.label, /Net profit/i, "the tile printed 61,671 as NET PROFIT while every month's expenses were 0");
  assert.equal(noExpenses.amount, 61671);
  assert.match(noExpenses.note, /no expense journal entries are posted/i);

  const withExpenses = pnl.pnlHeadline({ totalTurnoverAmount: 61671, totalExpensesAmount: 20000, nettProfitAmount: 41671 });
  assert.equal(withExpenses.isNetProfit, true);
  assert.match(withExpenses.label, /^Net profit/);
  assert.equal(withExpenses.amount, 41671, "a real net profit is turnover less what was deducted");
  assert.notEqual(withExpenses.amount, withExpenses.expenses + withExpenses.amount - 20000 + 1);
});

test("F-P2g: the access-control tiles are counted from the governance payload, never printed as literals", async () => {
  const panel = await import("../app/control/access-control-panel.tsx");
  const data = {
    current: { name: "Ops", email: "ops@pawspace.in", roleCode: "admin", permissions: ["bookings.manage"] },
    permissionCatalog: Array.from({ length: 24 }, (_, index) => `permission_${index}`),
    roles: [{ code: "founder", name: "Founder", description: "", permissions: ["*"] }, { code: "admin", name: "Admin", description: "", permissions: ["bookings.manage"] }],
    users: [
      { id: "1", email: "founder@pawspace.in", name: "Founder", role_code: "founder", status: "active" },
      { id: "2", email: "ops@pawspace.in", name: "Ops", role_code: "admin", status: "active" },
      { id: "3", email: "ops2@pawspace.in", name: "Ops 2", role_code: "admin", status: "active" },
    ],
  };
  const metrics = panel.accessControlMetrics(data);
  const byLabel = Object.fromEntries(metrics.map((row) => [row[0], row[1]]));
  assert.equal(byLabel["Enforced permissions"], "24", "the old tile said 'Privileged APIs 10' whatever the platform actually had");
  assert.equal(byLabel["Full-access identities"], "1", "counted from the users the payload carries, not the literal 1");
  assert.equal(Object.keys(byLabel).includes("Privileged APIs"), false, "the uncountable claim is gone rather than restated");

  const unread = Object.fromEntries(panel.accessControlMetrics(null).map((row) => [row[0], row[1]]));
  assert.equal(unread["Enforced permissions"], "—", "before the payload arrives, nothing is claimed");
  assert.equal(unread["Full-access identities"], "—");
});

// ================================================================================================
// F-P2h — the daily revenue board could not build its own list.
// ================================================================================================

test("F-P2h OUTCOME: the control the page now has really does fill the board", async () => {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3F_DB__ = db;
  globalThis.__R3F_ENV__ = {};
  const now = Date.now();
  const page = await import("../app/team/daily-revenue/build-request.ts");
  const request = page.buildTodaysListRequest();
  assert.equal(request.url, "/api/revenue-crm");
  assert.equal(request.body.action, "generate_daily_100", "the page posted only set_daily_target and claim_opportunity; the generator was unreachable");

  const revenueRoute = await import("../app/api/revenue-crm/route.ts");
  // One real open inbound lead — the condition the empty state said was enough on its own.
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LW-R3F','cus_1','website','grooming','sales:anu','manager:dev','active',?,?,?,?,?)")
    .run(now - 3_600_000, now, now, now, now);

  const response = await revenueRoute.POST(staffRequest(request.url, request.body));
  const body = await readJson(response);
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 400));
  const built = sqlite.prepare("SELECT COUNT(*) n FROM revenue_opportunities").get().n;
  assert.ok(built > 0, `the control must actually build the list: ${JSON.stringify(body)}`);
});

// ================================================================================================
// P3 — a case body that reads as machine record rather than as an explanation.
// ================================================================================================

test("P3: a case description is operator language, not the raw detail_json column", async () => {
  const cases = await import("../lib/unified-case-center.ts");
  const raw = JSON.stringify({ dueAt: Date.UTC(2026, 8, 15, 6, 0, 0), policyId: "GLOBAL_DEFAULT_SLA", clock: "first_response", managerEscalated: true });
  const described = cases.describeCaseDetail(raw, "Lead SLA breached");
  assert.doesNotMatch(described, /[{}"]/, `a manager read this as the whole explanation: ${described}`);
  assert.match(described, /Policy id: GLOBAL_DEFAULT_SLA/);
  assert.match(described, /Clock: first response/);
  assert.match(described, /Manager escalated: yes/);
  assert.match(described, /Due at: .*IST/, "an epoch millisecond is a time, and an operator reads times in IST");

  assert.equal(cases.describeCaseDetail("", "Refund case"), "Refund case", "an empty column falls back to something meaningful");
  assert.equal(cases.describeCaseDetail("{}", "Refund case"), "Refund case", "so does an empty object");
  assert.equal(cases.describeCaseDetail("host did not arrive", "fallback"), "host did not arrive", "plain text is already operator language and is left alone");
});

test("P3 OUTCOME: the case the sync path actually writes carries no raw JSON", async () => {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3F_DB__ = db;
  globalThis.__R3F_ENV__ = {};
  const cases = await import("../lib/unified-case-center.ts");
  await cases.ensureUnifiedCaseTables(db);
  // DDL verbatim from lib/lead-sla-governance.ts, which owns it.
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_sla_events (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,clock_id TEXT NOT NULL,lead_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO lead_sla_events (id,idempotency_key,clock_id,lead_id,event_type,actor_id,detail_json,created_at) VALUES ('LSE-1','k1','CLK-1','LW-1','breached','system',?,?)")
    .run(JSON.stringify({ dueAt: Date.UTC(2026, 8, 15, 6, 0, 0), policyId: "GLOBAL_DEFAULT_SLA", clock: "first_response" }), Date.now());

  await cases.syncNativeCases(db, "system:test");
  const row = sqlite.prepare("SELECT title,description FROM unified_cases WHERE source_id='LSE-1'").get();
  assert.ok(row, "the sync must create the case");
  assert.doesNotMatch(row.description, /[{}"]/, `the Case Center printed this straight onto the card: ${row.description}`);
  assert.match(row.description, /Policy id: GLOBAL_DEFAULT_SLA/);
});

test("P3: the deep-link-only Food workspaces now offer the order IDs they demand", async () => {
  const picker = await import("../app/team/operations/food/order-picker.tsx");
  const orders = [
    { id: "FORD-CLEAR-1", item_name: "Adult Dog Food", fulfilment_status: "packed", exceptionFlags: [] },
    { id: "FORD-EXC-1", item_name: "Cat Food", status: "uat_reserved", exceptionFlags: ["stock_recovery_required"] },
    { id: "", item_name: "no id" },
  ];
  const choices = picker.foodWorkspaceChoices(orders, "fulfilment");
  assert.equal(choices.length, 2, "an order with no id is not offered");
  assert.equal(choices[0].id, "FORD-EXC-1", "the order carrying an exception is what the operator came for");
  assert.equal(choices[0].href, "/team/operations/food/fulfilment?orderId=FORD-EXC-1");
  assert.equal(picker.foodWorkspaceChoices(orders, "proof")[0].href, "/team/operations/food/proof?orderId=FORD-EXC-1");
  assert.match(choices[1].label, /FORD-CLEAR-1 · Adult Dog Food · packed/);
  assert.deepEqual(picker.foodWorkspaceChoices([], "proof"), [], "no orders is an empty list, not a crash");

  // And the screen an operator arrives from now offers both workspaces, not proof alone.
  const queue = (await import("node:fs/promises")).readFile;
  const source = await queue(new URL("../app/team/operations/food/page.tsx", import.meta.url), "utf8");
  assert.match(source, /\/team\/operations\/food\/fulfilment\?orderId=/, "the Food queue linked to proof only; fulfilment was reachable from nowhere");
});
