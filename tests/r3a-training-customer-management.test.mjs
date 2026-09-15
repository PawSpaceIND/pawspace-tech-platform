/**
 * R3-A2 — Dog Training had no cancel and no reschedule screen at all.
 *
 * MEASURED BEFORE THE FIX, in a browser, as a real OTP customer:
 *   • the Activity card for a training booking showed NO manage link — every other vertical has one,
 *     and lib/customer-activity.ts simply had no 'dog_training' entry;
 *   • /training/manage?bookingId=… was a 404 "We couldn't find that page";
 *   • and the checkout the customer had just agreed to said "Cancellation requests go for PawSpace
 *     approval. Once approved, the unused-session value is refunded…", while the plan promised
 *     rescheduling.
 * /api/training-cancellation and /api/training-customer-session-change both already existed. The
 * promise was made, the endpoints were live, and nothing a customer could click reached either.
 *
 * These tests EXECUTE the real screen: the component's effects run, the real buttons are clicked, and
 * every fetch the component makes is served by the REAL route handlers against a real SQLite-backed
 * D1. The assertions are on the rows the server actually wrote — a reschedule case and a cancellation
 * case — not on the fact that a button exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/taxi-harness.mjs";
import { mount, find, all, textOf, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3A_TRAINING_MANAGE_DB__", "__R3A_TRAINING_MANAGE_ENV__");

const activity = await import("../lib/customer-activity.ts");
const programme = await import("../lib/training-programme.ts");
const { default: TrainingCustomerManagement } = await import("../app/training/manage/training-customer-management.tsx");
const programmeRoute = await import("../app/api/training-programmes/route.ts");
const cancellationRoute = await import("../app/api/training-cancellation/route.ts");
const sessionChangeRoute = await import("../app/api/training-customer-session-change/route.ts");

const BOOKING_ID = "BKG-R3A-TRAIN-1";
const CUSTOMER_ID = "CUS-R3A-TRAIN-1";
const GROUP_ID = "GRP-R3A-TRAIN-1";
const PROVIDER_ID = "train_kiran";
/** localhost is the triple-gated local preview origin these suites use to reach a route as a customer. */
const ORIGIN = "http://localhost";

function ensureBookingTables(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT NOT NULL,pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT NOT NULL,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL DEFAULT 0,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
}

/** A four-session programme, materialized through the real production writer. */
async function trainingWorld({ sessions = 4 } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3A_TRAINING_MANAGE_DB__ = db;
  globalThis.__R3A_TRAINING_MANAGE_ENV__ = {};
  ensureBookingTables(sqlite);
  const now = Date.now();
  const first = Math.floor((now + 72 * 3_600_000) / 1000) * 1000;
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(CUSTOMER_ID, "blr", "R3A Training Customer", "9100000199", now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,pricing_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(BOOKING_ID, CUSTOMER_ID, '["PET-R3A-1"]', "blr", "blr-east", "dog_training", "dog-training-8", "Behaviour Programme", GROUP_ID, PROVIDER_ID,
      new Date(first).toISOString(), new Date(first + 3_600_000).toISOString(), "confirmed", 24000, "{}", now, now);
  for (let index = 0; index < sessions; index += 1) {
    const start = first + index * 7 * 86_400_000;
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)")
      .run(`RES-R3A-${index + 1}`, GROUP_ID, PROVIDER_ID, "dog_training", "blr", "blr-east", CUSTOMER_ID, '["PET-R3A-1"]',
        new Date(start).toISOString(), new Date(start + 3_600_000).toISOString(), index + 1, "assigned", now);
  }
  await programme.materializeTrainingProgramme(db, { bookingId: BOOKING_ID, actorId: "seed@pawspace.example" });
  return { sqlite, db };
}

/** Every fetch the screen makes goes to the REAL route handler, on the real D1. */
function bridgeFetch(t) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    seen.push(`${init.method || "GET"} ${href}`);
    const request = new Request(new URL(href, ORIGIN), { ...init, headers: { ...(init.headers || {}) } });
    if (href.startsWith("/api/training-programmes")) return programmeRoute.GET(request);
    if (href.startsWith("/api/training-cancellation")) return cancellationRoute.POST(request);
    if (href.startsWith("/api/training-customer-session-change")) return sessionChangeRoute.POST(request);
    throw new Error(`the Training manage screen made an unexpected request: ${href}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return seen;
}

const setValue = (node, value) => node.props.onChange({ target: { value } });
const buttonNamed = (tree, label) => {
  const node = find(tree, (n) => n.type === "button" && textOf(n).trim() === label);
  assert.ok(node, `a button labelled "${label}" is on screen`);
  return node;
};
const inputById = (tree, id) => {
  const node = find(tree, (n) => (n.type === "input" || n.type === "select") && n.props?.id === id);
  assert.ok(node, `a field #${id} is on screen`);
  return node;
};

