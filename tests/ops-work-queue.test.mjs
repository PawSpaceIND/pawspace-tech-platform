import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL work-queue route and lib execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__WQ_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
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

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__WQ_DB__ = makeD1(sqlite); }

const route = await import("../app/api/ops-work-queue/route.ts");
const { sweepWorkQueue, mutateWorkQueueTask, workQueueSnapshot, UNASSIGNED_GRACE_MS, RENEWAL_OVERDUE_MS } = await import("../lib/ops-work-queue.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
// Preview actor (localhost + NODE_ENV!=production) resolves to a superuser.
const call = async (method, bodyOrQuery) => {
  const url = `http://localhost/api/ops-work-queue${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url)
    : new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? route.GET(request) : route.POST(request));
  return { status: response.status, body: await parseBody(response) };
};

const NOW = Date.now();
const DAY = 86_400_000;

// Exact DDL copied verbatim from the owning sources (never guessed): provider_work_orders +
// canonical_bookings from app/api/canonical-bookings/route.ts, booking_refund_cases from the
// grooming refund surface, payment_reconciliation_exceptions from
// lib/grooming-payment-reconciliation.ts, service_reviews from the review surface,
// relocation_enquiries from the relocation surface, lead_work_items + customer_experience_tickets
// from the CRM/CX surfaces, food tables from lib/food-subscription-governance.ts.
function seedSourceTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS service_reviews (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,stars INTEGER NOT NULL,answers_json TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS relocation_enquiries (id TEXT PRIMARY KEY,customer_name TEXT NOT NULL,phone_primary TEXT NOT NULL,phone_secondary TEXT,email TEXT NOT NULL,pet_type TEXT NOT NULL,pickup_date TEXT NOT NULL,pickup_approx_time TEXT NOT NULL,pickup_location TEXT NOT NULL,drop_location TEXT NOT NULL,expected_travel_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'We received your request', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS food_subscriptions (id TEXT PRIMARY KEY,source_order_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,sku TEXT NOT NULL,item_name TEXT NOT NULL,quantity INTEGER NOT NULL,renewal_interval_days INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',communication_channel TEXT NOT NULL DEFAULT 'whatsapp',unit_price_at_signup REAL NOT NULL,approved_unit_price REAL NOT NULL,current_cycle INTEGER NOT NULL DEFAULT 0,next_renewal_at INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS food_subscription_renewals (id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,cycle_no INTEGER NOT NULL,sku TEXT NOT NULL,quantity INTEGER NOT NULL,item_version INTEGER NOT NULL,unit_price REAL NOT NULL,total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'payment_pending',payment_link_provider TEXT NOT NULL DEFAULT 'internal_uat',payment_link_environment TEXT NOT NULL DEFAULT 'uat',payment_link_ref TEXT NOT NULL UNIQUE,payment_link_path TEXT NOT NULL,payment_link_message_id TEXT,payment_reference TEXT UNIQUE,invoice_id TEXT,confirmation_message_id TEXT,invoice_message_id TEXT,due_at INTEGER NOT NULL,paid_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(subscription_id,cycle_no))");
}

function seedOneOfEachCondition() {
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES ('WO1','B1','G1','prov_1','Kiran','commission','boarding',?,?,1,'awaiting_acceptance',?,?)")
    .run(new Date(NOW + DAY).toISOString(), new Date(NOW + 2 * DAY).toISOString(), NOW - UNASSIGNED_GRACE_MS - 60_000, NOW);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RC1','B2','PAY-B2',1500,'customer cancelled trip','requested','customer:cus_1',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,exception_type,severity,status,created_at) VALUES ('PX1','B3','capture_amount_mismatch','critical','open',?)").run(NOW);
  sqlite.prepare("INSERT INTO service_reviews (id,request_id,booking_id,customer_id,stars,answers_json,created_at) VALUES ('RV1','RQ1','B4','cus_2',1,'{}',?)").run(NOW);
  sqlite.prepare("INSERT INTO relocation_enquiries (id,customer_name,phone_primary,email,pet_type,pickup_date,pickup_approx_time,pickup_location,drop_location,expected_travel_date,status,created_at) VALUES ('RE1','Asha Rao','+91-9000000041','asha@example.in','dog','2026-09-01','10:00','Bengaluru','Pune','2026-09-01','new',?)").run(NOW);
  sqlite.prepare("INSERT INTO food_subscriptions (id,source_order_id,customer_id,city_id,zone_id,sku,item_name,quantity,renewal_interval_days,status,unit_price_at_signup,approved_unit_price,next_renewal_at,created_by,created_at,updated_at) VALUES ('FS1','FO1','cus_3','blr','blr-east','sku1','Adult Dog Food',1,30,'active',799,799,?,'uat',?,?)").run(NOW - 2 * DAY, NOW, NOW);
  sqlite.prepare("INSERT INTO food_subscription_renewals (id,subscription_id,cycle_no,sku,quantity,item_version,unit_price,total_amount,payment_link_ref,payment_link_path,due_at,created_at,updated_at) VALUES ('FR1','FS1',1,'sku1',1,1,799,799,'FPL-1','/pay',?,?,?)").run(NOW - RENEWAL_OVERDUE_MS - 3_600_000, NOW, NOW);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LW1','cus_4','website','grooming','sales:anu','manager:dev','active',?,?,?,?,?)").run(NOW - 3 * 3_600_000, NOW - 3_600_000, NOW - 1_800_000, NOW, NOW);
}

// ---- 1. Detection: every listed exception becomes exactly one routed task ----------------------

test("real execution: the sweep turns each real exception condition into ONE owned task in the right queue, idempotently", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  const db = globalThis.__WQ_DB__;
  const first = await sweepWorkQueue(db, { actorId: "test" });
  assert.deepEqual(first.created, {
    provider_unassigned: 1, refund_requested: 1, payment_exception: 1, low_rating_callback: 1,
    relocation_enquiry: 1, food_renewal_payment_overdue: 1, lead_response_overdue: 1,
  }, JSON.stringify(first));
  assert.equal(first.totalCreated, 7);
  const rows = sqlite.prepare("SELECT rule,queue,priority,booking_id,customer_id,status FROM ops_work_queue_tasks ORDER BY rule").all();
  const byRule = Object.fromEntries(rows.map(row => [row.rule, row]));
  assert.equal(byRule.provider_unassigned.queue, "operations");
  assert.equal(byRule.provider_unassigned.booking_id, "B1");
  assert.equal(byRule.refund_requested.queue, "finance");
  assert.equal(byRule.payment_exception.queue, "finance");
  assert.equal(byRule.payment_exception.priority, "critical", "critical reconciliation exceptions carry critical priority");
  assert.equal(byRule.low_rating_callback.queue, "qc");
  assert.equal(byRule.low_rating_callback.customer_id, "cus_2");
  assert.equal(byRule.relocation_enquiry.queue, "sales_relocation");
  assert.equal(byRule.food_renewal_payment_overdue.queue, "retention");
  assert.equal(byRule.lead_response_overdue.queue, "crm_escalation");
  assert.ok(rows.every(row => row.status === "open"));
  // Idempotent: re-sweeping the SAME conditions creates nothing new
  const second = await sweepWorkQueue(db, { actorId: "test" });
  assert.equal(second.totalCreated, 0, JSON.stringify(second.created));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks").get().n, 7);
});

test("real execution: detectors respect their thresholds — fresh work orders, answered leads and future renewals create nothing", async () => {
  freshDb(); seedSourceTables();
  // Work order inside the 30-minute acceptance grace
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES ('WO1','B1','G1','p1','K','commission','boarding','2026-09-01','2026-09-02',1,'awaiting_acceptance',?,?)").run(NOW - 60_000, NOW);
  // Lead already answered before its due time passed
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,assigned_at,first_action_due_at,manager_alert_at,first_action_at,created_at,updated_at) VALUES ('LW1','c1','web','grooming','o','m','active',?,?,?,?,?,?)").run(NOW - 7_200_000, NOW - 3_600_000, NOW - 1_800_000, NOW - 3_500_000, NOW, NOW);
  // Renewal pending but not yet 24h past due
  sqlite.prepare("INSERT INTO food_subscriptions (id,source_order_id,customer_id,city_id,zone_id,sku,item_name,quantity,renewal_interval_days,status,unit_price_at_signup,approved_unit_price,next_renewal_at,created_by,created_at,updated_at) VALUES ('FS1','FO1','c2','blr','blr-east','sku1','Food',1,30,'active',799,799,?, 'uat',?,?)").run(NOW, NOW, NOW);
  sqlite.prepare("INSERT INTO food_subscription_renewals (id,subscription_id,cycle_no,sku,quantity,item_version,unit_price,total_amount,payment_link_ref,payment_link_path,due_at,created_at,updated_at) VALUES ('FR1','FS1',1,'sku1',1,1,799,799,'FPL-1','/pay',?,?,?)").run(NOW - 3_600_000, NOW, NOW);
  const result = await sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "test" });
  assert.equal(result.totalCreated, 0, JSON.stringify(result.created));
});

test("real execution: a cold database sweeps to zero instead of crashing", async () => {
  freshDb();
  const result = await sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "test" });
  assert.equal(result.totalCreated, 0);
  assert.equal(result.escalated, 0);
});

// ---- 2. Task lifecycle: owner, status machine, governed notes, event trail ---------------------

test("real execution: claim -> start -> resolve with a required note; closed tasks are final; every step lands in the event trail", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  const db = globalThis.__WQ_DB__;
  await sweepWorkQueue(db, { actorId: "test" });
  const task = sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='refund_requested'").get();
  const claimed = await mutateWorkQueueTask(db, { taskId: task.id, action: "claim", actorId: "finance:asha" });
  assert.equal(claimed.status, "acknowledged");
  assert.equal(claimed.owner, "finance:asha");
  const started = await mutateWorkQueueTask(db, { taskId: task.id, action: "start", actorId: "finance:asha" });
  assert.equal(started.status, "in_progress");
  await assert.rejects(mutateWorkQueueTask(db, { taskId: task.id, action: "resolve", actorId: "finance:asha", note: "ok" }),
    (e) => e instanceof Response && e.status === 400, "a resolution needs a real note");
  const resolved = await mutateWorkQueueTask(db, { taskId: task.id, action: "resolve", actorId: "finance:asha", note: "refund approved and instruction issued" });
  assert.equal(resolved.status, "resolved");
  // Terminal: cannot resolve/claim/start again
  await assert.rejects(mutateWorkQueueTask(db, { taskId: task.id, action: "resolve", actorId: "finance:dev", note: "second resolution attempt" }), (e) => e instanceof Response && e.status === 409);
  await assert.rejects(mutateWorkQueueTask(db, { taskId: task.id, action: "claim", actorId: "finance:dev" }), (e) => e instanceof Response && e.status === 409);
  const events = sqlite.prepare("SELECT event_type FROM ops_work_queue_events WHERE task_id=? ORDER BY created_at").all(task.id).map(row => row.event_type);
  assert.deepEqual(events, ["claimed", "in_progress", "resolved"]);
  const row = sqlite.prepare("SELECT resolution_note,resolved_by FROM ops_work_queue_tasks WHERE id=?").get(task.id);
  assert.equal(row.resolution_note, "refund approved and instruction issued");
  assert.equal(row.resolved_by, "finance:asha");
});

test("real execution: a raced double resolve closes the task exactly once", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  const db = globalThis.__WQ_DB__;
  await sweepWorkQueue(db, { actorId: "test" });
  const task = sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='low_rating_callback'").get();
  const race = await Promise.allSettled([
    mutateWorkQueueTask(db, { taskId: task.id, action: "resolve", actorId: "qc:a", note: "customer called back, resolved" }),
    mutateWorkQueueTask(db, { taskId: task.id, action: "dismiss", actorId: "qc:b", note: "duplicate of another task" }),
  ]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1, JSON.stringify(race.map(r => r.status)));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_events WHERE event_type IN ('resolved','dismissed')").get().n, 1);
});

// ---- 3. Escalation: SLA breach flags exactly once -----------------------------------------------

test("real execution: an open task past its SLA due time escalates exactly once across repeated sweeps", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  const db = globalThis.__WQ_DB__;
  await sweepWorkQueue(db, { actorId: "test" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks WHERE escalated=1").get().n, 0, "nothing is escalated at creation");
  // Time-travel: sweep as if 2 days later -> every open task is past due
  const later = await sweepWorkQueue(db, { actorId: "test", now: NOW + 2 * DAY });
  assert.equal(later.escalated, 7, JSON.stringify(later));
  const again = await sweepWorkQueue(db, { actorId: "test", now: NOW + 2 * DAY + 60_000 });
  assert.equal(again.escalated, 0, "escalation must fire once per task, not on every sweep");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_events WHERE event_type='escalated'").get().n, 7);
  // A resolved task never escalates
  const task = sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='relocation_enquiry'").get();
  await mutateWorkQueueTask(db, { taskId: task.id, action: "resolve", actorId: "sales:anu", note: "enquiry converted to relocation booking" });
  const after = await sweepWorkQueue(db, { actorId: "test", now: NOW + 3 * DAY });
  assert.equal(after.escalated, 0);
});

// ---- 4. Route + command centre TODAY block -------------------------------------------------------

test("real execution: GET sweeps + returns queues and the command-centre TODAY block with exact numbers", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  // Deterministic clock for the TODAY block: noon UTC on a fixed date, bookings at fixed hours.
  const noon = Date.UTC(2026, 8, 15, 12, 0, 0);
  const at = (hour) => new Date(Date.UTC(2026, 8, 15, hour, 0, 0)).toISOString();
  const insert = sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,'p1',?,?,?,'customer_app',?,'INR','{}','uat',?,?)");
  insert.run("B1", "k1", "cus_1", "grooming", "g1", at(9), at(10), "completed", 1200, NOW, NOW);
  insert.run("B2", "k2", "cus_2", "boarding", "g2", at(17), at(20), "confirmed", 4000, NOW, NOW);
  insert.run("B3", "k3", "cus_3", "grooming", "g3", at(15), at(16), "cancelled", 900, NOW, NOW);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,created_by,created_at,updated_at) VALUES ('T1','cus_1','complaint','high','Groomer arrived late','detail','ops:a','mgr:b',?,'open','uat',?,?)").run(NOW + DAY, NOW, NOW);
  const res = await call("GET");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const snapshot = res.body.data;
  assert.equal(snapshot.metrics.open, 7, "GET must sweep before reading");
  assert.equal(snapshot.queues.finance.open, 2);
  assert.equal(snapshot.queues.operations.open, 1);
  assert.equal(snapshot.commandCentre.available, true, "the route serves the TODAY block");
  // Exact numbers via the lib with the pinned clock
  const centre = (await workQueueSnapshot(globalThis.__WQ_DB__, { now: noon })).commandCentre;
  assert.equal(centre.bookings, 2, "cancelled bookings do not count as today's bookings");
  assert.equal(centre.revenue, 5200, "1200 + 4000, cancelled 900 excluded");
  assert.equal(centre.completed, 1);
  assert.equal(centre.upcoming, 1);
  assert.equal(centre.cancelled, 1);
  assert.equal(centre.unassigned, 1, "open provider_unassigned tasks");
  assert.equal(centre.refundPending, 1);
  assert.equal(centre.openComplaints, 1);
  assert.deepEqual({ ...centre.byService.grooming }, { bookings: 1, revenue: 1200, completed: 1, cancelled: 1 });
  assert.deepEqual({ ...centre.byService.boarding }, { bookings: 1, revenue: 4000, completed: 0, cancelled: 0 });
});

test("real execution: POST actions work through the route and per-task events are readable", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  await call("POST", { action: "sweep" });
  const task = sqlite.prepare("SELECT id FROM ops_work_queue_tasks WHERE rule='payment_exception'").get();
  const claim = await call("POST", { action: "claim", taskId: task.id, owner: "finance:asha" });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const note = await call("POST", { action: "add_note", taskId: task.id, note: "checking with the gateway" });
  assert.equal(note.status, 200);
  const bad = await call("POST", { action: "dismiss", taskId: task.id });
  assert.equal(bad.status, 400, "dismiss without a note is refused");
  const detail = await call("GET", `taskId=${task.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data.events.map(e => e.event_type).sort(), ["claimed", "note"]);
  const unknown = await call("POST", { action: "resolve", taskId: "WQT-NOPE", note: "resolving a ghost task" });
  assert.equal(unknown.status, 404);
});

