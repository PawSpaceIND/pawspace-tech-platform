/**
 * Booking lifecycle notifications — the single place every booking route calls to enqueue the
 * customer-facing omnichannel alerts the pipeline previously never sent (audit gap: a full
 * booking→fulfilment→invoice run produced zero communication_messages / outbox rows).
 *
 * HARD RULE: a booking must NEVER fail because a notification could not be enqueued. Communications
 * are best-effort and strictly downstream of the transactional write, so every path here is wrapped
 * and swallowed — enqueueCommunication can legitimately throw (e.g. no communication policy for the
 * booking's city), and that must not surface to the booking handler. Each call is idempotent on
 * `notify:<bookingId>:<event>:<channel>`, so a re-run of an idempotent lifecycle transition (or a
 * retried request) never double-sends.
 */
import {enqueueCommunication, ensureCommunicationTables, type CommunicationChannel} from "./communication-engine";

type Db = D1Database;

export type BookingLifecycleEvent =
  | "booking_confirmed"
  | "provider_assigned"
  | "job_started"
  | "job_completed"
  | "invoice_issued";

// Which channels each event fans out to. Transactional purpose (below) is exempt from quiet-hours
// delay and the marketing frequency cap, so a confirmation always goes out immediately.
const EVENT_CHANNELS: Record<BookingLifecycleEvent, CommunicationChannel[]> = {
  booking_confirmed: ["whatsapp", "push", "email"],
  provider_assigned: ["whatsapp", "push"],
  job_started: ["push"],
  job_completed: ["whatsapp", "push"],
  invoice_issued: ["whatsapp", "email"],
};

export type BookingNotifyContext = {
  bookingId: string;
  customerId: string;
  cityId: string;
  serviceCode?: string;
  packageName?: string;
  scheduledStart?: string;
  providerName?: string;
  amount?: number;
  invoiceNumber?: string;
  createdBy?: string;
};

// enqueueCommunication -> policy(cityId) throws when no communication policy exists for the city.
// seedCommunicationPolicy only seeds 'blr', so ensure a default 'observe' policy exists for whatever
// city this booking is in before enqueuing, so notifications work platform-wide, not just Bengaluru.
async function ensureCityPolicy(db: Db, cityId: string) {
  await ensureCommunicationTables(db);
  await db
    .prepare(
      "INSERT OR IGNORE INTO communication_policies (id,city_id,zone_id,enforcement_mode,quiet_start_hour,quiet_end_hour,promotional_cap_7d,max_attempts,retry_base_minutes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,NULL,'observe',21,8,3,5,5,1,1,'2026-08-01',NULL,'booking_notifications',?)",
    )
    .bind(`comm_${cityId}_default`, cityId, Date.now())
    .run();
}

type NotifyResult =
  | {skipped: true; reason: string}
  | {skipped: false; event: BookingLifecycleEvent; results: Array<{channel: CommunicationChannel; status: string}>};

/**
 * Enqueue one booking lifecycle event across its configured channels. Always resolves, never throws.
 */
export async function notifyBookingLifecycle(db: Db, event: BookingLifecycleEvent, ctx: BookingNotifyContext): Promise<NotifyResult> {
  try {
    if (!ctx.bookingId || !ctx.customerId || !ctx.cityId) return {skipped: true, reason: "missing_identity"};
    await ensureCityPolicy(db, ctx.cityId);
    const payload = {
      event,
      bookingId: ctx.bookingId,
      serviceCode: ctx.serviceCode ?? null,
      packageName: ctx.packageName ?? null,
      scheduledStart: ctx.scheduledStart ?? null,
      providerName: ctx.providerName ?? null,
      amount: ctx.amount ?? null,
      invoiceNumber: ctx.invoiceNumber ?? null,
    };
    const results: Array<{channel: CommunicationChannel; status: string}> = [];
    for (const channel of EVENT_CHANNELS[event]) {
      try {
        const r = await enqueueCommunication(db, {
          customerId: ctx.customerId,
          cityId: ctx.cityId,
          channel,
          purpose: "transactional",
          idempotencyKey: `notify:${ctx.bookingId}:${event}:${channel}`,
          templateKey: event,
          payload: {...payload, channel},
          createdBy: ctx.createdBy || "system",
          bookingId: ctx.bookingId,
        });
        const status = (r as {status?: string}).status ?? ((r as {duplicatePrevented?: boolean}).duplicatePrevented ? "duplicate" : "queued");
        results.push({channel, status: String(status)});
      } catch (err) {
        results.push({channel, status: `error:${err instanceof Error ? err.message : "enqueue_failed"}`});
      }
    }
    return {skipped: false, event, results};
  } catch (err) {
    return {skipped: true, reason: err instanceof Error ? err.message : "notify_failed"};
  }
}

