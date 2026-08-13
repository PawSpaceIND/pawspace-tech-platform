/**
 * Operations Overview — the real data behind /admin.
 *
 * The screen previously rendered hard-coded numbers (₹32,482 expected revenue, "8/10 groomers
 * active", a groomer calendar of invented bookings). Nothing on it touched the database, so a
 * tester reviewing it was reviewing fiction and any bug raised against it was meaningless.
 *
 * Everything here is computed from canonical tables. Where no source exists yet, the field is
 * returned as null with a `sourceStatus` saying so — the screen must be able to show "not
 * connected" rather than invent a figure.
 *
 * Revenue recognition matches lib/pnl-reporting.ts and buildCompanyAnalytics exactly: cancelled and
 * draft bookings carry an amount but are not revenue. The same predicate is used here, in the
 * Command Centre TODAY block and in the P&L, so the three can never disagree for the same day.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const money = (value: number) => Math.round(value * 100) / 100;
/** Cancelled and draft bookings are not recognized revenue. Single source of the rule. */
const recognized = (row: Row) => !["cancelled", "draft"].includes(text(row.status));

async function tableExists(db: Db, name: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

export type OverviewSlot = { label: string; start: string; end: string };
/** The working day as the ops team runs it, in two-hour blocks. */
export const OVERVIEW_SLOTS: OverviewSlot[] = [
  { label: "9–11", start: "09:00", end: "11:00" },
  { label: "11–1", start: "11:00", end: "13:00" },
  { label: "1–3", start: "13:00", end: "15:00" },
  { label: "3–5", start: "15:00", end: "17:00" },
  { label: "5–7", start: "17:00", end: "19:00" },
];

export async function buildOperationsOverview(db: Db, input: { asOf?: number; zoneId?: string } = {}) {
  const asOf = input.asOf ?? Date.now();
  const day = new Date(asOf).toISOString().slice(0, 10);
  const zoneId = text(input.zoneId);

  const hasBookings = await tableExists(db, "canonical_bookings");
  const binds: unknown[] = [day];
  let where = "substr(b.scheduled_start,1,10)=?";
  if (zoneId) { where += " AND b.zone_id=?"; binds.push(zoneId); }

  const bookings = hasBookings
    ? (await db.prepare(
        `SELECT b.id,b.customer_id,b.service_code,b.package_name,b.zone_id,b.provider_id,b.status,b.total_amount,b.scheduled_start,b.scheduled_end,
                c.name customer_name, w.provider_name, w.status work_order_status
         FROM canonical_bookings b
         LEFT JOIN canonical_customers c ON c.id=b.customer_id
         LEFT JOIN provider_work_orders w ON w.booking_id=b.id
         WHERE ${where} ORDER BY b.scheduled_start`).bind(...binds).all<Row>()).results
    : [];

  const revenueRows = bookings.filter(recognized);
  const completed = bookings.filter(row => text(row.status) === "completed");
  const cancelled = bookings.filter(row => text(row.status) === "cancelled");
  const confirmed = revenueRows.filter(row => text(row.status) === "confirmed");
  const unassigned = revenueRows.filter(row => !text(row.provider_id));

  // Providers: "active today" is a real count of live, active capacity profiles, not a target.
  let providersActive: number | null = null, providersTotal: number | null = null;
  if (await tableExists(db, "provider_capacity_profiles")) {
    const row = await db.prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN status='active' AND live=1 THEN 1 ELSE 0 END) active
       FROM provider_capacity_profiles${zoneId ? " WHERE zones_json LIKE ?" : ""}`)
      .bind(...(zoneId ? [`%${zoneId}%`] : [])).first<Row>();
    providersTotal = Number(row?.total || 0);
    providersActive = Number(row?.active || 0);
  }

  let openTickets: number | null = null, ticketsNeedingAttention: number | null = null;
  if (await tableExists(db, "customer_experience_tickets")) {
    const row = await db.prepare(
      `SELECT COUNT(*) open, SUM(CASE WHEN sla_due_at<=? THEN 1 ELSE 0 END) overdue
       FROM customer_experience_tickets WHERE status NOT IN ('resolved','closed')`).bind(asOf).first<Row>();
    openTickets = Number(row?.open || 0);
    ticketsNeedingAttention = Number(row?.overdue || 0);
  }

  // Live capacity board: real providers, real bookings placed in the slot their start time falls in.
  const providerRows = await tableExists(db, "provider_capacity_profiles")
    ? (await db.prepare(
        `SELECT id,name,city_id,zones_json,status,live FROM provider_capacity_profiles
         WHERE status='active' AND live=1${zoneId ? " AND zones_json LIKE ?" : ""} ORDER BY name LIMIT 12`)
        .bind(...(zoneId ? [`%${zoneId}%`] : [])).all<Row>()).results
    : [];

  const slotOf = (start: string) => {
    const time = start.slice(11, 16);
    return OVERVIEW_SLOTS.find(slot => time >= slot.start && time < slot.end)?.label ?? null;
  };
  const capacity = providerRows.map(provider => {
    const id = text(provider.id);
    const slots = OVERVIEW_SLOTS.map(slot => {
      const booking = bookings.find(row => text(row.provider_id) === id && slotOf(text(row.scheduled_start)) === slot.label && recognized(row));
      if (!booking) return { slot: slot.label, state: "available" as const, bookingId: null, label: "Open for booking" };
      const status = text(booking.status);
      return {
        slot: slot.label,
        state: status === "completed" ? ("completed" as const) : ("booked" as const),
        bookingId: text(booking.id),
        label: text(booking.package_name) || text(booking.service_code),
      };
    });
    return { providerId: id, name: text(provider.name), zone: text(provider.zones_json).replace(/[[\]"]/g, "") || null, slots };
  });

  const byService: Record<string, { bookings: number; revenue: number; completed: number; cancelled: number }> = {};
  for (const row of bookings) {
    const service = text(row.service_code);
    byService[service] ??= { bookings: 0, revenue: 0, completed: 0, cancelled: 0 };
    const bucket = byService[service];
    if (text(row.status) === "cancelled") bucket.cancelled++;
    else if (recognized(row)) { bucket.bookings++; bucket.revenue = money(bucket.revenue + Number(row.total_amount || 0)); }
    if (text(row.status) === "completed") bucket.completed++;
  }

  return {
    date: day,
    zoneId: zoneId || null,
    metrics: {
      bookingsToday: revenueRows.length,
      confirmed: confirmed.length,
      completed: completed.length,
      cancelled: cancelled.length,
      unassigned: unassigned.length,
      // "Recognized" rather than "expected": this is the same money the P&L recognizes for the day.
      recognizedRevenue: money(revenueRows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
      providersActive,
      providersTotal,
      openTickets,
      ticketsNeedingAttention,
    },
    capacity,
    slots: OVERVIEW_SLOTS.map(slot => slot.label),
    activity: bookings.slice(0, 12).map(row => ({
      bookingId: text(row.id),
      customer: text(row.customer_name) || text(row.customer_id),
      service: text(row.service_code),
      packageName: text(row.package_name),
      status: text(row.status),
      provider: text(row.provider_name) || null,
      scheduledStart: text(row.scheduled_start),
      amount: Number(row.total_amount || 0),
    })),
    byService,
    sourceStatus: {
      bookings: hasBookings ? "canonical_bookings" : "not_connected",
      providers: providersTotal === null ? "not_connected" : "provider_capacity_profiles",
      tickets: openTickets === null ? "not_connected" : "customer_experience_tickets",
      // No comparison series exists yet, so the screen must not show a "vs last Monday" trend.
      revenueTrend: "not_connected",
      revenueRecognition: "excludes_cancelled_and_draft",
    },
  };
}
