import {assertCanonicalProviderPath,canonicalStateFromServiceStatus,ensureProviderLifecycleTables,type CanonicalProviderLifecycleState} from "./provider-lifecycle";
import {governedJsonError} from "./governed-http-error";
type Row=Record<string,unknown>;
/** Stage lifecycle handover in the SAME transaction as the booking, offer and recovery records. */
export async function groomingRecoveryLifecycle(db:D1Database,booking:Row,mode:"accept"|"replace"|"escalate",providerId:string|null,actorId:string){
 await ensureProviderLifecycleTables(db);
 const key=`grooming:${booking.id}`,now=Date.now();
 const row=await db.prepare("SELECT * FROM provider_lifecycle_records WHERE lifecycle_key=?").bind(key).first<Row>();
 const from=(row?String(row.status):canonicalStateFromServiceStatus("grooming",booking.status)) as CanonicalProviderLifecycleState;
 if(!["requested","provider_matched","accepted","in_transit","arrived"].includes(from)||(row?.provider_id!=null&&String(row.provider_id)!==String(booking.provider_id))||(row?.lease_token!=null&&Number(row.lease_expires_at)>=now))throw governedJsonError({error:"The service lifecycle changed or is busy. Refresh before recovery.",code:"RECOVERY_LIFECYCLE_CONFLICT"},409);
 const path:CanonicalProviderLifecycleState[]=mode==="accept"?["accepted"]:from==="requested"?(mode==="replace"?["provider_matched"]:[]):["rejected","requested",...(mode==="replace"?["provider_matched" as const]:[])];
 assertCanonicalProviderPath(from,path);const to=path.at(-1)??from;
 const guard=row?{sql:"EXISTS(SELECT 1 FROM provider_lifecycle_records WHERE lifecycle_key=? AND status=? AND provider_id IS ? AND version=? AND lease_token IS ?)",values:[key,row.status,row.provider_id??null,row.version,row.lease_token??null]}:{sql:"NOT EXISTS(SELECT 1 FROM provider_lifecycle_records WHERE lifecycle_key=?)",values:[key]};
 return {guard,statements:[
 db.prepare("INSERT INTO provider_lifecycle_records(lifecycle_key,booking_id,service_code,scope_id,provider_id,status,version,lease_token,lease_expires_at,updated_by,updated_at) VALUES (?,?,'grooming',?,?,?,1,NULL,NULL,?,?) ON CONFLICT(lifecycle_key) DO UPDATE SET provider_id=excluded.provider_id,status=excluded.status,version=provider_lifecycle_records.version+1,lease_token=NULL,lease_expires_at=NULL,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(key,booking.id,booking.id,providerId,to,actorId,now),
 db.prepare("INSERT INTO provider_lifecycle_events(id,lifecycle_key,booking_id,service_code,scope_id,provider_id,from_status,to_status,actor_id,reason,detail_json,created_at) VALUES (?,?,?,'grooming',?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),key,booking.id,booking.id,providerId,from,to,actorId,`Grooming recovery ${mode}`,JSON.stringify({path,previousProviderId:booking.provider_id}),now),
 ]};
}
