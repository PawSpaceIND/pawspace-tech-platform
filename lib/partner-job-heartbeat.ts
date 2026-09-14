import {createUnifiedCase} from "./unified-case-center";
export const HEARTBEAT_STALE_MS=3*60_000;
export async function ensurePartnerHeartbeatTables(db:D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS partner_job_heartbeats (booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,last_seen_at INTEGER NOT NULL,tracking_state TEXT NOT NULL,PRIMARY KEY(booking_id,provider_id))").run();
}
export function heartbeatIsStale(lastSeen:number,now:number) {return now-lastSeen>=HEARTBEAT_STALE_MS;}
export async function recordPartnerHeartbeat(db:D1Database,input:{bookingId:string;providerId:string;trackingState:string},now=Date.now()) {
  await ensurePartnerHeartbeatTables(db);
  // INSERT SELECT rechecks assignment and duty state at write time, including races with completion.
  const result=await db.prepare("INSERT INTO partner_job_heartbeats (booking_id,provider_id,last_seen_at,tracking_state) SELECT b.id,b.provider_id,?,? FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id AND w.provider_id=b.provider_id WHERE b.id=? AND b.provider_id=? AND b.service_code='grooming' AND b.status IN ('assigned','on_the_way','arrived','in_service') AND w.status IN ('assigned','on_the_way','arrived','in_service') ON CONFLICT(booking_id,provider_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,tracking_state=excluded.tracking_state").bind(now,input.trackingState,input.bookingId,input.providerId).run();
  return Number(result.meta.changes)>0;
}
export async function sweepPartnerHeartbeats(db:D1Database,now=Date.now()) {
  await ensurePartnerHeartbeatTables(db);
  // Include jobs whose app never sent its first heartbeat. Future assignments are monitored from two hours before service.
  const jobs=await db.prepare("SELECT b.id,b.provider_id,b.customer_id,COALESCE(h.last_seen_at,w.updated_at) last_seen_at FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id AND w.provider_id=b.provider_id LEFT JOIN partner_job_heartbeats h ON h.booking_id=b.id AND h.provider_id=b.provider_id WHERE b.service_code='grooming' AND b.status IN ('assigned','on_the_way','arrived','in_service') AND w.status IN ('assigned','on_the_way','arrived','in_service') AND (b.status!='assigned' OR CAST(strftime('%s',b.scheduled_start) AS INTEGER)*1000<=?) AND COALESCE(h.last_seen_at,w.updated_at)<=? ORDER BY last_seen_at LIMIT 200").bind(now+2*60*60_000,now-HEARTBEAT_STALE_MS).all<{id:string;provider_id:string;customer_id:string;last_seen_at:number}>();
  let created=0;
  for(const job of jobs.results){
    // One case per outage (last confirmed contact), not one per cron tick.
    const result=await createUnifiedCase(db,{idempotencyKey:`partner-unreachable:${job.id}:${job.provider_id}:${job.last_seen_at}`,caseType:"provider_issue",severity:"high",title:"Partner unreachable during active job",description:`No heartbeat since ${new Date(job.last_seen_at).toISOString()}. Contact the partner and customer. Connectivity loss, a suspended app or an unavailable device are possible; device failure is not confirmed.`,bookingId:job.id,providerId:job.provider_id,customerId:job.customer_id,sourceType:"partner_heartbeat",sourceId:job.id,ownerTeam:"operations",actorId:"system:partner-heartbeat",asOf:now});
    if(!result.duplicatePrevented)created++;
  }
  return{checked:jobs.results.length,created};
}
