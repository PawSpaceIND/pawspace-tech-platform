import {trainingRollingBalanceStatements} from './training-rolling-balance';
import {governedJsonError} from './governed-http-error';
import {repository,activeRules} from '../app/api/uat-scheduling/route';
import {schedule,cityOffsetMinutes,type ScheduleRequest} from '../backend/src/scheduling';
import type {Booking} from '../backend/src/domain';
import {ensureTrainingProgrammeTables} from './training-programme';
import {seedProviderCapacityDefaults} from './provider-capacity-governance';
import {ensureTrainingDispatchTables} from './training-assignment-dispatch';
import {ensureTrainingWorkflowNotificationTables,trainingWorkflowNotificationStatements} from './training-workflow-notifications';
import {trainingPaymentPredicate} from './training-payment-eligibility';
import {canCustomerRescheduleTraining} from './training-customer-change-window';

type Row=Record<string,unknown>;
export type RollingSlot={start:string;end:string};
export type RollingAction='hold'|'confirm'|'propose_change'|'accept_change'|'reject_change';
export type RollingMutation={bookingId:string;actorKind:'customer'|'provider';actorId:string;subjectId:string;action:RollingAction;idempotencyKey:string;slots?:RollingSlot[];holdId?:string;sessionId?:string;changeId?:string;reason?:string};
const HOLD_MS=5*60_000,CHANGE_MS=24*60*60_000;
const inactive="'cancelled','refunded','failed','expired','completed'";
const liveStates="'scheduled','locked','accepted','on_the_way','arrived','in_session','reschedule_requested'";
const realNowSql="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value)) as T;}catch{return fallback;}};
const text=(value:unknown)=>String(value??'');
const fail=(message:string,status=409)=>governedJsonError({error:message},status);
type Snapshot={sql:string;binds:unknown[];value:string};

