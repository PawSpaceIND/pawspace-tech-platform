export type MeetGreetFormat = "phone_call" | "house_visit";
export type MeetGreetStatus = "requested" | "confirmed" | "completed" | "cancelled" | "no_show";
export type MeetGreetRequest = {
  id: string;
  customerId: string;
  hostId: string;
  format: MeetGreetFormat;
  status: MeetGreetStatus;
  preferredAt: number;
  intendedStayDays: number;
  price: number;
  cancellationReason?: string;
  createdAt: number;
  updatedAt: number;
};

export type MeetGreetEvent = {
  id: string;
  requestId: string;
  eventType: "requested" | "confirmed" | "completed" | "cancelled" | "no_show";
  actor: string;
  notes?: string;
  createdAt: number;
};

type Db = D1Database;
type Row = Record<string, unknown>;

export function meetGreetPrice(format: MeetGreetFormat, intendedStayDays: number): number {
  if (format === "phone_call") return 0;
  if (format === "house_visit") return intendedStayDays >= 5 ? 0 : 499;
  throw new Error(`Unknown meet-greet format: ${format}`);
}

export async function ensureMeetGreetTables(db: Db) {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS meet_greet_requests (" +
        "id TEXT PRIMARY KEY," +
        "customer_id TEXT NOT NULL," +
        "host_id TEXT NOT NULL," +
        "format TEXT NOT NULL," +
        "status TEXT NOT NULL DEFAULT 'requested'," +
        "preferred_at INTEGER NOT NULL," +
        "intended_stay_days INTEGER NOT NULL," +
        "price REAL NOT NULL," +
        "cancellation_reason TEXT," +
        "created_at INTEGER NOT NULL," +
        "updated_at INTEGER NOT NULL," +
        "UNIQUE(customer_id, host_id, status) WHERE status IN ('requested', 'confirmed')" +
        ")"
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS meet_greet_events (" +
        "id TEXT PRIMARY KEY," +
        "request_id TEXT NOT NULL REFERENCES meet_greet_requests(id)," +
        "event_type TEXT NOT NULL," +
        "actor TEXT NOT NULL," +
        "notes TEXT," +
        "created_at INTEGER NOT NULL" +
        ")"
    ),
  ]);
}

async function hostExists(db: Db, hostId: string): Promise<boolean> {
  const [boarding, sitting] = await Promise.all([
    db
      .prepare("SELECT id FROM boarding_host_profiles WHERE id = ?")
      .bind(hostId)
      .first<Row>()
      .catch(() => null),
    db
      .prepare("SELECT id FROM provider_capacity_profiles WHERE provider_id = ? AND service_type = ?")
      .bind(hostId, "sitting")
      .first<Row>()
      .catch(() => null),
  ]);
  return !!boarding || !!sitting;
}

