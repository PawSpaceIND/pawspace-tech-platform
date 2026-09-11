import { authorize, database } from "../../../../lib/server-auth";
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

export async function GET(request: Request) {
  const actor = await authorize(request, "bookings.manage");
  const db = await database();
  const scope = await resolveManagerOrganizationalScope(db, actor); requireManagerDomain(scope, OPERATIONS_MANAGER_DOMAIN);
  let closed = false, current = await snapshot(db, scope?.cityId), timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
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
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