/**
 * Fire `invoice_issued` only when an invoice row actually exists for the booking — works for any
 * vertical without the caller needing to know when/whether that vertical issues an invoice. Idempotent.
 */
export async function notifyInvoiceIssuedIfPresent(db: Db, ctx: Omit<BookingNotifyContext, "invoiceNumber">): Promise<NotifyResult> {
  try {
    const row = await db
      .prepare("SELECT invoice_number FROM booking_invoices WHERE booking_id=? ORDER BY created_at DESC LIMIT 1")
      .bind(ctx.bookingId)
      .first<{invoice_number?: string}>()
      .catch(() => null);
    if (!row?.invoice_number) return {skipped: true, reason: "no_invoice"};
    return await notifyBookingLifecycle(db, "invoice_issued", {...ctx, invoiceNumber: String(row.invoice_number)});
  } catch (err) {
    return {skipped: true, reason: err instanceof Error ? err.message : "invoice_lookup_failed"};
  }
}

// Action -> lifecycle event maps shared by the per-vertical lifecycle routes (sitting/taxi/walking),
// whose action vocabularies differ but converge on the same customer-facing moments.
export const ASSIGNED_ACTIONS = new Set<string>(["accept"]);
export const STARTED_ACTIONS = new Set<string>([
  "start_service", "start_trip", "start_walk", "start_visit", "start_stay", "check_in", "begin_service", "confirm_pickup",
]);
export const COMPLETED_ACTIONS = new Set<string>([
  "complete", "complete_trip", "complete_walk", "complete_visit", "complete_stay", "check_out", "confirm_dropoff",
]);

/**
 * Map a per-vertical lifecycle action (sitting/taxi/walking) onto the customer-facing event and
 * enqueue it. `booking` is the canonical_bookings row those lifecycle routes already loaded. Always
 * resolves; unmapped actions are a no-op. On completion, invoice_issued fires only if an invoice row
 * exists for the booking.
 */
export async function notifyLifecycleAction(db: Db, action: string, booking: Record<string, unknown>, opts?: {createdBy?: string}): Promise<NotifyResult> {
  try {
    const ctx: BookingNotifyContext = {
      bookingId: String(booking.id ?? booking.booking_id ?? ""),
      customerId: String(booking.customer_id ?? ""),
      cityId: String(booking.city_id ?? ""),
      serviceCode: booking.service_code != null ? String(booking.service_code) : undefined,
      packageName: booking.package_name != null ? String(booking.package_name) : undefined,
      scheduledStart: booking.scheduled_start != null ? String(booking.scheduled_start) : undefined,
      amount: booking.total_amount != null ? Number(booking.total_amount) : undefined,
      createdBy: opts?.createdBy,
    };
    if (ASSIGNED_ACTIONS.has(action)) return await notifyBookingLifecycle(db, "provider_assigned", ctx);
    if (STARTED_ACTIONS.has(action)) return await notifyBookingLifecycle(db, "job_started", ctx);
    if (COMPLETED_ACTIONS.has(action)) {
      await notifyBookingLifecycle(db, "job_completed", ctx);
      return await notifyInvoiceIssuedIfPresent(db, ctx);
    }
    return {skipped: true, reason: "no_mapped_event"};
  } catch (err) {
    return {skipped: true, reason: err instanceof Error ? err.message : "notify_failed"};
  }
}