// ---- 5. Contracts --------------------------------------------------------------------------------

test("contract: gateway permission line, DB access rule, and the team surface exist", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /ops-work-queue"\)return "bookings\.manage"/);
  const source = fs.readFileSync(new URL("../app/api/ops-work-queue/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /globalThis/, "the route must get the DB via cloudflare:workers env, never globalThis");
  const page = fs.readFileSync(new URL("../app/team/operations/work-queue/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/api\/ops-work-queue/);
  const lib = fs.readFileSync(new URL("../lib/ops-work-queue.ts", import.meta.url), "utf8");
  for (const rule of ["provider_unassigned", "refund_requested", "payment_exception", "low_rating_callback", "relocation_enquiry", "food_renewal_payment_overdue", "lead_response_overdue"]) {
    assert.match(lib, new RegExp(`"${rule}"`), `detector ${rule} must stay wired`);
  }
});

// ---------------------------------------------------------------------------
// Command Centre TODAY revenue must recognize the same bookings as every other
// money surface. lib/pnl-reporting.ts and buildCompanyAnalytics both exclude
// cancelled AND draft; TODAY excluded only cancelled, so a draft booking made
// the founder's headline revenue disagree with the P&L for the same day.
// ---------------------------------------------------------------------------
test("real execution: TODAY revenue excludes draft as well as cancelled, matching the P&L", async () => {
  freshDb(); seedSourceTables();
  const noon = Date.UTC(2026, 8, 15, 12, 0, 0);
  const at = (hour) => new Date(Date.UTC(2026, 8, 15, hour, 0, 0)).toISOString();
  const insert = sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,'p1',?,?,?,'customer_app',?,'INR','{}','uat',?,?)");
  insert.run("R1", "rk1", "cus_1", "grooming", "rg1", at(9), at(10), "completed", 1200, NOW, NOW);
  insert.run("R2", "rk2", "cus_2", "boarding", "rg2", at(17), at(20), "confirmed", 4000, NOW, NOW);
  insert.run("R3", "rk3", "cus_3", "grooming", "rg3", at(15), at(16), "cancelled", 900, NOW, NOW);
  insert.run("R4", "rk4", "cus_4", "grooming", "rg4", at(14), at(15), "draft", 5000, NOW, NOW);

  const centre = (await workQueueSnapshot(globalThis.__WQ_DB__, { now: noon })).commandCentre;
  // Recognized revenue is 1200 + 4000. Neither the cancelled 900 nor the draft 5000 counts.
  assert.equal(centre.revenue, 5200, "draft and cancelled bookings must not be counted as revenue");
  assert.equal(centre.bookings, 2, "a draft is not a booking of the day");
  assert.equal(centre.cancelled, 1, "cancellations stay visible as a count");
  assert.equal(centre.completed, 1);
  // Per-service must obey the same rule as the headline.
  assert.equal(centre.byService.grooming.revenue, 1200, "grooming: only the completed 1200 is revenue");
  assert.equal(centre.byService.grooming.bookings, 1);
  assert.equal(centre.byService.grooming.cancelled, 1);
  assert.equal(centre.byService.boarding.revenue, 4000);

  // The same rule the P&L applies, asserted against the P&L's own source of truth.
  const recognized = sqlite.prepare("SELECT COALESCE(SUM(total_amount),0) total FROM canonical_bookings WHERE status!='cancelled' AND status!='draft' AND substr(scheduled_start,1,10)='2026-09-15'").get().total;
  assert.equal(centre.revenue, recognized, "TODAY revenue must equal the P&L's recognized revenue for the same day");
});

// ---------------------------------------------------------------------------
// Repeated sweeps and CONCURRENT sweeps are different guarantees. The scheduled
// worker can overlap with a human opening the screen (GET sweeps too), so two
// sweeps genuinely run at once in production.
// ---------------------------------------------------------------------------
test("real execution: two sweeps running at the same time still create each task exactly once", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  const results = await Promise.all([
    sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system:a" }),
    sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system:b" }),
    sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system:c" }),
  ]);
  const rows = sqlite.prepare("SELECT source_key, COUNT(*) n FROM ops_work_queue_tasks GROUP BY source_key HAVING n > 1").all();
  assert.deepEqual(rows, [], "no condition may produce a duplicate task under concurrent sweeps");
  const total = sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks").get().n;
  assert.equal(total, 7, "the seven conditions produce exactly seven tasks in total");
  // Creation is attributed once across the three racers, not three times.
  assert.equal(results.reduce((sum, r) => sum + r.totalCreated, 0), 7, "creation is counted once in total, not once per sweep");
});

test("real execution: a task past its SLA escalates exactly once even when sweeps race", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  await sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system" });
  // Drive every open task past its due time.
  const past = NOW - DAY;
  sqlite.prepare("UPDATE ops_work_queue_tasks SET due_at=? WHERE status='open'").run(past);
  const openCount = sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks WHERE status='open'").get().n;

  const raced = await Promise.all([
    sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system:a", now: NOW }),
    sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system:b", now: NOW }),
  ]);
  const escalatedTotal = raced.reduce((sum, r) => sum + r.escalated, 0);
  assert.equal(escalatedTotal, openCount, "each overdue task is escalated exactly once across the racers");
  const flagged = sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks WHERE escalated=1").get().n;
  assert.equal(flagged, openCount);
  // Escalating is not repeatable: a further sweep escalates nothing new.
  const again = await sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system", now: NOW });
  assert.equal(again.escalated, 0, "an already-escalated task never re-escalates");
});

