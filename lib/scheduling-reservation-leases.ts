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
    const schema=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('scheduling_reservations','uq_scheduling_reservations_active_provider_window','idx_scheduling_reservations_lease','scheduling_reservation_lease_cleanup','booking_reservation_confirmation_guards','block_expired_reservation_booking')").all<Row>();
    const names=new Set(schema.results.map(row=>String(row.name)));
    if(!names.has("scheduling_reservations"))return false;
    const columns=await db.prepare("PRAGMA table_info(scheduling_reservations)").all<Row>();
    const hasLease=columns.results.some(row=>String(row.name)==="lease_expires_at"),hasSession=columns.results.some(row=>String(row.name)==="customer_session_id");
    if(hasLease&&hasSession&&names.has("uq_scheduling_reservations_active_provider_window")&&names.has("idx_scheduling_reservations_lease")&&names.has("scheduling_reservation_lease_cleanup")&&names.has("booking_reservation_confirmation_guards")&&names.has("block_expired_reservation_booking")){leaseTablesEnsured.add(db);return true;}
    await ensurePlatformSessionTables(db);
    if(!hasLease)await db.prepare("ALTER TABLE scheduling_reservations ADD COLUMN lease_expires_at INTEGER").run().catch(error=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
    if(!hasSession)await db.prepare("ALTER TABLE scheduling_reservations ADD COLUMN customer_session_id TEXT").run().catch(error=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
    await db.batch([
      db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduling_reservations_active_provider_window ON scheduling_reservations(provider_id,scheduled_start,scheduled_end) WHERE ${SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE}`),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_scheduling_reservations_lease ON scheduling_reservations(status,lease_expires_at,customer_session_id)"),
      db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservation_lease_cleanup (group_id TEXT PRIMARY KEY,reason TEXT NOT NULL,released_at INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS booking_reservation_confirmation_guards (group_id TEXT PRIMARY KEY,checked_at INTEGER NOT NULL)"),
      // The guard runs inside the same D1 transaction as canonical booking/payment/work-order writes.
      // Cleanup and confirmation therefore serialize: cleanup-first cancels the lease and aborts booking;
      // booking-first creates canonical truth and makes the cleanup predicate ineligible.
      db.prepare("CREATE TRIGGER IF NOT EXISTS block_expired_reservation_booking BEFORE INSERT ON booking_reservation_confirmation_guards WHEN NOT EXISTS (SELECT 1 FROM scheduling_reservations r WHERE r.group_id=NEW.group_id AND r.status!='cancelled') OR EXISTS (SELECT 1 FROM scheduling_reservations r WHERE r.group_id=NEW.group_id AND r.status!='cancelled' AND ((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=NEW.checked_at) OR (r.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=r.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>NEW.checked_at)))) BEGIN SELECT RAISE(ABORT,'reservation_lease_expired_before_booking'); END"),
    ]);
    leaseTablesEnsured.add(db);return true;
  })();
  leaseTablesEnsuring.set(db,pending);
  try{return await pending;}finally{if(leaseTablesEnsuring.get(db)===pending)leaseTablesEnsuring.delete(db);}
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
    const confirmedClause=hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=r.group_id)":"";
    // Missing, revoked, expired and unknown session states fail closed. Superseded is deliberately valid
    // until the server-owned lease ends: issuing a replacement login must not silently discard checkout.
    const expiredLease="((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=?) OR (r.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=r.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>?)))";
    const expired=await db.prepare(`SELECT DISTINCT r.group_id FROM scheduling_reservations r WHERE r.status='assigned' AND ${expiredLease} ${confirmedClause} LIMIT 8`).bind(now,now).all<{group_id:string}>();
    const groupIds=expired.results.map(row=>String(row.group_id));
    if(!groupIds.length)return{groups:0,reservations:0};
    const placeholders=groupIds.map(()=>"?").join(","),reason="reservation_lease_expired";
    const hasOffers=await tableExists(db,"provider_assignment_offers");
    const marker=`EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=r.group_id AND c.reason=? AND c.released_at=?)`;
    const statements=[
      // Advance the durable marker without REPLACE's delete/reinsert race. A later legitimate lease
      // expiry for the same group may advance released_at; a same-generation contender cannot steal it.
      db.prepare(`INSERT INTO scheduling_reservation_lease_cleanup (group_id,reason,released_at) SELECT DISTINCT r.group_id,?,? FROM scheduling_reservations r WHERE r.group_id IN (${placeholders}) AND r.status='assigned' AND ${expiredLease} ${confirmedClause} ON CONFLICT(group_id) DO UPDATE SET reason=excluded.reason,released_at=excluded.released_at WHERE scheduling_reservation_lease_cleanup.released_at<excluded.released_at`).bind(reason,now,...groupIds,now,now),
      // Once any occurrence makes the still-unbooked group eligible, release every assigned occurrence.
      db.prepare(`UPDATE scheduling_reservations AS r SET status='cancelled' WHERE r.status='assigned' AND r.group_id IN (${placeholders}) AND ${marker}`).bind(...groupIds,reason,now),
      db.prepare(`UPDATE scheduling_assignment_decisions AS r SET status='expired',actor_id='system:reservation-lease-cleanup',reason=?,updated_at=? WHERE r.status IN ('assigned','awaiting_admin') AND r.group_id IN (${placeholders}) AND ${marker}`).bind(reason,now,...groupIds,reason,now),
    ];
    if(hasOffers)statements.push(db.prepare(`UPDATE provider_assignment_offers AS r SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE r.status='pending' AND r.group_id IN (${placeholders}) AND ${marker}`).bind(now,reason,now,...groupIds,reason,now));
    const result=await db.batch(statements);
    return{groups:Number(result[0]?.meta?.changes||0),reservations:Number(result[1]?.meta?.changes||0)};
  })();
  cleanupRunning.set(db,pending);
  try{return await pending;}finally{if(cleanupRunning.get(db)===pending)cleanupRunning.delete(db);}
}
