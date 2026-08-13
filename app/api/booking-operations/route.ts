import { authError, requirePermission, requireProviderOwnership, resolveActor } from "../../../lib/server-auth";
import { repairSchemaDrift } from "../../../lib/schema-drift-repair";

/** Per-isolate guard so the in-place column repair runs once, not on every request. */
const driftRepaired = new WeakSet<object>();

type OperationAction =
  | "package_upgrade"
  | "apply_package_upgrade"
  | "service_overrun"
  | "running_late"
  | "vehicle_issue"
  | "rebook_requested"
  | "refund_requested"
  | "refund_status";

type OperationInput = {
  bookingId: string;
  providerId: string;
  action: OperationAction;
  reason: string;
  impactMinutes?: number;
  upgradedPackageName?: string;
  upgradedAmount?: number;
  refundCaseId?: string;
  upgradeRequestId?: string;
  refundStatus?: "approved" | "processing" | "completed" | "rejected";
  gatewayReference?: string;
};

const actions = new Set<OperationAction>([
  "package_upgrade",
  "apply_package_upgrade",
  "service_overrun",
  "running_late",
  "vehicle_issue",
  "rebook_requested",
  "refund_requested",
  "refund_status",
]);
const json = (value: unknown, status = 200) => Response.json(value, { status });

/**
 * A provider reporting what happened on a job is a communications act. Changing what a customer owes
 * is not: `apply_package_upgrade` moves canonical_bookings.total_amount and booking_payments.amount,
 * so it is a pricing decision, and refund progress belongs to Finance.
 */
const REQUIRED_PERMISSION: Record<OperationAction, "communications.message" | "pricing.manage" | "payments.manage"> = {
  package_upgrade: "communications.message",
  apply_package_upgrade: "pricing.manage",
  service_overrun: "communications.message",
  running_late: "communications.message",
  vehicle_issue: "communications.message",
  rebook_requested: "communications.message",
  refund_requested: "communications.message",
  refund_status: "payments.manage",
};
async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

async function ensureTables(db: Awaited<ReturnType<typeof database>>) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS booking_operational_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,reason TEXT NOT NULL,impact_minutes INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_rebooking_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,source_event_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',reason TEXT NOT NULL,eligible_at INTEGER NOT NULL,selected_start TEXT,assigned_provider_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_package_upgrade_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,source_event_id TEXT NOT NULL,requested_package_name TEXT NOT NULL,requested_amount REAL NOT NULL,previous_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pricing_approval_required',requested_by TEXT NOT NULL,approved_by TEXT,approved_amount REAL,decision_reason TEXT,claim_token TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_package_upgrade_booking ON booking_package_upgrade_requests(booking_id,status,created_at)"),
  ]);
  // The DDL above is CREATE TABLE IF NOT EXISTS, which is a no-op once the table exists — so it cannot
  // add claim_token to a database that created booking_package_upgrade_requests before the approval
  // became a claim-token compare-and-set. On such a database every apply_package_upgrade fails with
  // "no such column: claim_token". repairSchemaDrift adds it in place; the column is registered there.
  //
  // Once per isolate: the repair is idempotent (it checks PRAGMA table_info before altering) but it costs
  // a lookup per registered column, and this route is on a per-request path.
  if (!driftRepaired.has(db)) {
    driftRepaired.add(db);
    await repairSchemaDrift(db).catch(() => driftRepaired.delete(db));
  }
}

function validate(input: OperationInput) {
  if (!input.bookingId || !input.providerId) return "Booking and provider are required";
  if (!actions.has(input.action)) return "Unsupported order update";
  if (!input.reason || input.reason.trim().length < 5) return "A clear reason is required";
  if ((input.impactMinutes ?? 0) < 0 || (input.impactMinutes ?? 0) > 360)
    return "Delay must be between 0 and 360 minutes";
  if (input.action === "package_upgrade" && (!input.upgradedPackageName || !input.upgradedAmount))
    return "Approved package and amount are required";
  if (input.action === "apply_package_upgrade" && !input.upgradeRequestId)
    return "Upgrade request is required";
  if (input.action === "refund_status" && (!input.refundCaseId || !input.refundStatus))
    return "Refund case and next status are required";
  return null;
}

function customerMessage(action: OperationAction, minutes: number, rebook: boolean) {
  if (action === "package_upgrade")
    return "Your PawSpace package upgrade has been requested on this order and is awaiting confirmation. Nothing has changed on your booking or your price yet - we will confirm before anything is applied.";
  if (action === "vehicle_issue")
    return `Your provider reported a vehicle issue. The latest expected delay is ${minutes} minutes.${rebook ? " You may keep this booking or choose a new slot." : " Live tracking will keep updating."}`;
  if (action === "running_late" || action === "service_overrun")
    return `Your provider is running about ${minutes} minutes late.${rebook ? " You may keep this booking or choose a new slot." : " Please check live tracking for the latest ETA."}`;
  if (action === "rebook_requested") return "Your rebooking request is recorded. PawSpace Ops will protect your payment and confirm a replacement slot.";
  return "Your refund request is recorded and can be tracked from this order until the amount is completed.";
}

