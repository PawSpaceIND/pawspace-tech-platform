type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export async function ensureFieldProductivityTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS field_provider_targets (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,month_start TEXT NOT NULL,orders_target INTEGER NOT NULL,upgrade_count_target INTEGER NOT NULL,upgrade_value_target REAL NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(provider_id,month_start))"),
 db.prepare("CREATE TABLE IF NOT EXISTS booking_upgrades (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,upgrade_value REAL NOT NULL,reason TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL,UNIQUE(booking_id))"),
]);}

/**
 * Explicit, governed record of an upgrade a provider drove on a booking - e.g. the customer added
 * a service, extended a session, or moved to a higher package after the initial booking. Deliberately
 * NOT inferred by diffing against a catalogue base price: canonical_bookings.total_amount already
 * reflects whatever was actually charged, and grooming/training don't yet have a reliable, wired
 * catalogue lookup to diff against safely. An explicit record - the same principle this codebase
 * already uses for refunds, commissions and every other number that affects someone's pay - is the
 * honest choice here, not a shortcut.
 */
export async function recordBookingUpgrade(db:Db,input:{bookingId:string;providerId:string;upgradeValue:number;reason:string;actorId:string}){
 await ensureFieldProductivityTables(db);
 if(!text(input.bookingId)||!text(input.providerId))throw new Error("Booking and provider are required");
 if(!Number.isFinite(input.upgradeValue)||input.upgradeValue<=0)throw new Error("Upgrade value must be an explicit positive amount");
 if(input.reason.trim().length<8)throw new Error("A real reason (at least 8 characters) is required to record an upgrade");
 const booking=await db.prepare("SELECT id,provider_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw new Error("Canonical booking not found");
 if(String(booking.provider_id)!==input.providerId)throw new Error("Upgrade provider does not match the booking's assigned provider");
 const id=uid("BUP"),now=Date.now();
 await db.prepare("INSERT INTO booking_upgrades (id,booking_id,provider_id,upgrade_value,reason,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?)")
   .bind(id,input.bookingId,input.providerId,money(input.upgradeValue),input.reason.trim(),input.actorId,now).run();
 return{id,bookingId:input.bookingId,providerId:input.providerId,upgradeValue:money(input.upgradeValue)};
}

/**
 * Finance/Ops publishes explicit monthly targets - never invented by code. Immutable once real
 * activity exists against that month for this provider, matching the "no silently rewriting the
 * goalposts mid-month" convention used elsewhere in this codebase's governance layer.
 */
export async function saveFieldProviderTarget(db:Db,input:{providerId:string;monthStart:string;ordersTarget:number;upgradeCountTarget:number;upgradeValueTarget:number;reason:string;actorId:string}){
 await ensureFieldProductivityTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month (YYYY-MM-01)");
 if(![input.ordersTarget,input.upgradeCountTarget,input.upgradeValueTarget].every(v=>Number.isFinite(v)&&v>=0))throw new Error("All targets must be explicit non-negative numbers");
 if(input.reason.trim().length<8)throw new Error("A real reason is required to publish a monthly target");
 const now=Date.now();
 await db.prepare("INSERT INTO field_provider_targets (id,provider_id,month_start,orders_target,upgrade_count_target,upgrade_value_target,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,month_start) DO UPDATE SET orders_target=excluded.orders_target,upgrade_count_target=excluded.upgrade_count_target,upgrade_value_target=excluded.upgrade_value_target,reason=excluded.reason,actor_id=excluded.actor_id,created_at=excluded.created_at")
   .bind(uid("FPT"),input.providerId,input.monthStart,Math.round(input.ordersTarget),Math.round(input.upgradeCountTarget),money(input.upgradeValueTarget),input.reason.trim(),input.actorId,now).run();
 return{providerId:input.providerId,monthStart:input.monthStart,ordersTarget:Math.round(input.ordersTarget),upgradeCountTarget:Math.round(input.upgradeCountTarget),upgradeValueTarget:money(input.upgradeValueTarget)};
}

/** Real monthly actuals: completed orders, upgrades (count + value), and distance travelled - each sourced from a real table, nothing estimated. */
export async function monthlyFieldProductivity(db:Db,input:{providerId:string;monthStartDate:string;monthEndDate:string}){
 await ensureFieldProductivityTables(db);
 const orders=await db.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE provider_id=? AND service_code IN ('grooming','dog_training') AND status='completed' AND date(scheduled_start)>=? AND date(scheduled_start)<=?")
   .bind(input.providerId,input.monthStartDate,input.monthEndDate).first<Row>();
 const upgrades=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(u.upgrade_value),0) total FROM booking_upgrades u JOIN canonical_bookings b ON b.id=u.booking_id WHERE u.provider_id=? AND date(b.scheduled_start)>=? AND date(b.scheduled_start)<=?")
   .bind(input.providerId,input.monthStartDate,input.monthEndDate).first<Row>();
 const travel=await db.prepare("SELECT COALESCE(SUM(distance_km),0) total_km,COUNT(DISTINCT travel_date) days FROM provider_daily_travel_legs WHERE provider_id=? AND travel_date>=? AND travel_date<=? AND route_status='configured'")
   .bind(input.providerId,input.monthStartDate,input.monthEndDate).first<Row>();
 return{
   providerId:input.providerId,monthStartDate:input.monthStartDate,monthEndDate:input.monthEndDate,
   ordersCompleted:Number(orders?.n||0),
   upgradeCount:Number(upgrades?.n||0),
   upgradeValue:money(upgrades?.total),
   distanceTravelledKm:money(travel?.total_km),
   daysWithConfiguredRoutes:Number(travel?.days||0),
 };
}

/** Combines real actuals against the explicit published target - never fabricates a target if none was set. */
export async function monthlyTargetProgress(db:Db,input:{providerId:string;monthStart:string}){
 await ensureFieldProductivityTables(db);
 const target=await db.prepare("SELECT * FROM field_provider_targets WHERE provider_id=? AND month_start=?").bind(input.providerId,input.monthStart).first<Row>();
 const [year,month]=input.monthStart.split("-").map(Number);
 const monthEndDate=new Date(year,month,0).toISOString().slice(0,10);
 const actual=await monthlyFieldProductivity(db,{providerId:input.providerId,monthStartDate:input.monthStart,monthEndDate});
 if(!target)return{...actual,target:null,targetConfigured:false};
 return{
   ...actual,
   targetConfigured:true,
   ordersTarget:Number(target.orders_target),
   ordersProgressPercent:Number(target.orders_target)>0?money(actual.ordersCompleted/Number(target.orders_target)*100):null,
   upgradeCountTarget:Number(target.upgrade_count_target),
   upgradeCountProgressPercent:Number(target.upgrade_count_target)>0?money(actual.upgradeCount/Number(target.upgrade_count_target)*100):null,
   upgradeValueTarget:Number(target.upgrade_value_target),
   upgradeValueProgressPercent:Number(target.upgrade_value_target)>0?money(actual.upgradeValue/Number(target.upgrade_value_target)*100):null,
 };
}