export async function ensureTrainingRollingScheduleTables(db:D1Database){
 await ensureTrainingProgrammeTables(db);await ensureTrainingDispatchTables(db);await seedProviderCapacityDefaults(db);await ensureTrainingWorkflowNotificationTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL DEFAULT 100,condition_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS training_rolling_alert_checks (programme_id TEXT PRIMARY KEY,last_checked_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS training_rolling_holds (id TEXT PRIMARY KEY,programme_id TEXT NOT NULL,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,slots_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'held',expires_at INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_training_rolling_holds_provider ON training_rolling_holds(provider_id,status,expires_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS training_rolling_changes (id TEXT PRIMARY KEY,programme_id TEXT NOT NULL,booking_id TEXT NOT NULL,session_id TEXT NOT NULL,provider_id TEXT NOT NULL,proposed_by TEXT NOT NULL,proposer_id TEXT NOT NULL,original_start TEXT NOT NULL,original_end TEXT NOT NULL,new_start TEXT NOT NULL,new_end TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,decided_at INTEGER,decided_by TEXT)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_training_rolling_changes_session ON training_rolling_changes(session_id,status,expires_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS training_rolling_actions (idempotency_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS training_rolling_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))"),
 ]);
}
async function context(db:D1Database,bookingId:string){
 await ensureTrainingRollingScheduleTables(db);
 const row=await db.prepare("SELECT p.*,b.schedule_group_id,b.pet_ids_json booking_pet_ids_json,b.status booking_status,b.provider_id booking_provider_id,b.updated_at booking_updated_at,e.package_version,e.total_sessions entitlement_total,e.valid_from,e.valid_until,e.minutes_per_session,e.max_upcoming_sessions,e.scheduling_mode FROM training_programmes p JOIN canonical_bookings b ON b.id=p.booking_id JOIN training_programme_entitlements e ON e.programme_id=p.id AND e.booking_id=b.id WHERE b.id=? AND b.service_code='dog_training'").bind(bookingId).first<Row>();
 if(!row||row.scheduling_mode!=='rolling_v1')throw fail('This booking has no opted-in rolling Training entitlement');return row;
}
function active(row:Row){
 if(['cancelled','refunded','failed','expired','completed'].includes(text(row.booking_status))||['completed','completed_with_exceptions','cancelled'].includes(text(row.status)))throw fail('This Training programme is inactive');
 if(text(row.provider_id)!==text(row.booking_provider_id))throw fail('Training assignment changed; Operations must reconcile ownership');
 if(Date.parse(text(row.valid_until))<=Date.now())throw fail('Training package validity has expired');
}
function normalizeSlots(slots:RollingSlot[]|undefined,row:Row,maximum:number){
 if(!Array.isArray(slots)||slots.length<1||slots.length>maximum)throw fail(`Choose between one and ${maximum} Training slots`,400);
 const from=Date.parse(text(row.valid_from)),until=Date.parse(text(row.valid_until)),duration=Number(row.minutes_per_session)*60_000;
 if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from||!Number.isFinite(duration)||duration<60*60_000)throw fail('Training entitlement duration or validity is invalid');
 const result=slots.map(slot=>{const start=Date.parse(text(slot?.start)),end=Date.parse(text(slot?.end));if(!Number.isFinite(start)||!Number.isFinite(end)||start<=Date.now()||start<from||end>until||end-start!==duration)throw fail('Training slots must be future appointments of the purchased duration within package validity',400);return{start:new Date(start).toISOString(),end:new Date(end).toISOString()};}).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
 for(let i=1;i<result.length;i++)if(result[i].start<result[i-1].end)throw fail('Training slots overlap',400);return result;
}
function assertIdentity(row:Row,input:RollingMutation,providerId=text(row.provider_id)){
 const expected=input.actorKind==='customer'?text(row.customer_id):providerId;if(!input.subjectId||input.subjectId!==expected)throw fail('Training schedule ownership denied',403);
}
const liveHoldsSql=`SELECT h.* FROM training_rolling_holds h JOIN canonical_bookings b ON b.id=h.booking_id JOIN training_programmes p ON p.id=h.programme_id WHERE h.status='held' AND h.expires_at>${realNowSql} AND b.status NOT IN (${inactive}) AND p.status NOT IN ('completed','completed_with_exceptions','cancelled')`;
async function heldRows(db:D1Database,providerId:string,excludeHold?:string){return(await db.prepare(`${liveHoldsSql} AND h.provider_id=? AND h.id<>?`).bind(providerId,excludeHold??'').all<Row>()).results;}
function holdBookings(holds:Row[]):Booking[]{return holds.flatMap(h=>parse<RollingSlot[]>(h.slots_json,[]).map((slot,i)=>({id:`${h.id}:${i}`,legacyIds:[],idempotencyKey:`${h.id}:${i}`,cityId:'',zoneId:'',customerId:text(h.customer_id),petIds:[],serviceCode:'dog_training',packageCode:'rolling_hold',addonCodes:[],scheduledStart:slot.start,scheduledEnd:slot.end,status:'assigned',channel:'customer_app',totalAmount:0,providerId:text(h.provider_id),assignmentMode:'automatic',scheduleGroupId:text(h.id),occurrenceNumber:i+1,capacityUnits:1,createdBy:text(h.created_by),createdAt:new Date(Number(h.created_at)).toISOString(),updatedAt:new Date(Number(h.created_at)).toISOString()})));}
async function capacity(db:D1Database,row:Row,slots:RollingSlot[],excludeReservation?:string,excludeHold?:string){
 const held=holdBookings(await heldRows(db,text(row.provider_id),excludeHold)),extra:Booking[]=[];
 const address=await db.prepare('SELECT latitude,longitude FROM booking_service_addresses WHERE booking_id=?').bind(row.booking_id).first<Row>();
 for(const slot of slots){
  const request:ScheduleRequest={cityId:text(row.city_id),zoneId:text(row.zone_id),serviceCode:'dog_training',petIds:parse<string[]>(row.booking_pet_ids_json,[]),scheduledStart:slot.start,scheduledEnd:slot.end,preferredProviderId:text(row.provider_id),preferredProviderMode:'strict',occurrences:1};
  const decisionTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_assignment_decisions'").first();
  const saved=decisionTable?await db.prepare('SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?').bind(row.schedule_group_id).first<Row>():null;
  const original=parse<{request?:{serviceRadiusKm?:number}}>(saved?.shortlist_json,{}).request;
  if(original?.serviceRadiusKm!=null){
   const latitude=Number(address?.latitude),longitude=Number(address?.longitude),radius=Number(original.serviceRadiusKm);
   if(address?.latitude==null||address?.longitude==null||!Number.isFinite(latitude)||latitude<-90||latitude>90||!Number.isFinite(longitude)||longitude<-180||longitude>180||!Number.isFinite(radius)||radius<=0)throw fail('The saved Training service radius requires a valid canonical doorstep location');
   request.latitude=latitude;request.longitude=longitude;request.serviceRadiusKm=radius;
  }
  const requestBody={...request,customerId:text(row.customer_id),clientRequestId:'training-rolling-check'};request.customRules=await activeRules(db,requestBody);
  const repo=repository(db,requestBody),base=repo.listBookings.bind(repo);repo.listBookings=async(cityId,providerId)=>(await base(cityId,providerId)).filter(b=>b.id!==excludeReservation).concat(held,extra);
  const decision=await schedule(repo,request);if(!decision.provider||decision.provider.id!==text(row.provider_id))throw fail('Assigned trainer has no eligible roster or available capacity for this Training slot');
  extra.push(...holdBookings([{id:`temporary-${extra.length}`,provider_id:row.provider_id,customer_id:row.customer_id,created_by:'capacity-check',created_at:Date.now(),slots_json:JSON.stringify([slot])}]));
 }
}
async function sourceSnapshots(db:D1Database,row:Row):Promise<Snapshot[]>{
 const present=new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<Row>()).results.map(r=>text(r.name)));
 const profile=await db.prepare('SELECT travel_buffer_minutes FROM provider_capacity_profiles WHERE id=?').bind(row.provider_id).first<Row>();
 const margin=Math.max(86400000,Number(profile?.travel_buffer_minutes||0)*60000),from=new Date(Date.parse(text(row.valid_from))-margin).toISOString(),to=new Date(Date.parse(text(row.valid_until))+margin).toISOString();
 const linked=present.has('provider_people_links'),employees=linked?'SELECT employee_id FROM provider_people_links WHERE provider_id=?':'SELECT NULL WHERE 0';
 const definitions:[string,string,unknown[]][]=[
  ['provider_capacity_profiles','id=?',[row.provider_id]],
  ['scheduling_availability','provider_id=? AND date>=? AND date<=?',[row.provider_id,from.slice(0,10),to.slice(0,10)]],
  ['provider_unavailability','provider_id=?',[row.provider_id]],['provider_home_base','provider_id=?',[row.provider_id]],
  ['scheduling_reservations',"provider_id=? AND status!='cancelled' AND (julianday(scheduled_start) IS NULL OR julianday(scheduled_end) IS NULL OR (julianday(scheduled_start)<=julianday(?) AND julianday(scheduled_end)>=julianday(?)))",[row.provider_id,to,from]],
  ['training_rolling_holds',`provider_id=? AND status='held' AND expires_at>${realNowSql} AND EXISTS (SELECT 1 FROM canonical_bookings b JOIN training_programmes p ON p.booking_id=b.id WHERE b.id=training_rolling_holds.booking_id AND p.id=training_rolling_holds.programme_id AND b.status NOT IN (${inactive}) AND p.status NOT IN ('completed','completed_with_exceptions','cancelled'))`,[row.provider_id]],
  ['scheduling_rules',"(service_code IS NULL OR service_code='dog_training') AND (city_id IS NULL OR city_id=?) AND (zone_id IS NULL OR zone_id=?)",[row.city_id,row.zone_id]],
  ['provider_onboarding_applications','provider_id=?',[row.provider_id]],
  ['provider_verifications',present.has('provider_onboarding_applications')?'application_id IN (SELECT id FROM provider_onboarding_applications WHERE provider_id=?)':'0',present.has('provider_onboarding_applications')?[row.provider_id]:[]],
  ['service_policy_configs',"policy_domain='provider_verification_policy'",[]],['provider_people_links','provider_id=?',[row.provider_id]],
  ['employees',`id IN (${employees})`,linked?[row.provider_id]:[]],['leave_requests',`employee_id IN (${employees})`,linked?[row.provider_id]:[]],['employee_shift_assignments',`employee_id IN (${employees})`,linked?[row.provider_id]:[]],
  ['shift_policies',linked&&present.has('employee_shift_assignments')?`id IN (SELECT shift_policy_id FROM employee_shift_assignments WHERE employee_id IN (${employees}))`:'0',linked&&present.has('employee_shift_assignments')?[row.provider_id]:[]],
  ['canonical_pets','customer_id=?',[row.customer_id]],['booking_service_addresses','booking_id=?',[row.booking_id]],['scheduling_assignment_decisions','group_id=?',[row.schedule_group_id]],
  ['payment_reconciliation_records','booking_id=?',[row.booking_id]],['pawspace_wallet_ledger','source_id=?',[row.booking_id]],['paw_points_ledger','booking_id=?',[row.booking_id]],['review_reward_codes','redeemed_booking_id=?',[row.booking_id]],
 ];
 const snapshots:Snapshot[]=[];
 for(const[table,where,binds]of definitions){const columns=await db.prepare(`PRAGMA table_info(${table})`).all<Row>();if(!columns.results.length){snapshots.push({sql:"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",binds:[table],value:'0'});continue;}
  const expression=columns.results.map(c=>`quote("${text(c.name).replaceAll('"','""')}")`).join("||'|'||"),sql=`SELECT COALESCE(group_concat(value,char(10)),'') value FROM (SELECT ${expression} value FROM ${table} WHERE ${where} ORDER BY value)`;
  const result=await db.prepare(sql).bind(...binds).first<Row>();snapshots.push({sql,binds,value:text(result?.value)});
 }return snapshots;
}
function guard(db:D1Database,token:string,predicate:string,binds:unknown[]){return db.prepare(`INSERT INTO training_rolling_assertions (id,ok) SELECT ?,CASE WHEN ${predicate} THEN 1 ELSE 0 END`).bind(token,...binds);}
async function assignmentPredicate(db:D1Database,row:Row){
 const sql="EXISTS (SELECT 1 FROM provider_capacity_profiles p WHERE p.id=? AND (p.provider_model='full_time' OR EXISTS (SELECT 1 FROM provider_assignment_offers o WHERE o.group_id=? AND o.provider_id=p.id AND o.status='accepted'))) AND NOT EXISTS (SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND (provider_id<>? OR status<>'accepted')) AND NOT EXISTS (SELECT 1 FROM training_assignment_chains WHERE booking_id=? AND state NOT IN ('accepted','assigned'))";
 const binds=[row.provider_id,row.schedule_group_id,row.schedule_group_id,row.provider_id,row.booking_id];if(!await db.prepare(`SELECT 1 ok WHERE ${sql}`).bind(...binds).first())throw fail('The assigned trainer must accept before future Training appointments can be held');return{sql,binds};
}
function programmePredicate(row:Row){return{sql:`EXISTS (SELECT 1 FROM training_programmes p JOIN canonical_bookings b ON b.id=p.booking_id JOIN training_programme_entitlements e ON e.programme_id=p.id AND e.booking_id=b.id WHERE p.id=? AND b.id=? AND b.service_code='dog_training' AND p.customer_id=? AND b.customer_id=p.customer_id AND p.provider_id=? AND b.provider_id=p.provider_id AND b.status NOT IN (${inactive}) AND p.status NOT IN ('completed','completed_with_exceptions','cancelled') AND e.scheduling_mode='rolling_v1' AND e.package_version=? AND e.total_sessions=? AND e.valid_from=? AND e.valid_until=? AND e.minutes_per_session=? AND e.max_upcoming_sessions=? AND julianday(e.valid_until)>julianday('now'))`,binds:[row.id,row.booking_id,row.customer_id,row.provider_id,row.package_version,row.entitlement_total,row.valid_from,row.valid_until,row.minutes_per_session,row.max_upcoming_sessions]};}
async function mutationGuards(db:D1Database,row:Row,token:string,snapshots:Snapshot[],checkPayment=true){
 const programme=programmePredicate(row),assignment=await assignmentPredicate(db,row),result=[guard(db,`${token}:programme`,programme.sql,programme.binds),guard(db,`${token}:assignment`,assignment.sql,assignment.binds)];
 if(checkPayment){const payment=await trainingPaymentPredicate(db,text(row.booking_id),false);if(!await db.prepare(`SELECT 1 ok WHERE ${payment.sql}`).bind(...payment.binds).first())throw fail('Required Training payment has not been completed');result.push(guard(db,`${token}:payment`,payment.sql,payment.binds));}
 for(const[i,snapshot]of snapshots.entries())result.push(guard(db,`${token}:source:${i}`,`CAST((${snapshot.sql}) AS TEXT)=?`,[...snapshot.binds,snapshot.value]));return result;
}
async function counts(db:D1Database,row:Row,excludeHold=''){
 const sessions=(await db.prepare(`SELECT COUNT(*) n,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) consumed,SUM(CASE WHEN status IN (${liveStates}) THEN 1 ELSE 0 END) upcoming FROM training_sessions WHERE programme_id=? AND status!='cancelled'`).bind(row.id).first<Row>())!;
 const holds=await db.prepare(`SELECT COALESCE(SUM(json_array_length(h.slots_json)),0) n FROM (${liveHoldsSql}) h WHERE h.programme_id=? AND h.id<>?`).bind(row.id,excludeHold).first<Row>();return{allocated:Number(sessions.n||0),consumed:Number(sessions.consumed||0),upcoming:Number(sessions.upcoming||0),held:Number(holds?.n||0)};
}
function entitlementGuard(db:D1Database,row:Row,token:string,size:number,excludeHold=''){
 const held=`COALESCE((SELECT SUM(json_array_length(h.slots_json)) FROM (${liveHoldsSql}) h WHERE h.programme_id=? AND h.id<>?),0)`;
 return guard(db,`${token}:entitlement`, `(SELECT COUNT(*) FROM training_sessions WHERE programme_id=? AND status!='cancelled')+${held}+?<=? AND (SELECT COUNT(*) FROM training_sessions WHERE programme_id=? AND status IN (${liveStates}))+${held}+?<=?`,[row.id,row.id,excludeHold,size,row.entitlement_total,row.id,row.id,excludeHold,size,Math.min(3,Number(row.max_upcoming_sessions))]);
}
function alertStatement(db:D1Database,row:Row,key:string,title:string,body:string){const now=Date.now(),id=`rolling-alert:${row.id}:${key}`;return db.prepare("INSERT OR IGNORE INTO staff_alerts (id,idempotency_key,alert_type,severity,status,source_type,source_id,title,body,team_code,recipient_role,customer_id,booking_id,due_at,created_at,updated_at) VALUES (?,?,'training_rolling_review','high','open','training_programme',?,?,?,'operations','manager',?,?,?,?,?)").bind(id,id,row.id,title,body,row.customer_id,row.booking_id,now,now,now);}
export async function refreshTrainingRollingAlerts(db:D1Database,bookingId:string){
 const row=await context(db,bookingId),state=await counts(db,row),statements:D1PreparedStatement[]=[];
 if(!['cancelled','completed','completed_with_exceptions'].includes(text(row.status))&&!['cancelled','refunded','failed','expired','completed'].includes(text(row.booking_status))&&state.consumed<Number(row.entitlement_total)){
  if((await db.prepare("SELECT COUNT(*) n FROM training_sessions WHERE programme_id=? AND status='no_show'").bind(row.id).first<Row>())?.n)statements.push(alertStatement(db,row,'no-show','Training no-show review','A missed Training appointment remains allocated pending Operations/Finance policy review. No replacement entitlement is granted automatically.'));
  if(state.upcoming===0&&state.held===0)statements.push(alertStatement(db,row,'no-schedule','Training appointment required','The package has unused sessions and no upcoming appointment. Operations should help the customer schedule within validity.'));
  if(Date.parse(text(row.valid_until))-Date.now()<=7*86400000)statements.push(alertStatement(db,row,'validity','Training validity review','Training entitlement approaches or has reached expiry with unused sessions; no validity extension is approved by this alert.'));
 }if(statements.length)await db.batch(statements);return{createdChecks:statements.length,externalDelivery:false};
}
async function checkedSnapshots(db:D1Database,row:Row,slots:RollingSlot[],excludeReservation?:string,excludeHold?:string){
 // Lazy governance initialization precedes the snapshot. The final eligibility read is checked
 // against this snapshot inside the same transaction as the appointment mutation.
 await capacity(db,row,slots,excludeReservation,excludeHold);const snapshots=await sourceSnapshots(db,row);await capacity(db,row,slots,excludeReservation,excludeHold);return snapshots;
}
async function availability(db:D1Database,row:Row){
 const from=new Date(Math.max(Date.now(),Date.parse(text(row.valid_from)))).toISOString(),to=new Date(Math.min(Date.parse(text(row.valid_until)),Date.parse(from)+14*86400000)).toISOString(),offset=cityOffsetMinutes(text(row.city_id))*60_000;
 const localDay=(iso:string)=>new Date(Date.parse(iso)+offset).toISOString().slice(0,10),roster=await db.prepare("SELECT date,windows_json FROM scheduling_availability WHERE provider_id=? AND city_id=? AND zone_id=? AND date>=? AND date<=? AND source IN ('partner_app','operations','roster') ORDER BY date,id LIMIT 32").bind(row.provider_id,row.city_id,row.zone_id,localDay(from),localDay(to)).all<Row>();
 const candidates:RollingSlot[]=[],seen=new Set<string>(),duration=Number(row.minutes_per_session)*60_000;
 for(const day of roster.results)for(const window of parse<string[]>(day.windows_json,[])){const match=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);if(!match)continue;const open=(Number(match[1])*60+Number(match[2]))*60_000,close=(Number(match[3])*60+Number(match[4]))*60_000;if(open<0||close>86400000||close<=open)continue;
  const base=Date.parse(`${day.date}T00:00:00.000Z`)-offset;for(let start=base+open;start+duration<=base+close&&candidates.length<48;start+=30*60_000){const slot={start:new Date(start).toISOString(),end:new Date(start+duration).toISOString()};if(start<=Date.now()||start<Date.parse(from)||start+duration>Date.parse(to)||seen.has(slot.start))continue;seen.add(slot.start);candidates.push(slot);}
 }
 const slots:RollingSlot[]=[];for(const slot of candidates){try{await capacity(db,row,[slot]);slots.push(slot);}catch(error){if(!(error instanceof Response)||error.status!==409)throw error;}if(slots.length>=30)break;}return{availableSlots:slots,availabilityWindow:{from,to,bounded:true,checkedCandidates:candidates.length}};
}
export async function rollingScheduleSummary(db:D1Database,bookingId:string){
 const row=await context(db,bookingId),state=await counts(db,row),upcomingSessions=(await db.prepare(`SELECT id,provider_id,status,scheduled_start,scheduled_end FROM training_sessions WHERE programme_id=? AND status IN (${liveStates}) ORDER BY scheduled_start,sequence_no`).bind(row.id).all<Row>()).results;
 const holds=(await db.prepare(`${liveHoldsSql} AND h.programme_id=? ORDER BY h.created_at,h.id`).bind(row.id).all<Row>()).results.map(h=>({id:text(h.id),slots:parse<RollingSlot[]>(h.slots_json,[]),expiresAt:Number(h.expires_at)}));
 const changes=(await db.prepare(`SELECT * FROM training_rolling_changes WHERE programme_id=? AND status='proposed' AND expires_at>${realNowSql} ORDER BY created_at,id`).bind(row.id).all<Row>()).results.map(c=>({id:text(c.id),sessionId:text(c.session_id),proposedBy:text(c.proposed_by),start:text(c.new_start),end:text(c.new_end),status:'pending',expiresAt:Number(c.expires_at)}));
 let canSchedule=true;try{active(row);await assignmentPredicate(db,row);const pay=await trainingPaymentPredicate(db,bookingId,false);if(!await db.prepare(`SELECT 1 ok WHERE ${pay.sql}`).bind(...pay.binds).first())canSchedule=false;}catch(error){if(error instanceof Response)canSchedule=false;else throw error;}
 const eligible=canSchedule;canSchedule=canSchedule&&state.upcoming+state.held<Math.min(3,Number(row.max_upcoming_sessions))&&state.allocated+state.held<Number(row.entitlement_total);
 const available=eligible?await availability(db,row):{availableSlots:[] as RollingSlot[],availabilityWindow:{from:new Date().toISOString(),to:text(row.valid_until),bounded:true,checkedCandidates:0}},pendingNoShowSessions=Number((await db.prepare("SELECT COUNT(*) n FROM training_sessions WHERE programme_id=? AND status='no_show'").bind(row.id).first<Row>())?.n||0);
 return{pendingNoShowSessions,noShowRecovery:pendingNoShowSessions>0?'operations_finance_review_required':null,bookingId,programmeId:text(row.id),schedulingMode:'rolling_v1',providerId:text(row.provider_id),totalSessions:Number(row.entitlement_total),consumedSessions:state.consumed,remainingSessions:Math.max(0,Number(row.entitlement_total)-state.consumed),remainingUnallocatedSessions:Math.max(0,Number(row.entitlement_total)-state.allocated-state.held),validFrom:text(row.valid_from),validUntil:text(row.valid_until),minutesPerSession:Number(row.minutes_per_session),maxUpcomingSessions:Math.min(3,Number(row.max_upcoming_sessions)),upcomingSessions,holds,changes,...available,canSchedule,externalDelivery:false};
}
async function sessionContext(db:D1Database,row:Row,sessionId:string){const session=await db.prepare('SELECT * FROM training_sessions WHERE id=? AND programme_id=? AND booking_id=?').bind(sessionId,row.id,row.booking_id).first<Row>();if(!session)throw fail('Owned Training appointment not found',404);if(!['scheduled','accepted','locked'].includes(text(session.status)))throw fail('Only an unstarted scheduled, accepted or locked Training appointment may be mutually rescheduled');return session;}
function sessionGuard(db:D1Database,token:string,session:Row){return guard(db,`${token}:session`,"EXISTS (SELECT 1 FROM training_sessions WHERE id=? AND programme_id=? AND booking_id=? AND provider_id=? AND status=? AND scheduled_start=? AND scheduled_end=?) AND EXISTS (SELECT 1 FROM scheduling_reservations WHERE id=? AND provider_id=? AND scheduled_start=? AND scheduled_end=? AND status IN ('assigned','confirmed'))",[session.id,session.programme_id,session.booking_id,session.provider_id,session.status,session.scheduled_start,session.scheduled_end,session.schedule_reservation_id,session.provider_id,session.scheduled_start,session.scheduled_end]);}
function changeWindow(db:D1Database,token:string,input:RollingMutation,session:Row){if(input.actorKind!=='customer')return[];if(!canCustomerRescheduleTraining(session.scheduled_start))throw fail('Customer Training changes require at least 24 hours before the current appointment');return[guard(db,`${token}:change-window`,"julianday(?)>=julianday('now','+24 hours')",[session.scheduled_start])];}

