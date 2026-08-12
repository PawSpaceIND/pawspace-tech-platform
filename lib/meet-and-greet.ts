// Meet & Greet: pre-booking confidence meetings between a customer and a boarding/sitting host.
// Formats: "phone" (10 minutes, always free) and "house_visit" (4 hours at the host's home,
// ₹499 — waived when the intended stay is 5 days or longer). 100% refund / zero cancellation
// fee policy platform-wide, so cancellation never charges the customer.

export type MeetGreetFormat = "phone" | "house_visit";
export type MeetGreetStatus = "requested" | "confirmed" | "completed" | "cancelled" | "no_show";
export type MeetGreetAction = "confirm" | "complete" | "cancel" | "no_show";

export type MeetGreetRequest = {
  id: string;
  customerId: string;
  hostProviderId: string;
  format: MeetGreetFormat;
  intendedStayStart: string | null;
  intendedStayEnd: string | null;
  intendedStayDays: number;
  preferredAt: number;
  priceCharged: number;
  priceWaivedReason: string | null;
  status: MeetGreetStatus;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MeetGreetEvent = {
  id: string;
  requestId: string;
  eventType: string;
  actorId: string;
  detail: Record<string, unknown>;
  createdAt: number;
};

export type MeetGreetCreateInput = {
  customerId: string;
  hostProviderId: string;
  format: MeetGreetFormat;
  preferredAt: number;
  intendedStayStart?: string;
  intendedStayEnd?: string;
  intendedStayDays?: number;
  notes?: string;
};

type Db = D1Database;
type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
const IST_OFFSET_MINUTES = 330; // UTC+05:30
const HOUSE_VISIT_MINUTES = 240; // 4 hours
const HOUSE_VISIT_OPEN_IST = 9 * 60; // 09:00 IST
const HOUSE_VISIT_CLOSE_IST = 19 * 60; // 19:00 IST
const FORMATS: MeetGreetFormat[] = ["phone", "house_visit"];

/** Pure pricing rule. Phone calls are always free. House visits are ₹499,
 *  waived entirely when the customer's intended stay is 5 days or longer. */
export function meetGreetPrice(format: MeetGreetFormat, intendedStayDays: number): { amount: number; waived: boolean; reason: string | null } {
  if (format === "phone") return { amount: 0, waived: false, reason: null };
  if (Number.isFinite(intendedStayDays) && intendedStayDays >= 5) return { amount: 0, waived: true, reason: "stay_5_days_or_more" };
  return { amount: 499, waived: false, reason: null };
}

/** Minutes since midnight in IST for an epoch-ms timestamp. */
export function istMinutesOfDay(epochMs: number): number {
  return (((Math.floor(epochMs / 60_000) + IST_OFFSET_MINUTES) % 1440) + 1440) % 1440;
}

// Idempotent DDL, memoized per D1 binding (same pattern as ensureSecurityTables).
const meetGreetTablesEnsured = new WeakSet<Db>();

export async function ensureMeetGreetTables(db: Db) {
  if (meetGreetTablesEnsured.has(db)) return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS meet_greet_requests (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,host_provider_id TEXT NOT NULL,format TEXT NOT NULL,intended_stay_start TEXT,intended_stay_end TEXT,intended_stay_days INTEGER NOT NULL DEFAULT 0,preferred_at INTEGER NOT NULL,price_charged REAL NOT NULL DEFAULT 0,price_waived_reason TEXT,status TEXT NOT NULL DEFAULT 'requested',notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS meet_greet_events (id TEXT PRIMARY KEY,request_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"
    ),
    // One open (requested/confirmed) meet & greet per customer+host pair, enforced at the DB level.
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS meet_greet_open_pair ON meet_greet_requests(customer_id,host_provider_id) WHERE status IN ('requested','confirmed')"
    ),
  ]);
  meetGreetTablesEnsured.add(db);
}

