import { POST as stagingLoginPost } from "../app/api/staging-login/route";
import { POST as sittingPost } from "../app/api/sitting-lifecycle/route";
import { ensureSecurityTables, requirePermission, resolveActor } from "../lib/server-auth";
import { ensureSittingLifecycleTables } from "../lib/sitting-lifecycle";

type Env = { DB: D1Database };
type Row = Record<string, unknown>;

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const text = (value: unknown) => String(value ?? "").trim();

async function ensureHarnessTables(db: D1Database) {
  await ensureSecurityTables(db);
  await ensureSittingLifecycleTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,schedule_group_id TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,status TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (id TEXT PRIMARY KEY,group_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER)"),
  ]);
}

async function seedBooking(db: D1Database, bookingId: string, status = "confirmed") {
  await ensureHarnessTables(db);
  const now = Date.now();
  const providerId = `P04-PROVIDER-${bookingId}`;
  const customerId = `P04-CUSTOMER-${bookingId}`;
  await db.batch([
    db.prepare("DELETE FROM sitting_action_keys WHERE booking_id=?").bind(bookingId),
    db.prepare("DELETE FROM sitting_care_events WHERE booking_id=?").bind(bookingId),
    db.prepare("DELETE FROM sitting_customer_notifications WHERE booking_id=?").bind(bookingId),
    db.prepare("DELETE FROM provider_work_orders WHERE booking_id=?").bind(bookingId),
    db.prepare("DELETE FROM canonical_bookings WHERE id=?").bind(bookingId),
  ]);
  await db.batch([
    db.prepare("INSERT INTO canonical_bookings (id,service_code,customer_id,provider_id,schedule_group_id,status,created_at,updated_at) VALUES (?,'pet_sitting',?,?,NULL,?,?,?)").bind(bookingId, customerId, providerId, status, now, now),
    db.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,status,updated_at) VALUES (?,?,?,?,?)").bind(`P04-WO-${bookingId}`, bookingId, providerId, status === "confirmed" ? "offered" : status, now),
  ]);
  return { bookingId, providerId, customerId, status };
}

async function state(db: D1Database, bookingId: string) {
  const booking = await db.prepare("SELECT id,status,provider_id,customer_id,updated_at FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
  const workOrder = await db.prepare("SELECT id,status,provider_id,updated_at FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>();
  const actionKeys = await db.prepare("SELECT COUNT(*) count FROM sitting_action_keys WHERE booking_id=?").bind(bookingId).first<{ count: number }>();
  const acceptedEvents = await db.prepare("SELECT COUNT(*) count FROM sitting_care_events WHERE booking_id=? AND event_type='sitter_accepted'").bind(bookingId).first<{ count: number }>();
  const notifications = await db.prepare("SELECT COUNT(*) count FROM sitting_customer_notifications WHERE booking_id=?").bind(bookingId).first<{ count: number }>();
  return {
    booking,
    workOrder,
    actionKeyCount: Number(actionKeys?.count || 0),
    acceptedEventCount: Number(acceptedEvents?.count || 0),
    notificationCount: Number(notifications?.count || 0),
  };
}

async function controlledClaimRace(request: Request, env: Env) {
  const actor = await resolveActor(request);
  requirePermission(actor, "bookings.manage");
  const body = await request.json().catch(() => ({})) as Row;
  const bookingId = text(body.bookingId);
  if (!bookingId) return json({ error: "bookingId is required" }, 400);
  await seedBooking(env.DB, bookingId, "confirmed");

  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });

  const actorRun = async (actorId: string) => {
    const actorStart = performance.now();
    const row = await env.DB.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
    const observedStatus = text(row?.status);
    reads += 1;
    if (reads === 2) release();
    await bothRead;
    const updateStart = performance.now();
    const result = await env.DB.prepare("UPDATE canonical_bookings SET status='assigned',updated_at=? WHERE id=? AND status=?").bind(Date.now(), bookingId, observedStatus).run();
    const changes = Number((result as { meta?: { changes?: number } })?.meta?.changes || 0);
    const updateEnd = performance.now();
    return {
      actorId,
      observedStatus,
      metaChanges: changes,
      httpStatus: changes === 1 ? 200 : 409,
      body: changes === 1 ? { bookingId, status: "assigned" } : { error: "Unable to update lifecycle. Invalid or stale state." },
      timingMs: {
        total: Number((updateEnd - actorStart).toFixed(3)),
        claim: Number((updateEnd - updateStart).toFixed(3)),
      },
    };
  };

  const startedAt = new Date().toISOString();
  const raceStart = performance.now();
  const outcomes = await Promise.all([actorRun("controlled-A"), actorRun("controlled-B")]);
  const raceEnd = performance.now();
  return json({
    bookingId,
    startedAt,
    raceDurationMs: Number((raceEnd - raceStart).toFixed(3)),
    outcomes,
    finalState: await state(env.DB, bookingId),
  });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/api/staging-login" && request.method === "POST") return stagingLoginPost(request);
    if (url.pathname === "/api/sitting-lifecycle" && request.method === "POST") return sittingPost(request);
    if (url.pathname === "/setup" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Row;
      const bookingId = text(body.bookingId);
      if (!bookingId) return json({ error: "bookingId is required" }, 400);
      return json({ data: await seedBooking(env.DB, bookingId, text(body.status) || "confirmed") });
    }
    if (url.pathname === "/state" && request.method === "GET") {
      const bookingId = text(url.searchParams.get("bookingId"));
      if (!bookingId) return json({ error: "bookingId is required" }, 400);
      return json({ data: await state(env.DB, bookingId) });
    }
    if (url.pathname === "/controlled-race" && request.method === "POST") return controlledClaimRace(request, env);
    return new Response("Not found", { status: 404 });
  },
};