export async function mutateTrainingRollingSchedule(db:D1Database,input:RollingMutation){
 if(!input.bookingId||!input.actorId||!input.subjectId||!input.idempotencyKey||input.idempotencyKey.length>160||!['customer','provider'].includes(input.actorKind)||!['hold','confirm','propose_change','accept_change','reject_change'].includes(input.action))throw fail('A valid owned Training action and bounded idempotency key are required',400);
 const row=await context(db,input.bookingId),fingerprint=JSON.stringify({bookingId:input.bookingId,actorKind:input.actorKind,actorId:input.actorId,subjectId:input.subjectId,action:input.action,slots:input.slots??null,holdId:input.holdId??null,sessionId:input.sessionId??null,changeId:input.changeId??null,reason:input.reason??null});
 const prior=await db.prepare('SELECT fingerprint,result_json FROM training_rolling_actions WHERE idempotency_key=?').bind(input.idempotencyKey).first<Row>();
 if(prior){if(prior.fingerprint!==fingerprint)throw fail('Training schedule replay payload or scope changed');let replayProvider=text(row.provider_id);
  if(input.actorKind==='provider'&&['propose_change','accept_change','reject_change'].includes(input.action)){const ownedSession=await db.prepare('SELECT provider_id FROM training_sessions WHERE programme_id=? AND booking_id=? AND (id=? OR id=(SELECT session_id FROM training_rolling_changes WHERE id=? AND programme_id=?))').bind(row.id,row.booking_id,input.sessionId??'',input.changeId??'',row.id).first<Row>();if(!ownedSession)throw fail('Owned Training appointment not found',404);replayProvider=text(ownedSession.provider_id);}
  assertIdentity(row,input,replayProvider);return{...parse<Row>(prior.result_json,{}),duplicatePrevented:true};
 }
 active(row);const token=crypto.randomUUID(),now=Date.now();let result:Row;const statements:D1PreparedStatement[]=[];
 try{
  if(input.action==='hold'||input.action==='confirm'){
   assertIdentity(row,input);if(input.actorKind!=='customer')throw fail('Only the owned customer can reserve new Training appointments',403);
   let hold:Row|null=null;if(input.action==='confirm'){if(!input.holdId)throw fail('Training hold ID is required',400);hold=await db.prepare("SELECT * FROM training_rolling_holds WHERE id=? AND programme_id=? AND booking_id=? AND customer_id=? AND provider_id=? AND status='held' AND expires_at>?").bind(input.holdId,row.id,row.booking_id,row.customer_id,row.provider_id,now).first<Row>();if(!hold)throw fail('Training hold is missing, expired or no longer owned');if(input.slots)throw fail('Confirm the held payload without replacing its slots',400);}
   const slots=normalizeSlots(hold?parse<RollingSlot[]>(hold.slots_json,[]):input.slots,row,3),snapshots=await checkedSnapshots(db,row,slots,undefined,hold?text(hold.id):undefined);
   statements.push(...await mutationGuards(db,row,token,snapshots),entitlementGuard(db,row,token,slots.length,hold?text(hold.id):''));
   if(!hold){const holdId=`TRH-${crypto.randomUUID()}`,expiresAt=now+HOLD_MS;statements.push(db.prepare("INSERT INTO training_rolling_holds (id,programme_id,booking_id,customer_id,provider_id,slots_json,status,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,'held',?,?,?)").bind(holdId,row.id,row.booking_id,row.customer_id,row.provider_id,JSON.stringify(slots),expiresAt,input.actorId,now));result={action:input.action,holdId,expiresAt,slots,status:'held',externalDelivery:false};}
   else{
    statements.push(guard(db,`${token}:hold`, `EXISTS (SELECT 1 FROM training_rolling_holds WHERE id=? AND programme_id=? AND customer_id=? AND provider_id=? AND slots_json=? AND status='held' AND expires_at>${realNowSql})`,[hold.id,row.id,row.customer_id,row.provider_id,hold.slots_json]));
    const sequence=Number((await db.prepare('SELECT COALESCE(MAX(sequence_no),0) maximum FROM training_sessions WHERE programme_id=?').bind(row.id).first<Row>())?.maximum||0),pending=Number((await db.prepare(`SELECT COUNT(*) n FROM training_sessions WHERE programme_id=? AND status IN (${liveStates})`).bind(row.id).first<Row>())?.n||0),sessionIds:string[]=[];
    for(const[index,slot]of slots.entries()){const reservationId=`TRR-${crypto.randomUUID()}`,sessionId=`TS-${crypto.randomUUID()}`,number=sequence+index+1;sessionIds.push(sessionId);
     statements.push(db.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,status,explanation_json,created_at) VALUES (?,?,?,'dog_training',?,?,?,?,?,?,1,?,'assigned',?,?)").bind(reservationId,row.schedule_group_id,row.provider_id,row.city_id,row.zone_id,row.customer_id,row.booking_pet_ids_json,slot.start,slot.end,number,JSON.stringify({schedulingMode:'rolling_v1',holdId:hold.id}),now),db.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(sessionId,row.id,row.booking_id,reservationId,number,row.provider_id,slot.start,slot.end,pending===0&&index===0?'scheduled':'locked',now,now));
    }
    statements.push(db.prepare("UPDATE training_rolling_holds SET status='confirmed',confirmed_at=? WHERE id=? AND status='held'").bind(now,hold.id),...trainingWorkflowNotificationStatements(db,{key:`rolling:${input.idempotencyKey}`,bookingId:input.bookingId,customerId:text(row.customer_id),providerId:text(row.provider_id),event:'rolling_appointments_confirmed',sourceId:text(hold.id),actorId:input.actorId,now}));
    result={action:input.action,holdId:hold.id,status:'confirmed',sessionIds,slots,externalDelivery:false};
   }
  }else{
   const proposal=input.changeId?await db.prepare('SELECT * FROM training_rolling_changes WHERE id=? AND programme_id=? AND booking_id=?').bind(input.changeId,row.id,row.booking_id).first<Row>():null,session=await sessionContext(db,row,input.action==='propose_change'?text(input.sessionId):text(proposal?.session_id));
   assertIdentity(row,input,text(session.provider_id));statements.push(sessionGuard(db,token,session));const providerRow={...row,provider_id:session.provider_id};
   if(input.action==='propose_change'){
    if(text(input.reason).trim().length<8)throw fail('A clear Training change reason is required',400);const slots=normalizeSlots(input.slots,row,1);if(slots[0].start===session.scheduled_start&&slots[0].end===session.scheduled_end)throw fail('Propose a different Training appointment',400);
    statements.push(...changeWindow(db,token,input,session));const snapshots=await checkedSnapshots(db,providerRow,slots,text(session.schedule_reservation_id));
    statements.push(...await mutationGuards(db,row,token,snapshots),guard(db,`${token}:open-change`, `NOT EXISTS (SELECT 1 FROM training_rolling_changes WHERE session_id=? AND status='proposed' AND expires_at>${realNowSql})`,[session.id]));
    const changeId=`TRC-${crypto.randomUUID()}`,expiresAt=Math.min(now+CHANGE_MS,Date.parse(text(session.scheduled_start)));
    statements.push(db.prepare("INSERT INTO training_rolling_changes (id,programme_id,booking_id,session_id,provider_id,proposed_by,proposer_id,original_start,original_end,new_start,new_end,reason,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?)").bind(changeId,row.id,row.booking_id,session.id,session.provider_id,input.actorKind,input.subjectId,session.scheduled_start,session.scheduled_end,slots[0].start,slots[0].end,text(input.reason).trim(),expiresAt,now),...trainingWorkflowNotificationStatements(db,{key:`rolling:${input.idempotencyKey}`,bookingId:input.bookingId,customerId:text(row.customer_id),providerId:text(session.provider_id),sessionId:text(session.id),event:'rolling_change_proposed',sourceId:changeId,actorId:input.actorId,now}));
    result={action:input.action,changeId,status:'pending',expiresAt,originalSlot:{start:session.scheduled_start,end:session.scheduled_end},proposedSlot:slots[0],externalDelivery:false};
   }else{
    if(!proposal||proposal.status!=='proposed'||Number(proposal.expires_at)<=now)throw fail('Training change proposal is missing, expired or already decided');if(proposal.proposed_by===input.actorKind)throw fail('Only the opposite party can accept or reject this Training change',403);if(text(proposal.provider_id)!==text(session.provider_id)||proposal.original_start!==session.scheduled_start||proposal.original_end!==session.scheduled_end)throw fail('The original Training appointment changed; this proposal is stale');
    statements.push(guard(db,`${token}:proposal`, `EXISTS (SELECT 1 FROM training_rolling_changes WHERE id=? AND status='proposed' AND expires_at>${realNowSql} AND proposed_by<>? AND original_start=? AND original_end=? AND provider_id=?)`,[proposal.id,input.actorKind,session.scheduled_start,session.scheduled_end,session.provider_id]));
    if(input.action==='reject_change'){
     statements.push(...await mutationGuards(db,row,token,[],false),db.prepare("UPDATE training_rolling_changes SET status='rejected',decided_at=?,decided_by=? WHERE id=? AND status='proposed'").bind(now,input.actorId,proposal.id),...trainingWorkflowNotificationStatements(db,{key:`rolling:${input.idempotencyKey}`,bookingId:input.bookingId,customerId:text(row.customer_id),providerId:text(session.provider_id),sessionId:text(session.id),event:'rolling_change_rejected',sourceId:text(proposal.id),actorId:input.actorId,now}));result={action:input.action,changeId:proposal.id,status:'rejected',originalReservationRetained:true,externalDelivery:false};
    }else{
     const slots=normalizeSlots([{start:text(proposal.new_start),end:text(proposal.new_end)}],row,1),snapshots=await checkedSnapshots(db,providerRow,slots,text(session.schedule_reservation_id));
     statements.push(...await mutationGuards(db,row,token,snapshots),...changeWindow(db,token,input,session),db.prepare("UPDATE scheduling_reservations SET scheduled_start=?,scheduled_end=?,status='assigned' WHERE id=? AND provider_id=? AND scheduled_start=? AND scheduled_end=? AND status IN ('assigned','confirmed')").bind(slots[0].start,slots[0].end,session.schedule_reservation_id,session.provider_id,session.scheduled_start,session.scheduled_end),db.prepare("UPDATE training_sessions SET scheduled_start=?,scheduled_end=?,updated_at=? WHERE id=? AND provider_id=? AND scheduled_start=? AND scheduled_end=? AND status=?").bind(slots[0].start,slots[0].end,now,session.id,session.provider_id,session.scheduled_start,session.scheduled_end,session.status),db.prepare("UPDATE training_rolling_changes SET status='accepted',decided_at=?,decided_by=? WHERE id=? AND status='proposed'").bind(now,input.actorId,proposal.id),...trainingWorkflowNotificationStatements(db,{key:`rolling:${input.idempotencyKey}`,bookingId:input.bookingId,customerId:text(row.customer_id),providerId:text(session.provider_id),sessionId:text(session.id),event:'reschedule_approved',sourceId:text(proposal.id),actorId:input.actorId,now}));result={action:input.action,changeId:proposal.id,status:'accepted',sessionId:session.id,slots,externalDelivery:false};
    }
   }
  }
  if(input.action==='confirm'||input.action==='accept_change')statements.push(...await trainingRollingBalanceStatements(db,text(row.id),text(row.booking_id),now));
  statements.push(db.prepare("INSERT INTO training_programme_events (id,programme_id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),row.id,row.booking_id,`rolling_${input.action}`,input.actorId,JSON.stringify(result),now),db.prepare('INSERT INTO training_rolling_actions (idempotency_key,fingerprint,result_json,created_at) VALUES (?,?,?,?)').bind(input.idempotencyKey,fingerprint,JSON.stringify(result),now),db.prepare('DELETE FROM training_rolling_assertions WHERE id=? OR id LIKE ?').bind(token,`${token}:%`));await db.batch(statements);return{...result,duplicatePrevented:false};
 }catch(error){
  const raced=await db.prepare('SELECT fingerprint,result_json FROM training_rolling_actions WHERE idempotency_key=?').bind(input.idempotencyKey).first<Row>();if(raced&&raced.fingerprint===fingerprint)return{...parse<Row>(raced.result_json,{}),duplicatePrevented:true};
  if((error instanceof Response&&error.status===409)||(error instanceof Error&&/constraint/i.test(error.message))){await db.batch([alertStatement(db,row,`capacity:${new Date().toISOString().slice(0,10)}`,'Training scheduling review','A Training scheduling action needs review because eligibility, capacity, validity or ownership changed; existing confirmed appointments remain active.')]);if(error instanceof Response)throw error;throw fail('Training schedule changed or capacity was taken; no partial appointment change was committed');}throw error;
 }
}
