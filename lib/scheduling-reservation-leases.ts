import {ensurePlatformSessionTables,resolvePlatformSession} from "./platform-session";

type Db=D1Database;
type Row=Record<string,unknown>;

export const SCHEDULING_RESERVATION_LEASE_MS=15*60_000;
export const SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE="status!='cancelled' AND service_code!='boarding' AND care_mode IS NOT 'overnight'";
export const SCHEDULING_RESERVATION_ACTIVE_SLOT_CONFLICT_TARGET=`(provider_id,scheduled_start,scheduled_end) WHERE ${SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE}`;
const leaseTablesEnsured=new WeakSet<Db>();
const leaseTablesEnsuring=new WeakMap<Db,Promise<boolean>>();
const cleanupRunning=new WeakMap<Db,Promise<{groups:number;reservations:number}>>();

async function tableExists(db:Db,name:string){
  const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

export async function ensureSchedulingReservationLeaseGovernance(db:Db){
  if(leaseTablesEnsured.has(db))return true;
  const running=leaseTablesEnsuring.get(db);if(running)return running;
  const pending=(async()=>{
    if(!(await tableExists(db,"scheduling_reservations")))return false;
    const columns=await db.prepare("PRAGMA table_info(scheduling_reservations)").all<Row>();
    const hasLease=columns.results.some(row=>String(row.name)==="lease_expires_at"),hasSession=columns.results.some(row=>String(row.name)==="customer_session_id");
    const schema=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_scheduling_reservations_lease','scheduling_reservation_lease_cleanup','booking_reservation_confirmation_guards','block_expired_reservation_booking')").all<Row>();
    if(hasLease&&hasSession&&new Set(schema.results.map(row=>String(row.name))).size===4){leaseTablesEnsured.add(db);return true;}
    await ensurePlatformSessionTables(db);
    if(!hasLease)await db.prepare("ALTER TABLE scheduling_reservations ADD COLUMN lease_expires_at INTEGER").run().catch(error=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
    if(!hasSession)await db.prepare("ALTER TABLE scheduling_reservations ADD COLUMN customer_session_id TEXT").run().catch(error=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS idx_scheduling_reservations_lease ON scheduling_reservations(status,lease_expires_at,customer_session_id)"),
      db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservation_lease_cleanup (group_id TEXT PRIMARY KEY,reason TEXT NOT NULL,released_at INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS booking_reservation_confirmation_guards (group_id TEXT PRIMARY KEY,checked_at INTEGER NOT NULL)"),
      db.prepare("CREATE TRIGGER IF NOT EXISTS block_expired_reservation_booking BEFORE INSERT ON booking_reservation_confirmation_guards WHEN NOT EXISTS (SELECT 1 FROM scheduling_reservations r WHERE r.group_id=NEW.group_id AND r.status!='cancelled') OR EXISTS (SELECT 1 FROM scheduling_reservations r WHERE r.group_id=NEW.group_id AND r.status!='cancelled' AND ((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=NEW.checked_at) OR (r.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=r.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>NEW.checked_at)))) BEGIN SELECT RAISE(ABORT,'reservation_lease_expired_before_booking'); END"),
    ]);leaseTablesEnsured.add(db);return true;
  })();leaseTablesEnsuring.set(db,pending);try{return await pending;}finally{if(leaseTablesEnsuring.get(db)===pending)leaseTablesEnsuring.delete(db);}
}

export async function reservationLeaseForRequest(db:Db,request:Request,customerId:string,now=Date.now()){
  await ensureSchedulingReservationLeaseGovernance(db);
  const session=await resolvePlatformSession(db,request);
  const owned=session?.subjectType==="customer"&&session.subjectId===customerId?session:null;
  return{
    customerSessionId:owned?.sessionId??null,
    leaseExpiresAt:Math.min(now+SCHEDULING_RESERVATION_LEASE_MS,owned?.expiresAt??Number.POSITIVE_INFINITY),
  };
}

export async function cleanupExpiredReservationLeases(db:Db,now=Date.now()){
  const running=cleanupRunning.get(db);if(running)return running;
  const pending=(async()=>{
    if(!(await ensureSchedulingReservationLeaseGovernance(db)))return{groups:0,reservations:0};
    const hasCanonical=await tableExists(db,"canonical_bookings");
    const reservationConfirmed=hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=r.group_id)":"";
    const expiredLease="((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=?) OR (r.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=r.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>?)))";
    const candidate=await db.prepare(`SELECT r.group_id FROM scheduling_reservations r WHERE r.status='assigned' AND ${expiredLease} ${reservationConfirmed} LIMIT 1`).bind(now,now).first<Row>();if(!candidate)return{groups:0,reservations:0};
    const reason="reservation_lease_expired",hasOffers=await tableExists(db,"provider_assignment_offers");
    const decisionConfirmed=hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=scheduling_assignment_decisions.group_id)":"";
    const offerConfirmed=hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=provider_assignment_offers.group_id)":"";
    const statements=[
      db.prepare(`INSERT OR REPLACE INTO scheduling_reservation_lease_cleanup (group_id,reason,released_at) SELECT DISTINCT r.group_id,?,? FROM scheduling_reservations r WHERE r.status='assigned' AND ${expiredLease} ${reservationConfirmed}`).bind(reason,now,now,now),
      db.prepare(`UPDATE scheduling_reservations AS r SET status='cancelled' WHERE r.status='assigned' ${reservationConfirmed} AND EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=r.group_id AND c.reason=? AND c.released_at=?)`).bind(reason,now),
      db.prepare(`UPDATE scheduling_assignment_decisions SET status='expired',actor_id='system:reservation-lease-cleanup',reason=?,updated_at=? WHERE status IN ('assigned','awaiting_admin') AND EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=scheduling_assignment_decisions.group_id AND c.reason=? AND c.released_at=?) ${decisionConfirmed}`).bind(reason,now,reason,now),
    ];
    if(hasOffers)statements.push(db.prepare(`UPDATE provider_assignment_offers SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE status='pending' AND EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=provider_assignment_offers.group_id AND c.reason=? AND c.released_at=?) ${offerConfirmed}`).bind(now,reason,now,reason,now));
    const result=await db.batch(statements);return{groups:Number(result[0]?.meta?.changes||0),reservations:Number(result[1]?.meta?.changes||0)};
  })();cleanupRunning.set(db,pending);try{return await pending;}finally{if(cleanupRunning.get(db)===pending)cleanupRunning.delete(db);}
}
