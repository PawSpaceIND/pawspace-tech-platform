import {ensurePlatformSessionTables,resolvePlatformSession} from "./platform-session";

type Db=D1Database;
type Row=Record<string,unknown>;

export const SCHEDULING_RESERVATION_LEASE_MS=15*60_000;
export const SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE="status!='cancelled' AND service_code!='boarding' AND care_mode IS NOT 'overnight'";
export const SCHEDULING_RESERVATION_ACTIVE_SLOT_CONFLICT_TARGET=`(provider_id,scheduled_start,scheduled_end) WHERE ${SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE}`;
const leaseTablesEnsured=new WeakSet<Db>();

async function tableExists(db:Db,name:string){
  const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

export async function ensureSchedulingReservationLeaseGovernance(db:Db){
  if(leaseTablesEnsured.has(db))return true;
  if(!(await tableExists(db,"scheduling_reservations")))return false;
  await ensurePlatformSessionTables(db);
  const columns=await db.prepare("PRAGMA table_info(scheduling_reservations)").all<Row>();
  if(!columns.results.some(row=>String(row.name)==="lease_expires_at"))await db.prepare("ALTER TABLE scheduling_reservations ADD COLUMN lease_expires_at INTEGER").run().catch(error=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
  if(!columns.results.some(row=>String(row.name)==="customer_session_id"))await db.prepare("ALTER TABLE scheduling_reservations ADD COLUMN customer_session_id TEXT").run().catch(error=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
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
  leaseTablesEnsured.add(db);
  return true;
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
  if(!(await ensureSchedulingReservationLeaseGovernance(db)))return{groups:0,reservations:0};
  const hasCanonical=await tableExists(db,"canonical_bookings");
  const confirmedClause=hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=r.group_id)":"";
  // Missing, revoked, expired and unknown session states fail closed. Superseded is deliberately valid
  // until the server-owned lease ends: issuing a replacement login must not silently discard checkout.
  const expiredLease="((r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=?) OR (r.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=r.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>?)))";
  const rows=await db.prepare(`SELECT DISTINCT r.group_id FROM scheduling_reservations r WHERE r.status='assigned' AND ${expiredLease} ${confirmedClause}`).bind(now,now).all<{group_id:string}>();
  let groups=0,reservations=0;
  const hasOffers=await tableExists(db,"provider_assignment_offers");
  for(const row of rows.results){
    const groupId=String(row.group_id),reason="reservation_lease_expired";
    const statements=[
      db.prepare(`INSERT OR IGNORE INTO scheduling_reservation_lease_cleanup (group_id,reason,released_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM scheduling_reservations r WHERE r.group_id=? AND r.status='assigned' AND ${expiredLease} ${confirmedClause})`).bind(groupId,reason,now,groupId,now,now),
      // Once any occurrence makes the still-unbooked group eligible, release every assigned occurrence.
      // Filtering each row by its own expiry left recurring groups half-active and still consuming
      // capacity when their lease metadata drifted.
      db.prepare(`UPDATE scheduling_reservations AS r SET status='cancelled' WHERE r.group_id=? AND r.status='assigned' ${confirmedClause} AND EXISTS (SELECT 1 FROM scheduling_reservations expired WHERE expired.group_id=r.group_id AND expired.status='assigned' AND ((expired.lease_expires_at IS NOT NULL AND expired.lease_expires_at<=?) OR (expired.customer_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_identity_sessions s WHERE s.id=expired.customer_session_id AND s.status IN ('active','superseded') AND s.expires_at>?))))`).bind(groupId,now,now),
      db.prepare(`UPDATE scheduling_assignment_decisions SET status='expired',actor_id='system:reservation-lease-cleanup',reason=?,updated_at=? WHERE group_id=? AND status IN ('assigned','awaiting_admin') AND EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=? AND c.released_at=?) ${hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=scheduling_assignment_decisions.group_id)":""}`).bind(reason,now,groupId,groupId,now),
    ];
    if(hasOffers)statements.push(db.prepare(`UPDATE provider_assignment_offers SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE group_id=? AND status='pending' AND EXISTS (SELECT 1 FROM scheduling_reservation_lease_cleanup c WHERE c.group_id=? AND c.released_at=?) ${hasCanonical?"AND NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.schedule_group_id=provider_assignment_offers.group_id)":""}`).bind(now,reason,now,groupId,groupId,now));
    const result=await db.batch(statements);
    const changed=Number(result[1]?.meta?.changes||0);
    if(changed>0){groups+=1;reservations+=changed;}
  }
  return{groups,reservations};
}
