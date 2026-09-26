import { bookingPaymentBalances } from "../../../lib/booking-payment-balances";
import { bookingSupportCases } from "../../../lib/booking-support-cases";
import { chunkedIn } from "../../../lib/d1-chunked-in";
import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";
import{OPERATIONS_MANAGER_DOMAIN,requireManagerDomain,resolveManagerOrganizationalScope}from"../../../lib/organizational-scope";

type Db = Awaited<ReturnType<typeof database>>;
type Row = Record<string, unknown>;

// The DDL is idempotent, so it runs once per D1 binding: it used to be a 12-statement write batch on every
// GET, and the live stream re-ran the GET's snapshot on every change. Concurrent first requests share one
// attempt, the same pattern as app/api/canonical-bookings/route.ts.
const bookingCommandTablesReady=new WeakSet<Db>();
const bookingCommandTablesEnsuring=new WeakMap<Db,Promise<void>>();
async function ensureTables(db: Db) {
  if(bookingCommandTablesReady.has(db))return;
  const active=bookingCommandTablesEnsuring.get(db);if(active)return active;
  const work=(async()=>{
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
    // The snapshot reads every child table by booking_id. Only booking_lifecycle_events had an index for
    // that (created by app/api/canonical-bookings/route.ts, repeated verbatim here); the other six were a
    // full table scan per booking row. Also in drizzle/0042_booking_child_booking_id_indexes.sql.
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_lifecycle_events_booking ON booking_lifecycle_events(booking_id,occurred_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_operational_events_booking ON booking_operational_events(booking_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_customer_notifications_booking ON booking_customer_notifications(booking_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_rebooking_cases_booking ON booking_rebooking_cases(booking_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_refund_cases_booking ON booking_refund_cases(booking_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_experience_tickets_booking ON customer_experience_tickets(booking_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_admin_actions_booking ON booking_admin_actions(booking_id,created_at)"),
  ]);
  bookingCommandTablesReady.add(db);
  })().finally(()=>{bookingCommandTablesEnsuring.delete(db);});
  bookingCommandTablesEnsuring.set(db,work);
  return work;
}

function parse(value: unknown) {
  try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}

/*
 * The list window. It used to be the 150 bookings scheduled FURTHEST in the future. On a seeded UAT
 * database that is 150 fixtures months ahead, so a booking made today never entered the window and the
 * founder could not find it (Bengaluru sweep run 8, 2026-09-13). An operator watching live bookings
 * needs newest-created first; `sort=schedule` keeps the old order for planning views, `q` searches the
 * whole table so any booking is reachable, and `limit` is capped so a client cannot pull everything.
 */
export type BookingListOptions={q?:string;limit?:number;sort?:"created"|"schedule"};
export const BOOKING_LIST_DEFAULT_LIMIT=150,BOOKING_LIST_MAX_LIMIT=500;
export function parseBookingListOptions(url:URL):BookingListOptions{
  const q=String(url.searchParams.get("q")||"").trim().toLowerCase().slice(0,120);
  const requested=Number(url.searchParams.get("limit"));
  const limit=Number.isFinite(requested)&&requested>0?Math.min(BOOKING_LIST_MAX_LIMIT,Math.floor(requested)):BOOKING_LIST_DEFAULT_LIMIT;
  return{q,limit,sort:url.searchParams.get("sort")==="schedule"?"schedule":"created"};
}
async function bookingRows(db:Db,scope:Awaited<ReturnType<typeof resolveManagerOrganizationalScope>>,options:BookingListOptions={}){
  const where:string[]=[],binds:unknown[]=[];
  if(scope){where.push("lower(b.city_id)=?");binds.push(scope.cityId);}
  const q=String(options.q||"").trim().toLowerCase();
  if(q){
    const like=`%${q.replace(/[\\%_]/g,match=>`\\${match}`)}%`;
    where.push("(lower(b.id) LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\' OR c.primary_phone LIKE ? ESCAPE '\\' OR lower(c.email) LIKE ? ESCAPE '\\' OR lower(w.provider_name) LIKE ? ESCAPE '\\' OR lower(b.package_name) LIKE ? ESCAPE '\\')");
    binds.push(like,like,like,like,like,like);
  }
  const limit=Math.min(BOOKING_LIST_MAX_LIMIT,Math.max(1,Math.floor(Number(options.limit)||BOOKING_LIST_DEFAULT_LIMIT)));
  const order=options.sort==="schedule"?"b.scheduled_start DESC":"b.created_at DESC, b.scheduled_start DESC";
  const sql=`SELECT b.*,c.name customer_name,c.primary_phone,c.secondary_phone,c.email customer_email,c.source customer_source,
    w.id work_order_id,w.provider_name,w.provider_model,w.status work_order_status,w.occurrence_count,w.assignment_json,
    p.id payment_id,p.amount payment_amount,p.amount_due_now,p.method payment_method,p.mode payment_mode,p.status payment_status,p.gateway,p.detail_json payment_detail_json
    FROM canonical_bookings b
    JOIN canonical_customers c ON c.id=b.customer_id
    JOIN provider_work_orders w ON w.booking_id=b.id
    JOIN booking_payments p ON p.booking_id=b.id
    ${where.length?`WHERE ${where.join(" AND ")}`:""}
    ORDER BY ${order} LIMIT ${limit}`;
  return db.prepare(sql).bind(...binds).all<Row>();
}

/*
 * The pets and seven child lists used to be read per booking: 8 queries per row, run row after row, so
 * the default 150-row window cost 1,209 D1 calls with a serial depth of ~158. At staging's ~0.3 s round
 * trip that is ~49 s, and the Command Center sat on "Loading connected booking records…" (master E2E run
 * 36243387701 row 40). Each list is now one read per chunk of booking ids, grouped here, and all of them
 * run together: the call count no longer grows with the window.
 *
 * The per-row reads left ties on the timestamp to the query plan. Each read below pins the order that
 * plan produced on production's schema, so no row moves: booking_lifecycle_events was already indexed on
 * (booking_id,occurred_at) and returned equal occurred_at newest rowid first; the other six tables had
 * no booking_id index and were scanned, so equal created_at came back in insertion (rowid) order; pets
 * were found through idx_canonical_pets_customer, so equal names came back in rowid order too.
 */
type BookingChildList="lifecycle"|"operations"|"notifications"|"rebooking"|"refunds"|"tickets"|"adminActions";
const BOOKING_CHILD_READS:ReadonlyArray<readonly [BookingChildList,(placeholders:string)=>string]>=[
  ["lifecycle",ids=>`SELECT * FROM booking_lifecycle_events WHERE booking_id IN (${ids}) ORDER BY occurred_at DESC,rowid DESC`],
  ["operations",ids=>`SELECT * FROM booking_operational_events WHERE booking_id IN (${ids}) ORDER BY created_at DESC,rowid`],
  ["notifications",ids=>`SELECT * FROM booking_customer_notifications WHERE booking_id IN (${ids}) ORDER BY created_at DESC,rowid`],
  ["rebooking",ids=>`SELECT * FROM booking_rebooking_cases WHERE booking_id IN (${ids}) ORDER BY created_at DESC,rowid`],
  ["refunds",ids=>`SELECT * FROM booking_refund_cases WHERE booking_id IN (${ids}) ORDER BY created_at DESC,rowid`],
  ["tickets",ids=>`SELECT * FROM customer_experience_tickets WHERE booking_id IN (${ids}) ORDER BY created_at DESC,rowid`],
  ["adminActions",ids=>`SELECT * FROM booking_admin_actions WHERE booking_id IN (${ids}) ORDER BY created_at DESC,rowid`],
];
/*
 * Pets keep the per-row predicate verbatim - the booking's own customer_id and the ids json_each yields
 * from its pet_ids_json - joined per chunk of bookings rather than read by a pooled list of pet ids. A
 * pooled list is chunked by pet, so one booking's pets can land in two chunks that are each sorted on
 * their own, and a pet another customer owns must still never appear. b.id is the grouping key only;
 * the output carries exactly the five columns it always did.
 */
const BOOKING_PETS_READ=(ids:string)=>`SELECT b.id booking_id,p.id,p.name,p.species,p.breed,p.vaccination_status FROM canonical_bookings b JOIN canonical_pets p ON p.customer_id=b.customer_id AND p.id IN (SELECT value FROM json_each(b.pet_ids_json)) WHERE b.id IN (${ids}) ORDER BY p.name,p.rowid`;

/** Rows of one read over every booking id, grouped by booking_id in the read's own order. */
async function rowsByBooking(db:Db,bookingIds:string[],read:(placeholders:string)=>string){
  const grouped=new Map<string,Row[]>();
  for(const row of await chunkedIn(bookingIds,async(chunk,placeholders)=>(await db.prepare(read(placeholders)).bind(...chunk).all<Row>()).results)){
    const id=String(row.booking_id),list=grouped.get(id);
    if(list)list.push(row);else grouped.set(id,[row]);
  }
  return grouped;
}

async function bookingSnapshot(db:Db,scope:Awaited<ReturnType<typeof resolveManagerOrganizationalScope>>,options:BookingListOptions={}){
  const rows=await bookingRows(db,scope,options);
  const ids=[...new Set(rows.results.map(row=>String(row.id)))];
  const[balances,supportCases,pets,children]=await Promise.all([
    bookingPaymentBalances(db,ids),
    bookingSupportCases(db,ids),
    rowsByBooking(db,ids,BOOKING_PETS_READ),
    Promise.all(BOOKING_CHILD_READS.map(async([list,read])=>[list,await rowsByBooking(db,ids,read)] as const)).then(entries=>new Map(entries)),
  ]);
  const casesByBooking=new Map<string,Row[]>();
  for(const supportCase of supportCases){const id=String(supportCase.booking_id);casesByBooking.set(id,[...(casesByBooking.get(id)||[]),supportCase]);}
  const child=(list:BookingChildList,id:string)=>children.get(list)?.get(id)||[];
  const bookings=[];
  for(const row of rows.results){
    const id=String(row.id),balance=balances.get(id);
    if(!balance)throw new Error("Canonical payment balance unavailable");
    const bookingPets=(pets.get(id)||[]).map(pet=>({id:pet.id,name:pet.name,species:pet.species,breed:pet.breed,vaccination_status:pet.vaccination_status}));
    bookings.push({...row,original_amount_due_now:row.amount_due_now,amount_due_now:balance.dueNow,payment_stage:balance.stage,outstanding_balance:balance.outstandingBalance,pricing:parse(row.pricing_json),assignment:parse(row.assignment_json),paymentDetail:parse(row.payment_detail_json),pets:bookingPets,lifecycle:child("lifecycle",id),operations:child("operations",id),notifications:child("notifications",id),rebooking:child("rebooking",id),refunds:child("refunds",id),tickets:[...child("tickets",id),...(casesByBooking.get(id)||[])],adminActions:child("adminActions",id)});
  }
  return{source:"canonical UAT database snapshot + live stream",bookings,organizationalScope:scope??"global"};
}

async function bookingStatusFingerprint(db:Db,scope:Awaited<ReturnType<typeof resolveManagerOrganizationalScope>>){
  const sql=`SELECT id,status,updated_at FROM canonical_bookings ${scope?"WHERE lower(city_id)=?":""} ORDER BY updated_at DESC,id LIMIT 150`;
  const result=scope?await db.prepare(sql).bind(scope.cityId).all<Row>():await db.prepare(sql).all<Row>();
  return JSON.stringify(result.results.map(row=>[row.id,row.status,row.updated_at]));
}

export async function GET(request: Request) {
  try {
    const actor=await authorize(request,"bookings.manage"),db=await database();
    await ensureTables(db);
    const scope=await resolveManagerOrganizationalScope(db,actor);requireManagerDomain(scope,OPERATIONS_MANAGER_DOMAIN);
    const url=new URL(request.url),wantsStream=url.searchParams.get("stream")==="1";
    if(!wantsStream)return Response.json(await bookingSnapshot(db,scope,parseBookingListOptions(url)));
    const encoder=new TextEncoder();
    let stopped=false,timer:ReturnType<typeof setTimeout>|null=null,lastFingerprint="";
    const stream=new ReadableStream<Uint8Array>({
      async start(controller){
        const send=(event:string,payload:unknown)=>controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        const close=()=>{if(stopped)return;stopped=true;if(timer)clearTimeout(timer);try{controller.close();}catch{}};
        request.signal.addEventListener("abort",close,{once:true});
        const tick=async()=>{
          if(stopped)return;
          try{
            const fingerprint=await bookingStatusFingerprint(db,scope);
            if(fingerprint!==lastFingerprint){lastFingerprint=fingerprint;send("bookings",await bookingSnapshot(db,scope));}
            else controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          }catch(error){send("error",{error:"Unable to refresh Booking Command Center stream"});close();return;}
          if(!stopped)timer=setTimeout(()=>void tick(),3000);
        };
        await tick();
      },
      cancel(){stopped=true;if(timer)clearTimeout(timer);},
    });
    return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform","connection":"keep-alive","x-accel-buffering":"no"}});
  } catch (error) { return authError(error,"Unable to load Booking Command Center"); }
}

export async function POST(request: Request) {
  try {
    const actor = await authorize(request, "bookings.manage");
    const db = await database();
    await ensureTables(db);
    const scope=await resolveManagerOrganizationalScope(db,actor);requireManagerDomain(scope,OPERATIONS_MANAGER_DOMAIN);
    const body = await request.json() as Row;
    const bookingId = String(body.bookingId || "");
    const action = String(body.action || "");
    const reason = String(body.reason || "").trim();
    if (!bookingId || !["call_customer", "whatsapp_customer", "open_tracking", "review_reassignment"].includes(action)) return Response.json({ error: "Valid booking and action are required" }, { status: 400 });
    if (reason.length < 5) return Response.json({ error: "A clear action reason is required" }, { status: 400 });
    const booking = await db.prepare("SELECT customer_id,city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
    if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });
    if(scope&&String(booking.city_id).toLowerCase()!==scope.cityId)return Response.json({error:"Booking is outside the manager's city scope"},{status:403});
    const now = Date.now(), eventId = crypto.randomUUID();
    await db.prepare("INSERT INTO booking_admin_actions (id,booking_id,action,reason,detail_json,actor_email,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(eventId, bookingId, action, reason, JSON.stringify({ uat: true, organizationalScope:scope??"global" }), actor.email, now).run();
    if (action === "whatsapp_customer") await db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), bookingId, booking.customer_id, "whatsapp", "admin_booking_update", "PawSpace Admin opened a service update for this booking.", "uat_queued", eventId, now).run();
    await securityAudit(db, actor, action, "booking", bookingId, "completed", { reason, uat: true, organizationalScope:scope??"global" });
    return Response.json({ ok: true, id: eventId, deliveryStatus: action === "whatsapp_customer" ? "uat_queued" : "recorded" }, { status: 201 });
  } catch (error) {
    return authError(error, "Unable to record booking action");
  }
}
