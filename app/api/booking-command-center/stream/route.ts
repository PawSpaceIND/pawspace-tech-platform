import { authError, authorize, database } from "../../../../lib/server-auth";
import { ensureCanonicalBookingCoreTables } from "../../../../lib/canonical-booking-core-schema";
import { OPERATIONS_MANAGER_DOMAIN, requireManagerDomain, resolveManagerOrganizationalScope } from "../../../../lib/organizational-scope";

type Row = Record<string, unknown>;
const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

async function snapshot(db: D1Database, cityId?: string) {
  const where = cityId ? " WHERE lower(b.city_id)=?" : "";
  const sql = `SELECT COALESCE(MAX(v),0) version,COALESCE(SUM(created),0) created,COALESCE(SUM(assigned),0) assigned,COALESCE(SUM(captured),0) captured FROM (
    SELECT COALESCE(MAX(b.updated_at),0) v,COUNT(*) created,0 assigned,0 captured FROM canonical_bookings b${where}
    UNION ALL SELECT COALESCE(MAX(w.updated_at),0),0,COUNT(*),0 FROM provider_work_orders w JOIN canonical_bookings b ON b.id=w.booking_id${where}
    UNION ALL SELECT COALESCE(MAX(p.updated_at),0),0,0,SUM(CASE WHEN lower(p.status)='captured' THEN 1 ELSE 0 END) FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id${where}
  )`;
  const binds = cityId ? [cityId, cityId, cityId] : [];
  const row = await db.prepare(sql).bind(...binds).first<Row>();
  return { version: Number(row?.version || 0), created: Number(row?.created || 0), assigned: Number(row?.assigned || 0), captured: Number(row?.captured || 0) };
}

/*
 * R3-G / F5: authorize() and requireManagerDomain() THROW a governed Response, and both were called
 * outside any try/catch - so a refusal escaped the handler as an unhandled error and the runtime
 * answered 500 with Content-Length 0 and an empty body. Signed out was 401 (the gateway refuses
 * first, before this handler runs), while associate, manager, finance and auditor each got a 500:
 * the platform logged a server fault every time someone who is simply not allowed in opened a
 * screen that subscribes to this stream. An SSE endpoint has no reason to answer a refusal
 * differently from its non-streaming sibling - app/api/booking-command-center/route.ts already
 * wraps the identical two calls - so the refusal is returned, with its real status, as JSON.
 */
export async function GET(request: Request) {
  try {
    return await stream(request);
  } catch (error) { return authError(error, "Unable to open the Booking Command Center stream"); }
}

async function stream(request: Request) {
  const actor = await authorize(request, "bookings.manage");
  const db = await database();
  const scope = await resolveManagerOrganizationalScope(db, actor); requireManagerDomain(scope, OPERATIONS_MANAGER_DOMAIN);
  // This surface only reads, but reading is not a reason to skip provisioning: on a cold database
  // (fresh preview branch, rebuilt D1, restored backup) no writer has run yet, and snapshot() used
  // to fail the whole request with "no such table: booking_payments".
  await ensureCanonicalBookingCoreTables(db);
  let closed = false, current = await snapshot(db, scope?.cityId), timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame("ready", current));
      timer = setInterval(() => { void (async () => {
        if (closed) return;
        try { const next = await snapshot(db, scope?.cityId); if (JSON.stringify(next) !== JSON.stringify(current)) { current = next; controller.enqueue(frame("booking", next)); } else controller.enqueue(frame("heartbeat", { version: current.version })); }
        catch { controller.enqueue(frame("heartbeat", { version: current.version })); }
      })(); }, 2000);
      request.signal.addEventListener("abort", () => { closed = true; if (timer) clearInterval(timer); try { controller.close(); } catch {} }, { once: true });
    },
    cancel() { closed = true; if (timer) clearInterval(timer); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