export async function GET(request: Request) {
  try {
    const db = await database();
    await ensureTables(db);
    const bookingId = new URL(request.url).searchParams.get("bookingId");
    if (!bookingId) return json({ error: "Booking ID is required" }, 400);
    const [events, notifications, rebooking, refunds] = await Promise.all([
      db.prepare("SELECT * FROM booking_operational_events WHERE booking_id=? ORDER BY created_at DESC").bind(bookingId).all(),
      db.prepare("SELECT * FROM booking_customer_notifications WHERE booking_id=? ORDER BY created_at DESC").bind(bookingId).all(),
      db.prepare("SELECT * FROM booking_rebooking_cases WHERE booking_id=? ORDER BY created_at DESC").bind(bookingId).all(),
      db.prepare("SELECT * FROM booking_refund_cases WHERE booking_id=? ORDER BY created_at DESC").bind(bookingId).all(),
    ]);
    return json({ data: { events: events.results, notifications: notifications.results, rebooking: rebooking.results, refunds: refunds.results } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load order operations" }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as OperationInput;
    const problem = validate(input);
    if (problem) return json({ error: problem }, 400);
    const db = await database();
    await ensureTables(db);
    const now = Date.now();

    // The route authorises itself rather than trusting the gateway alone, and it verifies that the
    // caller may act for the provider they claim: providerId arrives in the request body, so without
    // this check any holder of the action's permission could file events - and, before the split
    // below, rewrite the price - against a booking assigned to somebody else entirely.
    const actor = await resolveActor(request);
    requirePermission(actor, REQUIRED_PERMISSION[input.action]);
    const booking = await db.prepare("SELECT customer_id,provider_id,total_amount FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Record<string, unknown>>();
    if (!booking) return json({ error: "Booking not found" }, 404);
    if (REQUIRED_PERMISSION[input.action] === "communications.message") {
      await requireProviderOwnership(db, actor, input.providerId);
      if (String(booking.provider_id) !== String(input.providerId)) return json({ error: "This booking is assigned to another provider" }, 403);
    }
    if (input.action === "apply_package_upgrade") {
      const upgrade = await db.prepare("SELECT * FROM booking_package_upgrade_requests WHERE id=? AND booking_id=?").bind(input.upgradeRequestId, input.bookingId).first<Record<string, unknown>>();
      if (!upgrade) return json({ error: "Package upgrade request not found" }, 404);
      if (String(upgrade.status) !== "pricing_approval_required") return json({ error: `Package upgrade is already ${String(upgrade.status)}` }, 409);
      // Segregation of duties, matching the Boarding cancellation rule: whoever reported the upgrade
      // cannot also be the one who prices it.
      if (String(upgrade.requested_by) === actor.email) return json({ error: "Segregation of duties: the requester cannot approve their own package upgrade" }, 409);
      // The amount is the priced decision, not the provider's number. It must be explicit, real, and
      // an upgrade - a "package upgrade" that lowers what the customer owes is a refund, and refunds
      // have their own governed path.
      const amount = Number(input.upgradedAmount ?? upgrade.requested_amount);
      const previous = Number(booking.total_amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: "Approved upgrade amount must be a real positive figure" }, 400);
      if (amount < previous) return json({ error: "A package upgrade cannot reduce the booking total; use the governed refund path" }, 409);
      const eventId = crypto.randomUUID(), claim = crypto.randomUUID();
      // Claim, money, audit and the `applied` transition are ONE atomic batch, so `applied` can only
      // mean the financial application committed.
      //
      // Two earlier shapes both failed. Putting the compare-and-set first in the batch and never
      // reading its result let a losing approval rewrite the price anyway. Claiming in a separate
      // statement before the batch fixed that, but a failure inside the batch then rolled back the
      // money while leaving the claim committed - the request read `applied` for an amount that was
      // never applied, and no approver could retry it because the status no longer matched.
      //
      // Now every dependent statement is guarded by EXISTS on this attempt's own `claim_token`, so a
      // caller whose CAS changed nothing writes nothing - it cannot ride the winner's claim. And
      // because the CAS is inside the batch, any failure rolls the whole thing back: the request
      // returns to pricing_approval_required, the money is untouched, and the next approval retries
      // cleanly. Either all seven facts commit together, or none of them do.
      const guard = "EXISTS (SELECT 1 FROM booking_package_upgrade_requests WHERE id=? AND claim_token=?)";
      const applied = await db.batch([
        db.prepare("UPDATE booking_package_upgrade_requests SET status='applied',approved_by=?,approved_amount=?,decision_reason=?,claim_token=?,updated_at=? WHERE id=? AND status='pricing_approval_required'")
          .bind(actor.email, amount, input.reason.trim(), claim, now, upgrade.id),
        db.prepare(`UPDATE canonical_bookings SET package_name=?,total_amount=?,pricing_json=json_set(pricing_json,'$.providerUpgrade',json(?)),updated_at=? WHERE id=? AND ${guard}`)
          .bind(String(upgrade.requested_package_name), amount, JSON.stringify({ approved: true, approvedBy: actor.email, requestId: upgrade.id, recordedAt: now }), now, input.bookingId, upgrade.id, claim),
        db.prepare(`UPDATE booking_payments SET amount=?,detail_json=json_set(detail_json,'$.packageUpgrade',json(?)),updated_at=? WHERE booking_id=? AND ${guard}`)
          .bind(amount, JSON.stringify({ packageName: String(upgrade.requested_package_name), approved: true, approvedBy: actor.email }), now, input.bookingId, upgrade.id, claim),
        db.prepare(`INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) SELECT ?,?,?,?,?,0,?,?,? WHERE ${guard}`)
          .bind(eventId, input.bookingId, String(upgrade.provider_id), "package_upgrade.applied", input.reason.trim(), JSON.stringify({ requestId: upgrade.id, previousAmount: previous, approvedAmount: amount }), actor.email, now, upgrade.id, claim),
        db.prepare(`INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`)
          .bind(crypto.randomUUID(), input.bookingId, "package_upgrade.applied", "booking", input.bookingId, actor.email, JSON.stringify({ requestId: upgrade.id, previousAmount: previous, approvedAmount: amount }), now, upgrade.id, claim),
        db.prepare(`INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`)
          .bind(crypto.randomUUID(), input.bookingId, String(booking.customer_id ?? ""), "whatsapp", "package_upgrade.applied", "Your PawSpace package upgrade has been confirmed. The revised scope and price are visible in your booking.", "queued", eventId, now, upgrade.id, claim),
        db.prepare(`INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`)
          .bind(crypto.randomUUID(), actor.email, actor.roleCode, "booking_operations.apply_package_upgrade", "booking", input.bookingId, "completed", JSON.stringify({ requestId: upgrade.id, previousAmount: previous, approvedAmount: amount }), now, upgrade.id, claim),
      ]);
      // The CAS is the first statement; if it changed nothing this attempt lost the race, and every
      // guarded statement above it wrote nothing either.
      if (Number(applied[0]?.meta?.changes || 0) !== 1) return json({ error: "Package upgrade has already been priced" }, 409);

      return json({ data: { eventId, bookingId: input.bookingId, action: input.action, upgradeRequestId: String(upgrade.id), previousAmount: previous, approvedAmount: amount } }, 200);
    }

    if (input.action === "refund_status") {
      const refund = await db.prepare("SELECT * FROM booking_refund_cases WHERE id=? AND booking_id=?").bind(input.refundCaseId,input.bookingId).first<Record<string,unknown>>();
      if (!refund) return json({ error: "Refund case not found" }, 404);
      const transitions:Record<string,string[]>={requested:["approved","rejected"],approved:["processing"],processing:["completed"]};
      if (!(transitions[String(refund.status)]??[]).includes(String(input.refundStatus))) return json({ error: `Refund cannot move from ${String(refund.status)} to ${String(input.refundStatus)}` },409);
      const eventId=crypto.randomUUID();
      const message=input.refundStatus==="approved"?"Your refund is approved and will now be sent to the original payment method.":input.refundStatus==="processing"?"Your refund has been sent to the payment gateway for processing.":input.refundStatus==="completed"?"Your refund is complete. The gateway reference is available in this order.":"Your refund request was not approved. Open the order to see the reason or contact support.";
      await db.batch([
        db.prepare("UPDATE booking_refund_cases SET status=?,approved_by=CASE WHEN ?='approved' THEN ? ELSE approved_by END,gateway_reference=COALESCE(?,gateway_reference),updated_at=? WHERE id=?").bind(input.refundStatus,input.refundStatus,input.providerId,input.gatewayReference??null,now,input.refundCaseId),
        db.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(eventId,input.bookingId,input.providerId,`refund.${input.refundStatus}`,input.reason,0,JSON.stringify({refundCaseId:input.refundCaseId,gatewayReference:input.gatewayReference}),input.providerId,now),
        db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.bookingId,`refund.${input.refundStatus}`,"refund",input.refundCaseId,input.providerId,JSON.stringify({gatewayReference:input.gatewayReference}),now),
        db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) SELECT ?,b.id,b.customer_id,'whatsapp',?,?, 'queued',?,? FROM canonical_bookings b WHERE b.id=?").bind(crypto.randomUUID(),`refund_${input.refundStatus}`,message,eventId,now,input.bookingId),
      ]);
      return json({data:{eventId,bookingId:input.bookingId,action:input.action,impactMinutes:0,impactedBookings:[],notificationsQueued:1,rebookingAvailable:false,refundCaseId:input.refundCaseId}},200);
    }
    const eventId = crypto.randomUUID();
    const impactMinutes = Math.round(input.impactMinutes ?? 0);
    const rebookingAvailable = ["vehicle_issue", "running_late", "service_overrun"].includes(input.action) && impactMinutes >= 30;
    const current = booking;
    const impacted = impactMinutes > 0
      ? await db.prepare("SELECT id,customer_id,scheduled_start FROM canonical_bookings WHERE provider_id=? AND scheduled_start>(SELECT COALESCE(scheduled_start,'') FROM canonical_bookings WHERE id=?) AND status NOT IN ('cancelled','completed') ORDER BY scheduled_start LIMIT 20").bind(input.providerId, input.bookingId).all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    const impactedBookings = impacted.results.map((row) => ({ bookingId: String(row.id), customerId: String(row.customer_id), scheduledStart: String(row.scheduled_start) }));
    const detail = { impactMinutes, upgradedPackageName: input.upgradedPackageName, upgradedAmount: input.upgradedAmount, impactedBookingIds: impactedBookings.map((item) => item.bookingId), rebookingAvailable };
    const statements = [
      db.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(eventId,input.bookingId,input.providerId,input.action,input.reason.trim(),impactMinutes,JSON.stringify(detail),input.providerId,now),
      db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.bookingId,`operation.${input.action}`,"booking",input.bookingId,input.providerId,JSON.stringify(detail),now),
    ];
    // A provider reporting an agreed upgrade records a REQUEST. It used to write the new price
    // straight into canonical_bookings.total_amount and booking_payments.amount from the request
    // body, so anyone holding communications.message - which the service_provider and associate roles
    // both do - could set any booking's price to any number, including a negative one. The money now
    // moves only through apply_package_upgrade, which requires pricing.manage.
    let upgradeRequestId: string | undefined;
    if (input.action === "package_upgrade") {
      upgradeRequestId = crypto.randomUUID();
      statements.push(db.prepare("INSERT INTO booking_package_upgrade_requests (id,booking_id,provider_id,source_event_id,requested_package_name,requested_amount,previous_amount,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pricing_approval_required',?,?,?)").bind(upgradeRequestId,input.bookingId,input.providerId,eventId,String(input.upgradedPackageName),Number(input.upgradedAmount),Number(current?.total_amount ?? 0),actor.email,now,now));
    }
    const allRecipients = [{ bookingId: input.bookingId, customerId: String(current?.customer_id ?? "") }, ...impactedBookings];
    for (const recipient of allRecipients) {
      const message = recipient.bookingId === input.bookingId
        ? customerMessage(input.action, impactMinutes, rebookingAvailable)
        : `A previous PawSpace service is taking longer than planned. Your booking may start about ${impactMinutes} minutes later. Check live tracking; rebooking is available if the delay becomes too long.`;
      for (const channel of ["push", "whatsapp"])
        statements.push(db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),recipient.bookingId,recipient.customerId,channel,recipient.bookingId === input.bookingId ? `order_${input.action}` : "downstream_delay",message,"queued",eventId,now));
    }
    let rebookingCaseId: string | undefined;
    if (rebookingAvailable || input.action === "rebook_requested") {
      rebookingCaseId = crypto.randomUUID();
      statements.push(db.prepare("INSERT INTO booking_rebooking_cases (id,booking_id,source_event_id,status,reason,eligible_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(rebookingCaseId,input.bookingId,eventId,input.action === "rebook_requested" ? "requested" : "offered",input.reason,now,now,now));
    }
    let refundCaseId: string | undefined;
    if (input.action === "refund_requested") {
      refundCaseId = crypto.randomUUID();
      const payment = await db.prepare("SELECT id,amount FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Record<string, unknown>>();
      statements.push(db.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(refundCaseId,input.bookingId,payment?.id ?? null,Number(payment?.amount ?? 0),input.reason,"requested",input.providerId,now,now));
    }
    await db.batch(statements);
    return json({ data: { eventId, bookingId: input.bookingId, action: input.action, impactMinutes, impactedBookings, notificationsQueued: allRecipients.length * 2, rebookingAvailable, rebookingCaseId, refundCaseId, upgradeRequestId } }, 201);
  } catch (error) {
    return authError(error, "Unable to save order operation");
  }
}