async function recordEvent(
  db: Db,
  requestId: string,
  eventType: MeetGreetEvent["eventType"],
  actor: string,
  notes?: string
) {
  const now = Date.now();
  const eventId = `MGE-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  await db
    .prepare(
      "INSERT INTO meet_greet_events (id, request_id, event_type, actor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(eventId, requestId, eventType, actor, notes || null, now)
    .run();
}

function rowToRequest(row: Row): MeetGreetRequest {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    hostId: String(row.host_id),
    format: String(row.format) as MeetGreetFormat,
    status: String(row.status) as MeetGreetStatus,
    preferredAt: Number(row.preferred_at),
    intendedStayDays: Number(row.intended_stay_days),
    price: Number(row.price),
    cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function createMeetGreetRequest(
  db: Db,
  input: {
    customerId: string;
    hostId: string;
    format: MeetGreetFormat;
    preferredAt: number;
    intendedStayDays: number;
  },
  actor: string
): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);

  const now = Date.now();
  if (!input.customerId || !input.hostId || !input.format || !input.preferredAt)
    throw new Error("Customer, host, format, and preferred time are required");
  if (input.preferredAt <= now) throw new Error("Preferred time must be in the future");
  if (input.intendedStayDays < 0) throw new Error("Intended stay days must be non-negative");

  const validFormats: MeetGreetFormat[] = ["phone_call", "house_visit"];
  if (!validFormats.includes(input.format)) throw new Error(`Invalid format: ${input.format}`);

  const isHost = await hostExists(db, input.hostId);
  if (!isHost) throw new Error("Host profile not found");

  if (input.format === "house_visit") {
    const hour = new Date(input.preferredAt).getUTCHours();
    if (hour < 9 || hour > 18) throw new Error("House visits must be scheduled between 09:00 and 19:00 IST");
  }

  const existingOpen = await db
    .prepare(
      "SELECT id FROM meet_greet_requests WHERE customer_id = ? AND host_id = ? AND status IN ('requested', 'confirmed') LIMIT 1"
    )
    .bind(input.customerId, input.hostId)
    .first<Row>()
    .catch(() => null);

  if (existingOpen) throw new Error("An open meet-greet request already exists with this host");

  const price = meetGreetPrice(input.format, input.intendedStayDays);
  const id = `MGR-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

  await db
    .prepare(
      "INSERT INTO meet_greet_requests (id, customer_id, host_id, format, status, preferred_at, intended_stay_days, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, input.customerId, input.hostId, input.format, "requested", input.preferredAt, input.intendedStayDays, price, now, now)
    .run();

  await recordEvent(db, id, "requested", actor, `Format: ${input.format}, price: ₹${price}`);

  const row = await db.prepare("SELECT * FROM meet_greet_requests WHERE id = ?").bind(id).first<Row>();
  return rowToRequest(row!);
}

export async function listMeetGreetRequests(
  db: Db,
  filters?: {
    customerId?: string;
    hostId?: string;
    status?: MeetGreetStatus;
  }
): Promise<MeetGreetRequest[]> {
  await ensureMeetGreetTables(db);

  let query = "SELECT * FROM meet_greet_requests WHERE 1=1";
  const bindings: unknown[] = [];

  if (filters?.customerId) {
    query += " AND customer_id = ?";
    bindings.push(filters.customerId);
  }
  if (filters?.hostId) {
    query += " AND host_id = ?";
    bindings.push(filters.hostId);
  }
  if (filters?.status) {
    query += " AND status = ?";
    bindings.push(filters.status);
  }

  query += " ORDER BY created_at DESC";

  const stmt = db.prepare(query);
  const result = await (bindings.length > 0 ? stmt.bind(...bindings) : stmt).all<Row>();
  return result.results.map(rowToRequest);
}

export async function getMeetGreetRequest(db: Db, requestId: string): Promise<MeetGreetRequest | null> {
  await ensureMeetGreetTables(db);
  const row = await db
    .prepare("SELECT * FROM meet_greet_requests WHERE id = ?")
    .bind(requestId)
    .first<Row>()
    .catch(() => null);
  return row ? rowToRequest(row) : null;
}

export async function confirmMeetGreetRequest(db: Db, requestId: string, actor: string): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);

  const request = await getMeetGreetRequest(db, requestId);
  if (!request) throw new Error("Meet-greet request not found");
  if (request.status !== "requested") throw new Error(`Cannot confirm request in ${request.status} status`);

  const now = Date.now();
  await db
    .prepare("UPDATE meet_greet_requests SET status = ?, updated_at = ? WHERE id = ?")
    .bind("confirmed", now, requestId)
    .run();

  await recordEvent(db, requestId, "confirmed", actor);

  const updated = await getMeetGreetRequest(db, requestId);
  return updated!;
}

export async function completeMeetGreetRequest(db: Db, requestId: string, actor: string): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);

  const request = await getMeetGreetRequest(db, requestId);
  if (!request) throw new Error("Meet-greet request not found");
  if (!["requested", "confirmed"].includes(request.status))
    throw new Error(`Cannot complete request in ${request.status} status`);

  const now = Date.now();
  await db
    .prepare("UPDATE meet_greet_requests SET status = ?, updated_at = ? WHERE id = ?")
    .bind("completed", now, requestId)
    .run();

  await recordEvent(db, requestId, "completed", actor);

  const updated = await getMeetGreetRequest(db, requestId);
  return updated!;
}

export async function cancelMeetGreetRequest(
  db: Db,
  requestId: string,
  actor: string,
  reason?: string
): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);

  const request = await getMeetGreetRequest(db, requestId);
  if (!request) throw new Error("Meet-greet request not found");
  if (!["requested", "confirmed"].includes(request.status))
    throw new Error(`Cannot cancel request in ${request.status} status`);

  const now = Date.now();
  await db
    .prepare("UPDATE meet_greet_requests SET status = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?")
    .bind("cancelled", reason || null, now, requestId)
    .run();

  await recordEvent(db, requestId, "cancelled", actor, reason);

  const updated = await getMeetGreetRequest(db, requestId);
  return updated!;
}

export async function markMeetGreetNoShow(db: Db, requestId: string, actor: string): Promise<MeetGreetRequest> {
  await ensureMeetGreetTables(db);

  const request = await getMeetGreetRequest(db, requestId);
  if (!request) throw new Error("Meet-greet request not found");
  if (request.status !== "confirmed") throw new Error(`Cannot mark no-show for request in ${request.status} status`);

  const now = Date.now();
  await db
    .prepare("UPDATE meet_greet_requests SET status = ?, updated_at = ? WHERE id = ?")
    .bind("no_show", now, requestId)
    .run();

  await recordEvent(db, requestId, "no_show", actor);

  const updated = await getMeetGreetRequest(db, requestId);
  return updated!;
}

export async function getMeetGreetEvents(db: Db, requestId: string): Promise<MeetGreetEvent[]> {
  await ensureMeetGreetTables(db);

  const result = await db
    .prepare("SELECT * FROM meet_greet_events WHERE request_id = ? ORDER BY created_at ASC")
    .bind(requestId)
    .all<Row>();

  return result.results.map(row => ({
    id: String(row.id),
    requestId: String(row.request_id),
    eventType: String(row.event_type) as MeetGreetEvent["eventType"],
    actor: String(row.actor),
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: Number(row.created_at),
  }));
}
