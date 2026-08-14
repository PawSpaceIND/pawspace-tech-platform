import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";

type Db = Awaited<ReturnType<typeof database>>;
type Row = Record<string, unknown>;

async function ensureTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_operational_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,reason TEXT NOT NULL,impact_minutes INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_rebooking_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,source_event_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',reason TEXT NOT NULL,eligible_at INTEGER NOT NULL,selected_start TEXT,assigned_provider_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY,customer_id TEXT,booking_id TEXT,lead_id TEXT,category TEXT NOT NULL,priority TEXT NOT NULL,subject TEXT NOT NULL,detail TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,sla_due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',escalation_level INTEGER NOT NULL DEFAULT 0,customer_status TEXT NOT NULL DEFAULT 'We received your request',resolution TEXT,root_cause TEXT,resolution_evidence TEXT,reopened_count INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,resolved_at INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_admin_actions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',actor_email TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

function parse(value: unknown) {
  try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}

export async function GET(request: Request) {
  try {
    await authorize(request, "bookings.manage");
    const db = await database();
    await ensureTables(db);
    const rows = await db.prepare(`SELECT b.*,c.name customer_name,c.primary_phone,c.secondary_phone,c.email customer_email,c.source customer_source,
      w.id work_order_id,w.provider_name,w.provider_model,w.status work_order_status,w.occurrence_count,w.assignment_json,
      p.id payment_id,p.amount payment_amount,p.amount_due_now,p.method payment_method,p.mode payment_mode,p.status payment_status,p.gateway,p.detail_json payment_detail_json
      FROM canonical_bookings b
      JOIN canonical_customers c ON c.id=b.customer_id
      JOIN provider_work_orders w ON w.booking_id=b.id
      JOIN booking_payments p ON p.booking_id=b.id
      ORDER BY b.scheduled_start DESC LIMIT 150`).all<Row>();

    const bookings = [];
    for (const row of rows.results) {
      const [pets, lifecycle, operations, notifications, rebooking, refunds, tickets, adminActions] = await Promise.all([
        db.prepare("SELECT id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(row.customer_id, row.pet_ids_json).all<Row>(),
        db.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at DESC").bind(row.id).all<Row>(),
        db.prepare("SELECT * FROM booking_operational_events WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all<Row>(),
        db.prepare("SELECT * FROM booking_customer_notifications WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all<Row>(),
        db.prepare("SELECT * FROM booking_rebooking_cases WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all<Row>(),
        db.prepare("SELECT * FROM booking_refund_cases WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all<Row>(),
        db.prepare("SELECT * FROM customer_experience_tickets WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all<Row>(),
        db.prepare("SELECT * FROM booking_admin_actions WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all<Row>(),
      ]);
      bookings.push({
        ...row,
        pricing: parse(row.pricing_json),
        assignment: parse(row.assignment_json),
        paymentDetail: parse(row.payment_detail_json),
        pets: pets.results,
        lifecycle: lifecycle.results,
        operations: operations.results,
        notifications: notifications.results,
        rebooking: rebooking.results,
        refunds: refunds.results,
        tickets: tickets.results,
        adminActions: adminActions.results,
      });
    }
    return Response.json({ source: "canonical UAT database", bookings });
  } catch (error) {
    return authError(error, "Unable to load Booking Command Center");
  }
}

export async function POST(request: Request) {
  try {
    const actor = await authorize(request, "bookings.manage");
    const db = await database();
    await ensureTables(db);
    const body = await request.json() as Row;
    const bookingId = String(body.bookingId || "");
    const action = String(body.action || "");
    const reason = String(body.reason || "").trim();
    if (!bookingId || !["call_customer", "whatsapp_customer", "open_tracking", "review_reassignment"].includes(action)) return Response.json({ error: "Valid booking and action are required" }, { status: 400 });
    if (reason.length < 5) return Response.json({ error: "A clear action reason is required" }, { status: 400 });
    const booking = await db.prepare("SELECT customer_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
    if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });
    const now = Date.now(), eventId = crypto.randomUUID();
    await db.prepare("INSERT INTO booking_admin_actions (id,booking_id,action,reason,detail_json,actor_email,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(eventId, bookingId, action, reason, JSON.stringify({ uat: true }), actor.email, now).run();
    if (action === "whatsapp_customer") await db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), bookingId, booking.customer_id, "whatsapp", "admin_booking_update", "PawSpace Admin opened a service update for this booking.", "uat_queued", eventId, now).run();
    await securityAudit(db, actor, action, "booking", bookingId, "completed", { reason, uat: true });
    return Response.json({ ok: true, id: eventId, deliveryStatus: action === "whatsapp_customer" ? "uat_queued" : "recorded" }, { status: 201 });
  } catch (error) {
    return authError(error, "Unable to record booking action");
  }
}