test("the Activity card now carries a Dog Training manage link, and it keeps the exact booking id", () => {
  assert.equal(
    activity.customerBookingManageHref({ id: "B & 1", serviceCode: "dog_training", status: "confirmed", scheduledStart: "" }),
    "/training/manage?bookingId=B%20%26%201",
  );
  // The other verticals are untouched, and an unsupported code still produces no link at all.
  assert.equal(activity.customerBookingManageHref({ id: "B", serviceCode: "dog_walking", status: "confirmed", scheduledStart: "" }), "/walking/manage?bookingId=B");
  assert.equal(activity.customerBookingManageHref({ id: "B", serviceCode: "pet_food", status: "confirmed", scheduledStart: "" }), null);
});

test("OUTCOME: the customer asks to move a session and the server records the reschedule request", async (t) => {
  const { db, sqlite } = await trainingWorld();
  bridgeFetch(t);

  const screen = mount(TrainingCustomerManagement, { bookingId: BOOKING_ID }, { label: "TrainingCustomerManagement" });
  await screen.settle();
  const text = screenText(screen.html());
  assert.match(text, /Manage your training programme/);
  assert.match(text, /Behaviour Programme/, "the real programme loaded through the real route");
  // Times are IST-labelled, because the booking flow labels every time IST.
  assert.match(text, /IST/);

  const before = sqlite.prepare("SELECT id,status FROM training_sessions WHERE booking_id=? ORDER BY sequence_no").all(BOOKING_ID);
  assert.equal(before[0].status, "scheduled");

  setValue(inputById(screen.tree(), "training-reschedule-reason"), "Family travel that week");
  await screen.settle();
  buttonNamed(screen.tree(), "Request reschedule").props.onClick();
  await screen.settle();

  const after = sqlite.prepare("SELECT id,status FROM training_sessions WHERE id=?").get(before[0].id);
  assert.equal(after.status, "reschedule_requested", "the server must have moved the session into a reschedule request");
  const shown = screenText(screen.html());
  assert.match(shown, /Reschedule requested/);
  assert.doesNotMatch(shown, /Unable to request/);
  // It is a REQUEST, not a booking: the screen must not claim a new time was confirmed.
  assert.match(shown, /confirms the new time with your trainer/);
  assert.ok(await db.prepare("SELECT id FROM training_session_events WHERE session_id=?").bind(before[0].id).first(), "a governed session event was written");
});

test("OUTCOME: the customer asks to cancel and the server opens a real cancellation case", async (t) => {
  const { sqlite } = await trainingWorld();
  bridgeFetch(t);

  const screen = mount(TrainingCustomerManagement, { bookingId: BOOKING_ID }, { label: "TrainingCustomerManagement" });
  await screen.settle();

  setValue(inputById(screen.tree(), "training-cancel-reason"), "Moving out of Bengaluru next month");
  await screen.settle();
  buttonNamed(screen.tree(), "Request cancellation review").props.onClick();
  await screen.settle();

  const opened = sqlite.prepare("SELECT id,booking_id,status,reason,requested_by FROM training_cancellation_cases WHERE booking_id=?").get(BOOKING_ID);
  assert.ok(opened, "a cancellation case must exist for this booking");
  assert.equal(opened.reason, "Moving out of Bengaluru next month");
  const shown = screenText(screen.html());
  assert.doesNotMatch(shown, /Unable to request/);
  // Never promise money the server did not calculate.
  assert.match(shown, /PawSpace reviews it|Finance publishes the cancellation policy/);
  assert.doesNotMatch(shown, /refunded to your account/);
  // The programme itself is NOT cancelled by asking: approval is a separate, staff-side step.
  assert.equal(sqlite.prepare("SELECT status FROM training_programmes WHERE booking_id=?").get(BOOKING_ID).status, "scheduled");
});

test("a booking id that matches nothing says so instead of drawing an empty programme", async (t) => {
  await trainingWorld();
  bridgeFetch(t);
  const screen = mount(TrainingCustomerManagement, { bookingId: "BKG-DOES-NOT-EXIST" }, { label: "TrainingCustomerManagement" });
  await screen.settle();
  const text = screenText(screen.html());
  assert.match(text, /could not (load|find) this Dog Training programme|could not find that Dog Training programme/i);
  assert.equal(all(screen.tree(), (n) => n.type === "button").length, 0, "a screen with no record must offer no controls");
});