/** Host must exist as a boarding host, or as a sitting provider whose services include pet_sitting. */
async function hostEligible(db: Db, hostProviderId: string): Promise<boolean> {
  const [boarding, sitting] = await Promise.all([
    db.prepare("SELECT provider_id FROM boarding_host_profiles WHERE provider_id=?").bind(hostProviderId).first<Row>().catch(() => null),
    db.prepare("SELECT id FROM provider_capacity_profiles WHERE id=? AND services_json LIKE '%pet_sitting%'").bind(hostProviderId).first<Row>().catch(() => null),
  ]);
  return !!boarding || !!sitting;
}

async function recordMeetGreetEvent(db: Db, requestId: string, eventType: string, actorId: string, detail: Record<string, unknown> = {}) {
  await db
    .prepare("INSERT INTO meet_greet_events (id,request_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(`MGE-${crypto.randomUUID().slice(0, 12).toUpperCase()}`, requestId, eventType, actorId, JSON.stringify(detail), Date.now())
    .run();
}

function rowToRequest(row: Row): MeetGreetRequest {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    hostProviderId: String(row.host_provider_id),
    format: String(row.format) as MeetGreetFormat,
    intendedStayStart: row.intended_stay_start == null ? null : String(row.intended_stay_start),
    intendedStayEnd: row.intended_stay_end == null ? null : String(row.intended_stay_end),
    intendedStayDays: Number(row.intended_stay_days || 0),
    preferredAt: Number(row.preferred_at),
    priceCharged: Number(row.price_charged || 0),
    priceWaivedReason: row.price_waived_reason == null ? null : String(row.price_waived_reason),
    status: String(row.status) as MeetGreetStatus,
    notes: row.notes == null ? null : String(row.notes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const isoDate = (value: unknown) => {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

export async function createMeetGreetRequest(db: Db, input: MeetGreetCreateInput, actorId: string): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);
  const now = Date.now();

  const customerId = String(input.customerId ?? "").trim();
  const hostProviderId = String(input.hostProviderId ?? "").trim();
  if (!customerId || !hostProviderId) throw new Error("Customer and host are required");
  if (!FORMATS.includes(input.format)) throw new Error("Format must be phone or house_visit");

  const preferredAt = Number(input.preferredAt);
  if (!Number.isFinite(preferredAt) || preferredAt <= now) throw new Error("Preferred time must be in the future");

  const stayStart = isoDate(input.intendedStayStart);
  const stayEnd = isoDate(input.intendedStayEnd);
  let intendedStayDays = Math.floor(Number(input.intendedStayDays ?? NaN));
  if (!Number.isFinite(intendedStayDays) && stayStart && stayEnd) {
    intendedStayDays = Math.round((Date.parse(stayEnd) - Date.parse(stayStart)) / DAY_MS);
  }
  if (!Number.isFinite(intendedStayDays) || intendedStayDays < 0) intendedStayDays = 0;

  if (input.format === "house_visit") {
    const start = istMinutesOfDay(preferredAt);
    if (start < HOUSE_VISIT_OPEN_IST || start + HOUSE_VISIT_MINUTES > HOUSE_VISIT_CLOSE_IST) {
      throw new Error("House visits run 4 hours and must fall between 09:00 and 19:00 IST");
    }
  }

  if (!(await hostEligible(db, hostProviderId))) throw new Error("Host is not a boarding host or pet-sitting provider");

  const open = await db
    .prepare("SELECT id FROM meet_greet_requests WHERE customer_id=? AND host_provider_id=? AND status IN ('requested','confirmed') LIMIT 1")
    .bind(customerId, hostProviderId)
    .first<Row>();
  if (open) throw new Error("An open meet & greet already exists with this host");

  const price = meetGreetPrice(input.format, intendedStayDays);
  const id = `MGR-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const notes = input.notes == null ? null : String(input.notes).slice(0, 2000) || null;

  try {
    await db
      .prepare(
        "INSERT INTO meet_greet_requests (id,customer_id,host_provider_id,format,intended_stay_start,intended_stay_end,intended_stay_days,preferred_at,price_charged,price_waived_reason,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'requested',?,?,?)"
      )
      .bind(id, customerId, hostProviderId, input.format, stayStart, stayEnd, intendedStayDays, preferredAt, price.amount, price.reason, notes, now, now)
      .run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) throw new Error("An open meet & greet already exists with this host");
    throw error;
  }

  await recordMeetGreetEvent(db, id, "requested", actorId, { format: input.format, intendedStayDays, priceCharged: price.amount, priceWaivedReason: price.reason });
  const row = await db.prepare("SELECT * FROM meet_greet_requests WHERE id=?").bind(id).first<Row>();
  return rowToRequest(row!);
}

export async function getMeetGreetRequest(db: Db, requestId: string): Promise<MeetGreetRequest | null> {
  await ensureMeetGreetTables(db);
  const row = await db.prepare("SELECT * FROM meet_greet_requests WHERE id=?").bind(requestId).first<Row>();
  return row ? rowToRequest(row) : null;
}

export async function listMeetGreetRequests(db: Db, filters: { customerId?: string; hostProviderId?: string; status?: MeetGreetStatus } = {}): Promise<MeetGreetRequest[]> {
  await ensureMeetGreetTables(db);
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (filters.customerId) { clauses.push("customer_id=?"); bindings.push(filters.customerId); }
  if (filters.hostProviderId) { clauses.push("host_provider_id=?"); bindings.push(filters.hostProviderId); }
  if (filters.status) { clauses.push("status=?"); bindings.push(filters.status); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const stmt = db.prepare(`SELECT * FROM meet_greet_requests${where} ORDER BY created_at DESC`);
  const result = await (bindings.length ? stmt.bind(...bindings) : stmt).all<Row>();
  return result.results.map(rowToRequest);
}

// Lifecycle: requested -> confirmed -> completed | cancelled | no_show.
// Cancellation is allowed from requested or confirmed; it is always free (100% refund policy).
const TRANSITIONS: Record<MeetGreetAction, { from: MeetGreetStatus[]; to: MeetGreetStatus }> = {
  confirm: { from: ["requested"], to: "confirmed" },
  complete: { from: ["confirmed"], to: "completed" },
  no_show: { from: ["confirmed"], to: "no_show" },
  cancel: { from: ["requested", "confirmed"], to: "cancelled" },
};

export async function transitionMeetGreetRequest(db: Db, input: { requestId: string; action: MeetGreetAction; actorId: string; note?: string }): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);
  const rule = TRANSITIONS[input.action];
  if (!rule) throw new Error("Unsupported meet & greet action");

  const current = await getMeetGreetRequest(db, input.requestId);
  if (!current) throw new Error("Meet & greet request not found");
  if (!rule.from.includes(current.status)) throw new Error(`Cannot ${input.action} a meet & greet in '${current.status}' status`);

  const now = Date.now();
  const updated = await db
    .prepare(`UPDATE meet_greet_requests SET status=?,updated_at=? WHERE id=? AND status IN (${rule.from.map(() => "?").join(",")})`)
    .bind(rule.to, now, input.requestId, ...rule.from)
    .run();
  if (!updated.meta.changes) throw new Error(`Cannot ${input.action} a meet & greet in '${current.status}' status`);

  const detail: Record<string, unknown> = { from: current.status, to: rule.to };
  if (input.note) detail.note = String(input.note).slice(0, 1000);
  if (input.action === "cancel") detail.refundPolicy = "100_percent_zero_cancellation_fee";
  await recordMeetGreetEvent(db, input.requestId, rule.to, input.actorId, detail);

  const row = await db.prepare("SELECT * FROM meet_greet_requests WHERE id=?").bind(input.requestId).first<Row>();
  return rowToRequest(row!);
}

export async function listMeetGreetEvents(db: Db, requestId: string): Promise<MeetGreetEvent[]> {
  await ensureMeetGreetTables(db);
  const result = await db.prepare("SELECT * FROM meet_greet_events WHERE request_id=? ORDER BY created_at ASC").bind(requestId).all<Row>();
  return result.results.map((row) => ({
    id: String(row.id),
    requestId: String(row.request_id),
    eventType: String(row.event_type),
    actorId: String(row.actor_id),
    detail: (() => { try { return JSON.parse(String(row.detail_json || "{}")) as Record<string, unknown>; } catch { return {}; } })(),
    createdAt: Number(row.created_at),
  }));
}