// ---------------------------------------------------------------------------
// A condition that resolves itself in the source system. The task must not keep
// regenerating, and whatever happens to the existing task must be deliberate.
// ---------------------------------------------------------------------------
test("real execution: when the underlying condition clears, no new task is raised", async () => {
  freshDb(); seedSourceTables(); seedOneOfEachCondition();
  await sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system" });
  const before = sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks WHERE rule='provider_unassigned'").get().n;
  assert.equal(before, 1);

  // The work order gets assigned - the exception no longer exists in the source system.
  sqlite.prepare("UPDATE provider_work_orders SET status='assigned', provider_id='p_real'").run();
  const after = await sweepWorkQueue(globalThis.__WQ_DB__, { actorId: "system" });
  const stillOne = sqlite.prepare("SELECT COUNT(*) n FROM ops_work_queue_tasks WHERE rule='provider_unassigned'").get().n;
  assert.equal(stillOne, 1, "a cleared condition must not raise a second task");
  assert.equal(after.created.provider_unassigned ?? 0, 0, "and must not report a new creation");

  // The already-open task is left for a human to close: it is NOT auto-resolved, because the
  // queue is a record of what needed attention, and closure requires a note naming what was done.
  const task = sqlite.prepare("SELECT status, resolution_note FROM ops_work_queue_tasks WHERE rule='provider_unassigned'").get();
  assert.equal(task.status, "open", "the raised task stays open until a human closes it with a note");
  assert.equal(task.resolution_note, null);
});
