import {trainingBroadcastOffer,expireTrainingBroadcasts} from './training-broadcast-integration';
import { repository, activeRules, parallelAppointmentsFor } from '../app/api/uat-scheduling/route';
import { schedule, buildOccurrences, type ScheduleRequest } from '../backend/src/scheduling';
import { ensureProviderCapacityTables, getProviderAcceptanceTimeout } from './provider-capacity-governance';
import { ensureProviderLifecycleTables } from './provider-lifecycle';
import { ensureProviderHomeBaseTables } from './provider-home-base';
import { resolveAssignmentPolicy } from './provider-assignment-policy';
type Row=Record<string,unknown>;
const txt=(v:unknown)=>String(v??'');
const parse=<T>(v:unknown):T=>JSON.parse(txt(v));
const conflict=(message:string)=>new Response(message,{status:409});
export async function ensureTrainingDispatchTables(db:D1Database){await ensureProviderCapacityTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS training_assignment_chains (booking_id TEXT PRIMARY KEY,group_id TEXT NOT NULL UNIQUE,first_session_id TEXT NOT NULL,started_at INTEGER NOT NULL,ops_due_at INTEGER NOT NULL,max_attempts INTEGER NOT NULL,policy_json TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,excluded_json TEXT NOT NULL DEFAULT '[]')"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_assignment_attempts (booking_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL,offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,reason TEXT,PRIMARY KEY(booking_id,attempt_no))"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_assignment_responses (idempotency_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_assignment_notifications (booking_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'not_dispatched',external_delivery INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,PRIMARY KEY(booking_id,attempt_no))"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_assignment_ops_cases (booking_id TEXT PRIMARY KEY,reason TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_session_recovery_cases (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,programme_id TEXT NOT NULL,booking_id TEXT NOT NULL,recovery_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',reason TEXT NOT NULL,requested_by TEXT NOT NULL,replacement_provider_id TEXT,new_start TEXT,new_end TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_assignment_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))"),
]);}
/** Called only for a newly materialized programme, never an historical offer sweep. */
export async function prepareTrainingDispatch(db:D1Database,b:Row,firstSessionId:string){
 const bookingId=txt(b.id);
 await ensureTrainingDispatchTables(db);
 const o=await db.prepare("SELECT * FROM provider_assignment_offers WHERE group_id=? AND provider_id=? AND status='pending'").bind(b.schedule_group_id,b.provider_id).first<Row>();if(!o)return [];
 const decision=await db.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").bind(b.schedule_group_id).first<Row>();
 const request=decision?parse<{request?:Row}>(decision.shortlist_json).request:null;
 const p=await resolveAssignmentPolicy(db,'dog_training',txt(b.city_id),new Date(txt(b.scheduled_start)),{readOnly:true});
 const max=Math.max(1,p.config.fallbackAttempts),minutes=p.config.opsEscalationMinutes;
 if(!request||request.serviceCode!=='dog_training'||!Number.isInteger(max)||max<1||!Number.isInteger(minutes)||minutes<0)throw conflict('Training dispatch configuration or original scheduling request is unavailable');
 const started=Number(o.offered_at),due=started+minutes*60000;
 return [
  db.prepare("INSERT OR IGNORE INTO training_assignment_chains (booking_id,group_id,first_session_id,started_at,ops_due_at,max_attempts,policy_json,request_json,state) VALUES (?,?,?,?,?,?,?,?, 'pending')").bind(bookingId,b.schedule_group_id,firstSessionId,started,due,max,JSON.stringify(p.config),JSON.stringify(request)),
  db.prepare("INSERT OR IGNORE INTO training_assignment_attempts (booking_id,attempt_no,provider_id,status,offered_at,expires_at) VALUES (?,?,?,'pending',?,?)").bind(bookingId,Number(o.attempt_no||1),o.provider_id,o.offered_at,Math.min(Number(o.expires_at),due)),
  db.prepare("UPDATE provider_assignment_offers SET expires_at=MIN(expires_at,?) WHERE group_id=? AND provider_id=? AND status='pending'").bind(due,b.schedule_group_id,o.provider_id),
  db.prepare("INSERT OR IGNORE INTO training_assignment_notifications (booking_id,attempt_no,provider_id,created_at) VALUES (?,?,?,?)").bind(bookingId,Number(o.attempt_no||1),o.provider_id,Date.now()),
 ];
}
async function approvedSessionReplacement(db:D1Database,sessionId:string,bookingId:string,providerId:string){
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('training_session_recovery_cases','training_sessions')").all<Row>();if(tables.results.length!==2)return null;
 const sql="EXISTS(SELECT 1 FROM training_session_recovery_cases r JOIN training_sessions s ON s.id=r.session_id WHERE r.session_id=? AND r.booking_id=? AND r.recovery_type='replacement' AND r.status='resolved' AND r.replacement_provider_id=? AND s.booking_id=r.booking_id AND s.provider_id=r.replacement_provider_id)";
 const binds=[sessionId,bookingId,providerId];return await db.prepare(`SELECT 1 ok WHERE ${sql}`).bind(...binds).first()?{sql,binds,statements:[] as D1PreparedStatement[]}:null;
}
export async function trainingAssignmentOffer(db:D1Database,bookingId:string,providerId:string,sessionId?:string){
 if(sessionId&&await approvedSessionReplacement(db,sessionId,bookingId,providerId))return null;
 const broadcast=await trainingBroadcastOffer(db,bookingId,providerId);if(broadcast!==undefined)return broadcast;
 const schema=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('canonical_bookings','provider_assignment_offers','training_assignment_chains','training_assignment_attempts')").all<Row>();const tables=new Set(schema.results.map(r=>txt(r.name)));if(!tables.has('canonical_bookings')||!tables.has('provider_assignment_offers'))return null;
 const b=await db.prepare("SELECT schedule_group_id,provider_id FROM canonical_bookings WHERE id=? AND service_code='dog_training'").bind(bookingId).first<Row>();if(!b)return null;
 const chain=tables.has('training_assignment_chains')?await db.prepare("SELECT state,ops_due_at FROM training_assignment_chains WHERE booking_id=?").bind(bookingId).first<Row>():null;
 const o=await db.prepare("SELECT * FROM provider_assignment_offers WHERE group_id=?").bind(b.schedule_group_id).first<Row>();if(!o)return null;
 const prior=tables.has('training_assignment_attempts')?await db.prepare('SELECT 1 ok FROM training_assignment_attempts WHERE booking_id=? AND provider_id=?').bind(bookingId,providerId).first<Row>():null;
 if(txt(b.provider_id)!==providerId&&!prior)throw new Response('Training assignment ownership denied',{status:403});
 const now=Date.now(),state=txt(o.provider_id)!==providerId?'withdrawn':chain?.state==='needs_operations'?'needs_operations':o.status==='pending'?(Number(o.expires_at)<=now||chain&&Number(chain.ops_due_at)<=now?'expired':'open'):o.status==='accepted'?'accepted':'withdrawn';
 return{state,providerId:providerId,attemptNo:Number(o.attempt_no),expiresAt:Number(o.expires_at),opsDueAt:chain?Number(chain.ops_due_at):null,reason:txt(o.response_reason)||null,notificationStatus:'not_dispatched',externalDelivery:false,canDecline:state==='open'&&Number(o.attempt_no)>0};
}
/** Return conditions/statements to run in the SAME lifecycle transaction as session acceptance. */
export async function trainingAcceptanceGuard(db:D1Database,row:Row){
 await ensureTrainingDispatchTables(db);
 const replacement=await approvedSessionReplacement(db,txt(row.id),txt(row.booking_id),txt(row.provider_id));if(replacement)return replacement;
 const b=await db.prepare("SELECT schedule_group_id FROM canonical_bookings WHERE id=? AND service_code='dog_training'").bind(row.booking_id).first<Row>();
 const o=b?await db.prepare("SELECT * FROM provider_assignment_offers WHERE group_id=?").bind(b.schedule_group_id).first<Row>():null;
 if(!o){if(await db.prepare('SELECT 1 ok FROM training_assignment_chains WHERE booking_id=?').bind(row.booking_id).first())throw conflict('Training assignment offer is missing');return{sql:'1',binds:[] as unknown[],statements:[] as D1PreparedStatement[]};} // Unchanged legacy/no-offer programmes retain their existing acceptance contract.
 if(txt(o.provider_id)!==txt(row.provider_id))throw conflict('Training offer belongs to another trainer');
 if(o.status==='accepted')return{sql:"EXISTS(SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id=? AND status='accepted')",binds:[b!.schedule_group_id,row.provider_id],statements:[] as D1PreparedStatement[]};
 const now=Date.now();if(o.status!=='pending'||Number(o.expires_at)<=now)throw conflict('Training assignment offer expired or was withdrawn; Operations must recover it');
 const chain=await db.prepare("SELECT state,ops_due_at,first_session_id FROM training_assignment_chains WHERE booking_id=?").bind(row.booking_id).first<Row>();if(chain&&(chain.state!=='pending'||chain.first_session_id!==row.id||Number(chain.ops_due_at)<=now))throw conflict('Training assignment requires Operations');
 const guard="EXISTS(SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id=? AND status='pending' AND attempt_no=? AND expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) AND NOT EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND (state!='pending' OR first_session_id!=? OR ops_due_at<=MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))";
 const binds=[b!.schedule_group_id,row.provider_id,o.attempt_no,now,row.booking_id,row.id,now];
 return{sql:guard,binds,statements:[
  db.prepare(`UPDATE provider_assignment_offers SET status='accepted',responded_at=?,response_reason='Accepted in Training session',updated_at=? WHERE group_id=? AND ${guard}`).bind(now,now,b!.schedule_group_id,...binds),
  db.prepare("UPDATE training_assignment_attempts SET status='accepted',responded_at=? WHERE booking_id=? AND attempt_no=? AND provider_id=? AND status='pending'").bind(now,row.booking_id,o.attempt_no,row.provider_id),
  db.prepare("UPDATE training_assignment_chains SET state='accepted',revision=revision+1 WHERE booking_id=? AND state='pending'").bind(row.booking_id),
 ]};
}
type DispatchRequest=Parameters<typeof repository>[1]&{cityId:string;zoneId:string};
type Snapshot={sql:string;binds:unknown[];value:string};
export async function dispatchSnapshots(db:D1Database,request:DispatchRequest):Promise<Snapshot[]>{
 await ensureProviderHomeBaseTables(db);
 const profile=await db.prepare('SELECT MAX(travel_buffer_minutes) maximum FROM provider_capacity_profiles WHERE city_id=?').bind(request.cityId).first<Row>(),margin=Math.max(86400000,Number(profile?.maximum||0)*60000);
 const occurrences=buildOccurrences(request),from=new Date(Math.min(...occurrences.map(o=>Date.parse(o.start)))-margin).toISOString(),to=new Date(Math.max(...occurrences.map(o=>Date.parse(o.end)))+margin).toISOString();
 const definitions:[string,string,unknown[]][]=[
 ['provider_capacity_profiles','city_id=?',[request.cityId]],
 ['scheduling_availability','city_id=? AND date>=? AND date<=?',[request.cityId,from.slice(0,10),to.slice(0,10)]],
 ['provider_unavailability','provider_id IN (SELECT id FROM provider_capacity_profiles WHERE city_id=?)',[request.cityId]],
 ['provider_home_base','provider_id IN (SELECT id FROM provider_capacity_profiles WHERE city_id=?)',[request.cityId]],
 ['scheduling_reservations',"city_id=? AND status!='cancelled' AND (julianday(scheduled_start) IS NULL OR julianday(scheduled_end) IS NULL OR (julianday(scheduled_start)<=julianday(?) AND julianday(scheduled_end)>=julianday(?)))",[request.cityId,to,from]],
 ['scheduling_rules','(service_code IS NULL OR service_code=?) AND (city_id IS NULL OR city_id=?) AND (zone_id IS NULL OR zone_id=?)',['dog_training',request.cityId,request.zoneId]],
 ];
 const snapshots:Snapshot[]=[];
 const present=new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<Row>()).results.map(r=>txt(r.name)));
 const providers="SELECT id FROM provider_capacity_profiles WHERE city_id=?";
 const employees=present.has('provider_people_links')?`SELECT employee_id FROM provider_people_links WHERE provider_id IN (${providers})`:null;
 definitions.push(
 ['provider_onboarding_applications',`provider_id IN (${providers})`,[request.cityId]],
 ['provider_verifications',present.has('provider_onboarding_applications')?`application_id IN (SELECT id FROM provider_onboarding_applications WHERE provider_id IN (${providers}))`:'0',present.has('provider_onboarding_applications')?[request.cityId]:[]],
 ['service_policy_configs',"policy_domain='provider_verification_policy'",[]],
 ['provider_people_links',`provider_id IN (${providers})`,[request.cityId]],
 ['employees',employees?`id IN (${employees})`:'0',employees?[request.cityId]:[]],
 ['leave_requests',employees?`employee_id IN (${employees})`:'0',employees?[request.cityId]:[]],
 ['employee_shift_assignments',employees?`employee_id IN (${employees})`:'0',employees?[request.cityId]:[]],
 ['shift_policies',employees&&present.has('employee_shift_assignments')?`id IN (SELECT shift_policy_id FROM employee_shift_assignments WHERE employee_id IN (${employees}))`:'0',employees&&present.has('employee_shift_assignments')?[request.cityId]:[]],
 );
 for(const [table,where,binds] of definitions){
  const columns=await db.prepare(`PRAGMA table_info(${table})`).all<Row>();
  if(!columns.results.length){const sql="SELECT COUNT(*) value FROM sqlite_master WHERE type='table' AND name=?";snapshots.push({sql,binds:[table],value:'0'});continue;}
  const expression=columns.results.map(c=>`quote("${txt(c.name).replaceAll('"','""')}")`).join("||'|'||");
  const sql=`SELECT COALESCE(group_concat(value,char(10)),'') value FROM (SELECT ${expression} value FROM ${table} WHERE ${where} ORDER BY value)`;
  const row=await db.prepare(sql).bind(...binds).first<Row>();snapshots.push({sql,binds,value:txt(row?.value)});
 }
 return snapshots;
}
export type TrainingOfferResponse={sessionId:string;providerId:string;action:'decline'|'timeout';expectedAttemptNo:number;idempotencyKey:string;reason:string;actorId:string};
export async function respondTrainingOffer(db:D1Database,input:TrainingOfferResponse){
 await ensureTrainingDispatchTables(db);
 const fingerprint=JSON.stringify([input.sessionId,input.providerId,input.action,input.expectedAttemptNo,input.reason]);
 const prior=await db.prepare("SELECT fingerprint,result_json FROM training_assignment_responses WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(prior){if(prior.fingerprint!==fingerprint)throw conflict('Training response key was used for different input');return{...parse<Row>(prior.result_json),duplicatePrevented:true};}
 await ensureProviderLifecycleTables(db);
 const row=await db.prepare("SELECT b.*,s.id session_id,s.programme_id,s.sequence_no,s.status session_status FROM canonical_bookings b JOIN training_sessions s ON s.booking_id=b.id WHERE s.id=? AND b.service_code='dog_training'").bind(input.sessionId).first<Row>();if(!row)throw new Response('Training session not found',{status:404});
 const chain=await db.prepare("SELECT * FROM training_assignment_chains WHERE booking_id=?").bind(row.id).first<Row>();if(!chain)throw conflict('Historical Training offer needs an explicit Operations reconciliation; no automatic replay');
 const o=await db.prepare("SELECT * FROM provider_assignment_offers WHERE group_id=?").bind(row.schedule_group_id).first<Row>();const now=Date.now();
 if(!o||o.status!=='pending'||o.provider_id!==input.providerId||Number(o.attempt_no)!==input.expectedAttemptNo||chain.state!=='pending'||chain.first_session_id!==input.sessionId)throw conflict('Training offer changed; refresh before responding');
 if(input.action==='timeout'&&Number(o.expires_at)>now&&Number(chain.ops_due_at)>now)throw conflict('Training offer has not expired');
 if(input.action==='decline'&&Number(o.expires_at)<=now)throw conflict('Training offer expired; Operations recovery is required');
 if(txt(input.reason).trim().length<3)throw new Response('Training response reason is required',{status:400});
 const sessions=await db.prepare("SELECT id,provider_id,status FROM training_sessions WHERE booking_id=? ORDER BY sequence_no").bind(row.id).all<Row>();
 if(sessions.results.some(s=>s.provider_id!==input.providerId||!['scheduled','locked'].includes(txt(s.status))))throw conflict('Training has already progressed; use session Operations recovery');
 const reservations=await db.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' ORDER BY occurrence_number").bind(row.schedule_group_id).all<Row>();if(!reservations.results.length||reservations.results.some(r=>r.provider_id!==input.providerId))throw conflict('Training reservation ownership changed');
 const request:DispatchRequest={...parse<Parameters<typeof repository>[1]>(chain.request_json),cityId:txt(row.city_id),zoneId:txt(row.zone_id),serviceCode:'dog_training'},policy=parse<Row>(chain.policy_json),excluded=[...parse<string[]>(chain.excluded_json),input.providerId],nextNo=Number(o.attempt_no)+1;
 let snapshots:Snapshot[]=[];
 let next:null|{id:string;name:string;model:string;travelBufferMinutes?:number;maxDailyJobs?:number}=null,reason='attempts_exhausted';
 if(now<Number(chain.ops_due_at)&&nextNo<=Number(chain.max_attempts)&&!(request.preferredProviderId&&policy.preferredProviderMode==='strict')){
  await repository(db,request).listEligibleProviders(request.cityId,request.zoneId,'dog_training');
  snapshots=await dispatchSnapshots(db,request);
  const decision=await schedule(repository(db,request),{...request,cityId:txt(row.city_id),zoneId:txt(row.zone_id),serviceCode:'dog_training',excludeProviderIds:excluded,customRules:await activeRules(db,request),parallelAppointments:await parallelAppointmentsFor(request),rankingWeights:policy as unknown as ScheduleRequest['rankingWeights'],preferredProviderMode:policy.preferredProviderMode as ScheduleRequest['preferredProviderMode']});next=decision.provider;reason=next?'':'no_eligible_trainer';
 }else if(now>=Number(chain.ops_due_at))reason='ops_deadline_elapsed';else if(request.preferredProviderId&&policy.preferredProviderMode==='strict')reason='selected_trainer_unavailable';
 let expiry=now;
 if(next?.model==='commission'){const ttl=await getProviderAcceptanceTimeout(db,next.id);if(!Number.isFinite(ttl)||ttl<=0){next=null;reason='acceptance_timeout_unconfigured';}else expiry=Math.min(now+ttl*60000,Number(chain.ops_due_at));}
 const result={bookingId:txt(row.id),state:next?(next.model==='full_time'?'assigned':'open'):'needs_operations',providerId:next?.id??null,attemptNo:next?nextNo:input.expectedAttemptNo,expiresAt:next?.model==='commission'?expiry:null,opsDueAt:Number(chain.ops_due_at),reason:reason||null,notificationStatus:'not_dispatched',externalDelivery:false,duplicatePrevented:false};
 const token=crypto.randomUUID(),guard=`EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND revision=? AND state='pending') AND EXISTS(SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id=? AND attempt_no=? AND status='pending' AND expires_at=? AND ${input.action==='decline'?"expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)":"expires_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)"}) AND NOT EXISTS(SELECT 1 FROM training_sessions WHERE booking_id=? AND (provider_id!=? OR status NOT IN ('scheduled','locked'))) AND EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND service_code='dog_training' AND provider_id=? AND status NOT IN ('cancelled','completed','refunded','failed','expired')) AND NOT EXISTS(SELECT 1 FROM provider_lifecycle_records WHERE booking_id=? AND service_code='dog_training' AND (status!='provider_matched' OR provider_id!=? OR lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))`;
 const binds=[row.id,chain.revision,row.schedule_group_id,input.providerId,input.expectedAttemptNo,o.expires_at,row.id,input.providerId,row.id,input.providerId,row.id,input.providerId];
 const statements:D1PreparedStatement[]=[db.prepare(`INSERT INTO training_assignment_assertions (id,ok) SELECT ?,CASE WHEN ${guard} THEN 1 ELSE 0 END`).bind(token,...binds),db.prepare("UPDATE training_assignment_attempts SET status=?,responded_at=?,reason=? WHERE booking_id=? AND attempt_no=? AND status='pending'").bind(input.action==='decline'?'declined':'expired',now,input.reason,row.id,input.expectedAttemptNo)];
 if(next){
  statements.push(db.prepare("INSERT INTO training_assignment_assertions (id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND ops_due_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) THEN 1 ELSE 0 END").bind(`${token}:deadline`,row.id));
  for(const [i,snapshot] of snapshots.entries())statements.push(db.prepare(`INSERT INTO training_assignment_assertions (id,ok) SELECT ?,CASE WHEN CAST((${snapshot.sql}) AS TEXT)=? THEN 1 ELSE 0 END`).bind(`${token}:source:${i}`,...snapshot.binds,snapshot.value));
  for(const r of reservations.results){
   statements.push(db.prepare("UPDATE scheduling_reservations SET provider_id=? WHERE id=? AND provider_id=? AND status!='cancelled'").bind(next.id,r.id,input.providerId));
   statements.push(db.prepare("INSERT INTO training_assignment_assertions (id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM scheduling_reservations WHERE id=? AND provider_id=? AND status!='cancelled') THEN 1 ELSE 0 END").bind(`${token}:${r.id}`,r.id,next.id));
  }
  statements.push(db.prepare("UPDATE provider_lifecycle_records SET provider_id=?,version=version+1,updated_by=?,updated_at=? WHERE booking_id=? AND service_code='dog_training' AND provider_id=? AND status='provider_matched'").bind(next.id,input.actorId,now,row.id,input.providerId));
  statements.push(db.prepare("UPDATE scheduling_assignment_decisions SET selected_provider_id=?,status='assigned',actor_id=?,reason='Training sequential reoffer',updated_at=? WHERE group_id=?").bind(next.id,input.actorId,now,row.schedule_group_id));
  statements.push(db.prepare("UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=? AND provider_id=?").bind(next.id,now,row.id,input.providerId),db.prepare("UPDATE provider_work_orders SET provider_id=?,provider_name=?,provider_model=?,updated_at=? WHERE booking_id=? AND provider_id=?").bind(next.id,next.name,next.model,now,row.id,input.providerId),db.prepare("UPDATE training_programmes SET provider_id=?,updated_at=? WHERE booking_id=? AND provider_id=?").bind(next.id,now,row.id,input.providerId),db.prepare("UPDATE training_sessions SET provider_id=?,updated_at=? WHERE booking_id=? AND provider_id=? AND status IN ('scheduled','locked')").bind(next.id,now,row.id,input.providerId));
  statements.push(db.prepare("UPDATE provider_assignment_offers SET provider_id=?,attempt_no=?,status=?,offered_at=?,expires_at=?,responded_at=NULL,response_reason=NULL,updated_at=? WHERE group_id=?").bind(next.id,nextNo,next.model==='commission'?'pending':'accepted',now,expiry,now,row.schedule_group_id),db.prepare("INSERT INTO training_assignment_attempts (booking_id,attempt_no,provider_id,status,offered_at,expires_at) VALUES (?,?,?,?,?,?)").bind(row.id,nextNo,next.id,next.model==='commission'?'pending':'accepted',now,expiry),db.prepare("INSERT INTO training_assignment_notifications (booking_id,attempt_no,provider_id,created_at) VALUES (?,?,?,?)").bind(row.id,nextNo,next.id,now));
 }else statements.push(db.prepare("UPDATE provider_assignment_offers SET status='expired',responded_at=?,response_reason=?,updated_at=? WHERE group_id=?").bind(now,reason,now,row.schedule_group_id),db.prepare("INSERT OR IGNORE INTO training_assignment_ops_cases (booking_id,reason,due_at,created_at) VALUES (?,?,?,?)").bind(row.id,reason,chain.ops_due_at,now),db.prepare("INSERT OR IGNORE INTO training_session_recovery_cases (id,session_id,programme_id,booking_id,recovery_type,status,reason,requested_by,detail_json,created_at,updated_at) VALUES (?,?,?,?,'assignment_recovery','open',?,?,?, ?,?)").bind(`training-assignment-ops:${row.id}`,row.session_id,row.programme_id,row.id,reason,input.actorId,JSON.stringify({opsDueAt:Number(chain.ops_due_at),attemptNo:input.expectedAttemptNo,externalDelivery:false}),now,now));
 statements.push(db.prepare("UPDATE training_assignment_chains SET revision=revision+1,excluded_json=?,state=? WHERE booking_id=? AND revision=?").bind(JSON.stringify(excluded),next?(next.model==='commission'?'pending':'assigned'):'needs_operations',row.id,chain.revision),db.prepare("INSERT INTO training_assignment_responses (idempotency_key,fingerprint,result_json,actor_id,created_at) VALUES (?,?,?,?,?)").bind(input.idempotencyKey,fingerprint,JSON.stringify(result),input.actorId,now),db.prepare("DELETE FROM training_assignment_assertions WHERE id=? OR id LIKE ?").bind(token,`${token}:%`));
 try{await db.batch(statements);}catch(error){const replay=await db.prepare("SELECT fingerprint,result_json FROM training_assignment_responses WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(replay&&replay.fingerprint===fingerprint)return{...parse<Row>(replay.result_json),duplicatePrevented:true};if(error instanceof Error&&/constraint/i.test(error.message))throw conflict('Training assignment changed or replacement capacity was taken; no partial reassignment');throw error;}
 return result;
}
export async function runTrainingOfferExpirySweep(db:D1Database){
 // No historical sweep or schema creation in an unrelated/legacy database.
 if(!await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='training_assignment_chains'").first())return{scanned:0,results:[],externalDelivery:false};
 const broadcasts=await expireTrainingBroadcasts(db);
 await ensureTrainingDispatchTables(db);const now=Date.now(),rows=await db.prepare("SELECT c.first_session_id,o.provider_id,o.attempt_no FROM training_assignment_chains c JOIN provider_assignment_offers o ON o.group_id=c.group_id WHERE c.state='pending' AND o.status='pending' AND (o.expires_at<=? OR c.ops_due_at<=?) ORDER BY o.expires_at LIMIT 20").bind(now,now).all<Row>();const results:unknown[]=[];for(const r of rows.results){try{results.push(await respondTrainingOffer(db,{sessionId:txt(r.first_session_id),providerId:txt(r.provider_id),expectedAttemptNo:Number(r.attempt_no),action:'timeout',reason:'Training offer deadline expired',actorId:'system:training-offers',idempotencyKey:`training-expiry:${r.first_session_id}:${r.attempt_no}`}));}catch(error){if(error instanceof Response&&error.status===409)results.push({state:'conflict',status:409});else throw error;}}return{scanned:rows.results.length+broadcasts.length,results:[...broadcasts,...results],externalDelivery:false};}
