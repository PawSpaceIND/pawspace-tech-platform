/**
 * PawSpace Total Journey Audit, Wave 1 leftovers — findings that were reproduced and reported but not
 * corrected in the first pass. Every case here executes the real module or the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_W1L_DB__", "__PTJA_W1L_ENV__");

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

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_W1L_DB__ = db;
  globalThis.__PTJA_W1L_ENV__ = env;
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-W1L-01 (Wave 1 F5) — anyone can rebind another customer's app install to themselves
//
// identifyInstall writes
//   INSERT INTO install_identity_links ... ON CONFLICT(install_id) DO UPDATE SET customer_id=excluded.customer_id
// with no check that the install is unclaimed and no check that the caller owns the prior claim. It is
// reached from the fully public, unauthenticated /api/customer-otp verify action with a caller-supplied
// installId.
//
// MEASURED: the victim identified install INST-VICTIM-0001. An attacker then verified their OWN phone
// through the same public endpoint, replaying the victim's install id verbatim, and got 200 plus a
// session. install_identity_links held exactly ONE row for that install - the attacker's - and it kept
// the victim's original identified_at, so the takeover left no timestamp trace. The acquisition funnel
// then reported the victim's google_ads/diwali_dogs install as the attacker's, and the App-Inbound
// sales sweep created the 10-minute-SLA lead for the attacker while the victim never appeared at all.
//
// The correction is that a claim is not silently transferred: the first customer to identify an install
// keeps it. The attacker's own verify still succeeds - they proved their own phone and are entitled to
// their own session - they simply do not inherit somebody else's install. Refusing the login instead
// would be a stricter rule than the platform states anywhere, and would lock out a genuine second user
// of a reset or resold device.
// =====================================================================================================

test("W1L-01: an install already identified to one customer is not rebound to another", async () => {
  const { sqlite, db } = world();
  const funnel = await import("../lib/app-to-revenue-funnel.ts");

  const victim = await funnel.identifyInstall(db, { installId: "INST-VICTIM-0001", customerId: "CUS-VICTIM", at: 1000 });
  assert.equal(victim.customerId, "CUS-VICTIM", "the first identification binds the install");

  await funnel.identifyInstall(db, { installId: "INST-VICTIM-0001", customerId: "CUS-ATTACKER", at: 2000 });
  const link = sqlite.prepare("SELECT customer_id,identified_at FROM install_identity_links WHERE install_id='INST-VICTIM-0001'").get();
  assert.equal(String(link.customer_id), "CUS-VICTIM",
    `a second customer must not take over the install: ${JSON.stringify(link)}`);
  assert.equal(Number(link.identified_at), 1000, "and the original identification time stands");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM install_identity_links WHERE install_id='INST-VICTIM-0001'").get().n, 1,
    "exactly one link per install, as the primary key requires");
});

test("W1L-01: the rightful customer's own re-identification is still idempotent", async () => {
  // Non-vacuity. Refusing every conflicting write would satisfy the case above; the ordinary path is a
  // customer re-verifying on their own device, which must stay a harmless no-op.
  const { sqlite, db } = world();
  const funnel = await import("../lib/app-to-revenue-funnel.ts");

  await funnel.identifyInstall(db, { installId: "INST-OWN-1", customerId: "CUS-OWN", at: 1000 });
  const again = await funnel.identifyInstall(db, { installId: "INST-OWN-1", customerId: "CUS-OWN", at: 5000 });
  assert.equal(again.customerId, "CUS-OWN", "re-identifying the same pair still succeeds");
  const link = sqlite.prepare("SELECT customer_id,identified_at FROM install_identity_links WHERE install_id='INST-OWN-1'").get();
  assert.equal(String(link.customer_id), "CUS-OWN", "and keeps the same binding");
  assert.equal(Number(link.identified_at), 1000, "with the first identification time preserved");

  // A brand new install still binds normally.
  await funnel.identifyInstall(db, { installId: "INST-NEW-1", customerId: "CUS-OTHER", at: 6000 });
  assert.equal(String(sqlite.prepare("SELECT customer_id FROM install_identity_links WHERE install_id='INST-NEW-1'").get().customer_id), "CUS-OTHER",
    "an unclaimed install binds to whoever identifies it");
});

// =====================================================================================================
// PTJA-W1L-02 (Wave 1 F22) — decline / *_unavailable / no_show regress a COMPLETED or CANCELLED booking
// back to reassignment_needed, in Sitting, Walking and Boarding
//
// In all three verticals the recovery branch reads the booking row and never inspects its status, so one
// ordinary partner-authenticated call overwrites a committed 'completed' or 'cancelled' booking with
// 'reassignment_needed' - and answers 200 with the literal `bookingPreserved:true` while the completion
// is being destroyed. A customer notification is queued saying Operations is protecting the booking.
//
// MEASURED, six calls, all successful:
//   Sitting completed  -> canonical_bookings 'reassignment_needed', work order 'recovery_pending',
//                         decision 'reassignment_needed', reservation 'cancelled', new recovery case.
//   Sitting cancelled  -> identical; the cancellation is simply gone.
//   Walking completed  -> booking 'reassignment_needed' while walking_sessions stays 'completed' (that
//                         one UPDATE does exclude completed), so the session and its booking disagree.
//   Boarding completed -> booking 'reassignment_needed', stay 'recovery_pending', but check_in_status
//                         stays 'complete'.
//
// Settlement keys off status='completed', so a regressed booking silently drops out of the payout queue;
// a regressed CANCELLED booking re-enters the recovery queue as live work and Ops can offer a cancelled
// customer's slot to a new provider.
//
// The correction is the guard the branch was missing: a booking that is already finished or cancelled
// has no assignment left to recover, so recovery is refused. Nothing else about recovery changes - a
// live booking declines exactly as before.
// =====================================================================================================

const RECOVERY_VERTICALS = [
  {
    label: "Sitting", module: "../lib/sitting-lifecycle.ts", entry: "mutateSittingBooking",
    serviceCode: "pet_sitting", action: "decline", idKey: "bookingId", id: "BK-SIT",
    extra: () => {},
  },
  {
    label: "Walking", module: "../lib/walking-lifecycle.ts", entry: "mutateWalkingBooking",
    serviceCode: "dog_walking", action: "decline", idKey: "bookingId", id: "BK-WALK",
    extra: () => {},
  },
];

function lifecycleWorld(serviceCode, bookingId, status) {
  const { sqlite, db } = world();
  const now = Date.now();
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT DEFAULT '[]',source_pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,updated_at INTEGER,created_at INTEGER);
CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL DEFAULT 0,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER);
CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT);
CREATE TABLE IF NOT EXISTS walking_sessions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,occurrence_number INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',handover_status TEXT NOT NULL DEFAULT 'pending',completion_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL);
`);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,'blr','blr-east',?,'pkg','Package',?,'PROV-A','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z',?,2000,'seed',?,?)")
    .run(bookingId, `ik-${bookingId}-${status}`, "CUS-1", serviceCode, `SG-${bookingId}`, status, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,'PROV-A','Provider A','full_time',?,'2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z',?,?,?)")
    .run(`WO-${bookingId}`, bookingId, `SG-${bookingId}`, serviceCode, status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "assigned", now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,2000,2000,'upi','prepaid','captured','uat_sandbox',?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, "CUS-1", `pik-${bookingId}`, now, now);
  sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,updated_at) VALUES (?,?,'PROV-A','accepted',?,?,?)")
    .run(`SG-${bookingId}`, bookingId, now, now + 3600000, now);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,occurrence_number,status,created_at) VALUES (?,?,'PROV-A',?,'blr','blr-east','CUS-1','[]','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z',1,'confirmed',?)")
    .run(`RES-${bookingId}`, `SG-${bookingId}`, serviceCode, now);
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,updated_at) VALUES (?,'auto','[]','PROV-A','assigned','seed',?)")
    .run(`SG-${bookingId}`, now);
  sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,'PROV-A',1,'2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z',?,?,?)")
    .run(`WS-${bookingId}`, bookingId, `SG-${bookingId}`, `RES-${bookingId}`, status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "scheduled", now, now);
  return { sqlite, db, now };
}

for (const vertical of RECOVERY_VERTICALS) {
  for (const status of ["completed", "cancelled"]) {
    test(`W1L-02 (${vertical.label}): ${vertical.action} cannot regress a ${status} booking`, async () => {
      const { sqlite, db } = lifecycleWorld(vertical.serviceCode, vertical.id, status);
      const module = await import(vertical.module);
      const result = await module[vertical.entry](db, {
        bookingId: vertical.id, action: vertical.action, actorId: "PROV-A",
        idempotencyKey: `rec-${status}`, reason: "provider fell ill",
      }).then((value) => ({ ok: true, value }), async (error) => ({
        ok: false, status: error instanceof Response ? error.status : 0,
        message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
      }));

      assert.equal(result.ok, false,
        `a ${status} booking has no assignment left to recover: ${JSON.stringify(result)}`);
      assert.equal(String(sqlite.prepare(`SELECT status FROM canonical_bookings WHERE id='${vertical.id}'`).get().status), status,
        `and its status must be untouched, not overwritten with reassignment_needed`);
    });
  }

  test(`W1L-02 (${vertical.label}): a live booking still declines into recovery`, async () => {
    // Non-vacuity. Refusing every decline would satisfy the cases above and break provider recovery,
    // which is the whole purpose of the branch.
    const { sqlite, db } = lifecycleWorld(vertical.serviceCode, vertical.id, "assigned");
    const module = await import(vertical.module);
    const result = await module[vertical.entry](db, {
      bookingId: vertical.id, action: vertical.action, actorId: "PROV-A",
      idempotencyKey: "rec-live", reason: "provider fell ill",
    }).then((value) => ({ ok: true, value }), async (error) => ({
      ok: false, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
    }));
    assert.equal(result.ok, true, `a live booking must still be recoverable: ${JSON.stringify(result)}`);
    assert.equal(String(sqlite.prepare(`SELECT status FROM canonical_bookings WHERE id='${vertical.id}'`).get().status), "reassignment_needed",
      "and enters reassignment exactly as before");
  });
}
