import type { Booking, Pet, PlatformRepository, Provider, ProviderAvailability } from "../../../backend/src/domain";
import { cityOffsetMinutes, schedule, scheduleRules, type CustomScheduleRule, type ScheduleDecision, type ScheduleRequest, type SchedulingService } from "../../../backend/src/scheduling";
import {createAssignmentOffer,getGovernedProvider,loadGovernedProviders,seedProviderCapacityDefaults} from "../../../lib/provider-capacity-governance";
import {authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit,type AuthenticatedActor} from "../../../lib/server-auth";
import {cleanupExpiredReservationLeases,ensureSchedulingReservationLeaseGovernance,reservationLeaseForRequest,SCHEDULING_RESERVATION_LEASE_MS} from "../../../lib/scheduling-reservation-leases";
import {listAuthoritativeAvailability,uatRosterSeedingEnabled} from "../../../lib/scheduling-roster-authority";
import {assertProviderAssignable} from "../../../lib/provider-assignment-eligibility";


type RequestBody={action?:"reserve"|"assign"|"cancel"|"reassign"|"manual";assignmentStrategy?:"auto"|"admin_choice";clientRequestId:string;groupId?:string;customerId:string;petIds:string[];serviceCode:SchedulingService;cityId?:string;zoneId:string;scheduledStart:string;scheduledEnd:string;occurrences?:number;cadenceDays?:number;weekdays?:number[];careMode?:"visit"|"overnight";preferredProviderId?:string;providerId?:string;reason?:string;customRules?:CustomScheduleRule[]};
const json=(data:unknown,status=200)=>Response.json(data,{status});
async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
async function tableExists(db:Awaited<ReturnType<typeof database>>,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Record<string,unknown>>());}
const dateRange=(start:string,days=100)=>Array.from({length:days},(_,i)=>{const d=new Date(start);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);});
function cityIdFor(input:Pick<RequestBody,"cityId"|"zoneId">){const explicit=String(input.cityId||"").trim().toLowerCase();if(explicit)return explicit;const derived=String(input.zoneId||"").trim().split("-")[0]?.toLowerCase()||"";if(!/^[a-z0-9]{2,16}$/.test(derived))throw new Error("A valid cityId is required for scheduling");return derived;}
async function ensureSchedulingTables(db:Awaited<ReturnType<typeof database>>){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL DEFAULT 100,condition_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_scheduling_availability_provider_date ON scheduling_availability(provider_id,date)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_scheduling_reservations_provider ON scheduling_reservations(city_id,provider_id,status)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_scheduling_reservations_group ON scheduling_reservations(group_id)"),
]);await ensureSchedulingReservationLeaseGovernance(db);}

/*
 * Synthetic roster is a CAPABILITY, and it is unlocked only by an explicit PAWSPACE_SCHEDULING_ENV=uat.
 * Measured before this gate: one unprivileged customer reserve against an empty table wrote 300 rows of
 * 09:00-19:00 availability for three providers across 100 days, source 'uat_roster' - a source
 * backend/src/domain.ts does not declare - and the engine's "No published availability" rule was then
 * satisfied by the customer's own request. There was no scheduling environment flag anywhere in the
 * domain, so production fabricated roster exactly as UAT did. An absent variable is not a declaration.
 * Same reasoning, and the same shape, as lib/payment-environment.ts. [PTJA-W1-F27]
 */
async function seedUatRoster(input:RequestBody,db:Awaited<ReturnType<typeof database>>){const {env}=await import("cloudflare:workers");if(!uatRosterSeedingEnabled(env))return;const matching=await loadGovernedProviders(db,cityIdFor(input),input.zoneId,input.serviceCode,new Date(input.scheduledStart));const recurring=input.serviceCode==="dog_training"||input.serviceCode==="dog_walking",dates=dateRange(input.scheduledStart,recurring?100:Math.max(2,Math.ceil((new Date(input.scheduledEnd).getTime()-new Date(input.scheduledStart).getTime())/86_400_000)+2));const window=input.serviceCode==="boarding"||input.careMode==="overnight"?"00:00-23:59":input.serviceCode==="pet_taxi"?"06:00-22:00":input.serviceCode==="dog_walking"?"06:00-21:00":"09:00-19:00";
  // Even with seeding declared on, a day a provider or Ops actually authored is theirs. Writing a
  // synthetic row beside a narrow published one is what let a 15:00 request land on a 09:00-11:00 day.
  // One range scan over the dates being seeded, not a lookup per provider-date.
  const sorted=[...dates].sort(),authoredRows=await db.prepare("SELECT provider_id,date FROM scheduling_availability WHERE date>=? AND date<=? AND source IN ('partner_app','operations','roster')").bind(sorted[0]??"",sorted[sorted.length-1]??"").all<Record<string,unknown>>();
  const authored=new Set(authoredRows.results.map(row=>`${String(row.provider_id)}|${String(row.date)}`));
  const statements=[];for(const provider of matching)for(const date of dates){
  if(authored.has(`${provider.id}|${date}`))continue;
  const id=`uat_${provider.id}_${date}_${input.zoneId}`;statements.push(db.prepare("INSERT OR IGNORE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,provider.id,cityIdFor(input),input.zoneId,date,JSON.stringify([window]),"uat_roster",Date.now()));}for(let i=0;i<statements.length;i+=100)await db.batch(statements.slice(i,i+100));}

function repository(db:Awaited<ReturnType<typeof database>>):PlatformRepository{return {
  async listEligibleProviders(cityId:string,zoneId:string,serviceCode:string){return loadGovernedProviders(db,cityId,zoneId,serviceCode);},
  async listBookings(cityId:string,providerId?:string){const rows=await db.prepare("SELECT * FROM scheduling_reservations WHERE city_id=? AND provider_id=? AND status!='cancelled'").bind(cityId,providerId??"").all<Record<string,unknown>>();return rows.results.map(row=>({id:String(row.id),legacyIds:[],idempotencyKey:String(row.id),cityId:String(row.city_id),zoneId:String(row.zone_id),customerId:String(row.customer_id),petIds:JSON.parse(String(row.pet_ids_json)),serviceCode:String(row.service_code),packageCode:"uat",addonCodes:[],scheduledStart:String(row.scheduled_start),scheduledEnd:String(row.scheduled_end),status:String(row.status) as Booking["status"],channel:"customer_app",totalAmount:0,providerId:String(row.provider_id),assignmentMode:"automatic",scheduleGroupId:String(row.group_id),occurrenceNumber:Number(row.occurrence_number),capacityUnits:Number(row.capacity_units),careMode:row.care_mode as Booking["careMode"],createdBy:String(row.customer_id),createdAt:new Date(Number(row.created_at)).toISOString(),updatedAt:new Date(Number(row.created_at)).toISOString()}));},
  async listAvailability(providerId:string,date:string){
    const dayStart=new Date(`${date}T00:00:00+05:30`).toISOString(),dayEnd=new Date(new Date(dayStart).getTime()+86_400_000).toISOString();
    const blocked=await db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1").bind(providerId,dayEnd,dayStart).first<Record<string,unknown>>();
    if(blocked)return [];
    // Authored availability, where it exists, is the whole answer for that date - see
    // lib/scheduling-roster-authority.ts. Turning seeding off cannot retract rows already in the table,
    // so this read is the half that actually restores Ops' ability to narrow a provider's hours.
    const results=await listAuthoritativeAvailability(db,providerId,date);return results.map(row=>({id:String(row.id),providerId:String(row.provider_id),cityId:String(row.city_id),zoneId:String(row.zone_id),date:String(row.date),windows:JSON.parse(String(row.windows_json)),source:String(row.source) as ProviderAvailability["source"],updatedAt:new Date(Number(row.updated_at)).toISOString()}));},
  async getPet(id:string){if(!await tableExists(db,"canonical_pets"))return null;const row=await db.prepare("SELECT id,customer_id,name,species,breed,vaccination_status,created_at,updated_at FROM canonical_pets WHERE id=?").bind(id).first<Record<string,unknown>>();if(!row)return null;return{id:String(row.id),customerId:String(row.customer_id),legacyIds:[],name:String(row.name||id),species:String(row.species||"other") as Pet["species"],breed:row.breed?String(row.breed):undefined,allergies:[],vaccinationStatus:String(row.vaccination_status||"not_provided") as Pet["vaccinationStatus"],createdAt:new Date(Number(row.created_at||Date.now())).toISOString(),updatedAt:new Date(Number(row.updated_at||row.created_at||Date.now())).toISOString()} as Pet;},
  async close(){},
} as unknown as PlatformRepository;}

async function activeRules(db:Awaited<ReturnType<typeof database>>,input:RequestBody){const rows=await db.prepare("SELECT condition_json FROM scheduling_rules WHERE active=1 AND (service_code IS NULL OR service_code=?) AND (city_id IS NULL OR city_id=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY priority ASC").bind(input.serviceCode,cityIdFor(input),input.zoneId).all<{condition_json:string}>();return [...(input.customRules??[]),...rows.results.flatMap(row=>{try{return JSON.parse(row.condition_json) as CustomScheduleRule[];}catch{return [];}})];}
async function saveDecision(db:Awaited<ReturnType<typeof database>>,groupId:string,strategy:"auto"|"admin_choice",input:RequestBody,decision:ScheduleDecision,status:string,selectedProviderId?:string,actorId?:string,reason?:string){await db.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET strategy=excluded.strategy,shortlist_json=excluded.shortlist_json,selected_provider_id=excluded.selected_provider_id,status=excluded.status,actor_id=excluded.actor_id,reason=excluded.reason,updated_at=excluded.updated_at").bind(groupId,strategy,JSON.stringify({request:input,choices:decision.shortlist}),selectedProviderId??null,status,actorId??null,reason??null,Date.now()).run();}
class SlotConflictError extends Error{constructor(){super("SLOT_TAKEN");this.name="SlotConflictError";}}
const RESERVATION_COLUMNS="id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at,lease_expires_at,customer_session_id";
type ReservationLease={leaseExpiresAt:number;customerSessionId:string|null};
/*
 * Every rule the engine used to declare a provider ELIGIBLE must also be a condition of the write that
 * COMMITS the reservation. It was not, and the two disagreed under ordinary concurrency. [PTJA-W1-F30]
 *
 * MEASURED, letting a second request complete its whole read-decide-write while the first request's
 * reservation batch was in flight - the ordinary interleaving of two concurrent D1 requests:
 *
 *   buffer      sequential A 04:00-06:00 -> 200; sequential B 06:15-08:15 -> 409 NO_SCHEDULE_AVAILABLE
 *                            ["Existing booking conflicts with travel/service buffer"]
 *               CONCURRENT   B -> 200 and A -> 200. Both rows durable, 15 minutes apart, for a groomer
 *               whose configured travel buffer is 30.
 *
 *   daily cap   groom_arun capped at 2 jobs/day. Three reserves, the third interleaved -> all three
 *               200, three rows durable against a cap of 2.
 *
 * The committing guard was `WHERE NOT EXISTS (... scheduled_start<? AND scheduled_end>?)` on the RAW
 * occurrence bounds - raw overlap and nothing else - while backend/src/scheduling.ts:105-109 declares
 * the buffer and the daily limit as eligibility rules. Neither state surfaced an error to the customer
 * or to Ops; the only difference between the refused case and the accepted one was request timing.
 *
 * The overnight branch beside this one already did it correctly, with
 * `SUM(capacity_units)+units<=capacity` inside the same INSERT ... SELECT. This is the same treatment
 * for the appointment branch, using the provider's own travel_buffer_minutes and max_daily_jobs and
 * the same IST-local day key the engine uses (cityOffsetMinutes: 330 for blr, 0 elsewhere).
 */
async function insertReservations(db:Awaited<ReturnType<typeof database>>,groupId:string,input:RequestBody,decision:ScheduleDecision,lease:ReservationLease){if(!decision.provider)throw new Error("No eligible provider selected");const createdAt=Date.now();
  /*
   * THE AUTHORITATIVE VERIFICATION GATE. Re-checked here, at the moment of the write, rather than trusted
   * from the decision made moments earlier: a revocation that lands between the two would otherwise still
   * produce a committed assignment. The matching read filters too, but a filter alone loses that race -
   * which is a regression case in tests/ptja-w1-f53-verification-expiry-gate.test.mjs. [PTJA-W1-F53]
   */
  await assertProviderAssignable(db,decision.provider.id,createdAt);const overnight=input.serviceCode==="boarding"||(input.serviceCode==="pet_sitting"&&input.careMode==="overnight");const capacity=Number(decision.provider.capacity??1),units=input.petIds.length;
  // The same numbers backend/src/scheduling.ts evaluates, applied to the write instead of only the read.
  const bufferMs=(decision.provider.travelBufferMinutes??scheduleRules[input.serviceCode].bufferMinutes)*60_000;
  const maxDailyJobs=Number(decision.provider.maxDailyJobs??6);
  const offsetMinutes=cityOffsetMinutes(cityIdFor(input)),cityOffsetModifier=`+${offsetMinutes} minutes`;
  const shift=(value:string,ms:number)=>new Date(new Date(value).getTime()+ms).toISOString();
  const bufferedEnd=(value:string)=>shift(value,bufferMs),bufferedStart=(value:string)=>shift(value,-bufferMs);
  const localDayOf=(value:string)=>shift(value,offsetMinutes*60_000).slice(0,10);
  const statements=decision.occurrences.map(occ=>{const values=[`${groupId}_${decision.provider!.id}_${occ.occurrenceNumber}_${createdAt}`,groupId,decision.provider!.id,input.serviceCode,cityIdFor(input),input.zoneId,input.customerId,JSON.stringify(input.petIds),occ.start,occ.end,units,occ.occurrenceNumber,input.careMode??null,"assigned",JSON.stringify(decision.explanation),createdAt,lease.leaseExpiresAt,lease.customerSessionId];return overnight
  ?db.prepare(`INSERT INTO scheduling_reservations (${RESERVATION_COLUMNS}) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(capacity_units),0) FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?)+?<=? AND EXISTS (SELECT 1 FROM provider_capacity_profiles WHERE id=? AND live=1 AND status='active')`).bind(...values,decision.provider!.id,occ.end,occ.start,units,capacity,decision.provider!.id)
  :db.prepare(`INSERT INTO scheduling_reservations (${RESERVATION_COLUMNS}) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?) AND (SELECT COUNT(*) FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled' AND substr(datetime(scheduled_start,?),1,10)=?)<? AND EXISTS (SELECT 1 FROM provider_capacity_profiles WHERE id=? AND live=1 AND status='active')`).bind(...values,decision.provider!.id,bufferedEnd(occ.end),bufferedStart(occ.start),decision.provider!.id,cityOffsetModifier,localDayOf(occ.start),maxDailyJobs,decision.provider!.id);});
await db.batch(statements);const inserted=await db.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE group_id=? AND created_at=?").bind(groupId,createdAt).first<{count:number}>();if(Number(inserted?.count||0)!==decision.occurrences.length){await db.prepare("DELETE FROM scheduling_reservations WHERE group_id=? AND created_at=?").bind(groupId,createdAt).run();
  // The write refused. Say WHY: a revocation that landed between the decision and the commit is not a
  // slot conflict, and answering "someone took your slot" would send the customer to retry a provider
  // who must not be assigned at all. assertProviderAssignable throws the verification refusal; if the
  // provider is still assignable, the guard that refused was the capacity/buffer one. [PTJA-W1-F53]
  await assertProviderAssignable(db,decision.provider.id);
  throw new SlotConflictError();}}
async function operateAssignment(db:Awaited<ReturnType<typeof database>>,input:RequestBody,actor:AuthenticatedActor){await ensureSchedulingTables(db);await cleanupExpiredReservationLeases(db);const groupId=input.groupId??input.clientRequestId;if(!groupId)return json({error:"Group ID is required"},400);const stored=await db.prepare("SELECT * FROM scheduling_assignment_decisions WHERE group_id=?").bind(groupId).first<Record<string,unknown>>();if(!stored)return json({error:"Scheduling decision not found"},404);
  if(input.action==="cancel"){await db.batch([db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").bind(groupId),db.prepare("UPDATE scheduling_assignment_decisions SET status='cancelled',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(actor.email,input.reason??"Cancelled by Ops",Date.now(),groupId)]);await securityAudit(db,actor,"scheduling.cancel","scheduling_group",groupId,"completed",{reason:input.reason??"Cancelled by Ops"});return json({data:{groupId,status:"cancelled"}});}
  const payload=JSON.parse(String(stored.shortlist_json)) as {request:RequestBody;choices:Array<{provider:Provider}>};const original=payload.request;const manual=input.action==="manual";if(manual&&(!input.reason||input.reason.length<8))return json({error:"Manual assignment requires a clear reason"},400);if(input.action==="assign"&&input.providerId&&!payload.choices.some(choice=>choice.provider.id===input.providerId))return json({error:"Select one of the three recommended providers or use Manual assignment"},409);
  const previousProviderId=stored.selected_provider_id?String(stored.selected_provider_id):null;
  const previousRows=await db.prepare("SELECT id,status FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").bind(groupId).all<{id:string;status:string}>();
  const restore=async()=>{if(previousRows.results.length)await db.batch(previousRows.results.map(row=>db.prepare("UPDATE scheduling_reservations SET status=? WHERE id=?").bind(row.status,row.id)));};
  await db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").bind(groupId).run();
  const rules=await activeRules(db,original);const decision=await schedule(repository(db),{cityId:cityIdFor(original),zoneId:original.zoneId,serviceCode:original.serviceCode,petIds:original.petIds,scheduledStart:original.scheduledStart,scheduledEnd:original.scheduledEnd,occurrences:original.occurrences,cadenceDays:original.cadenceDays,weekdays:original.weekdays,careMode:original.careMode,preferredProviderId:original.preferredProviderId,manualProviderId:input.providerId,manualOverrideReason:input.reason,excludeProviderIds:input.action==="reassign"&&previousProviderId?[previousProviderId]:undefined,customRules:rules});
  if(!decision.provider){await restore();await securityAudit(db,actor,`scheduling.${input.action}`,"scheduling_group",groupId,"rejected",{reason:input.reason??null,restoredReservations:previousRows.results.length});return json({error:"No eligible provider is available for this action; the existing assignment was left in place",evaluations:decision.evaluations,restored:previousRows.results.length>0},409);}
  try{await insertReservations(db,groupId,original,decision,{leaseExpiresAt:Date.now()+SCHEDULING_RESERVATION_LEASE_MS,customerSessionId:null});}catch(error){if(error instanceof SlotConflictError){await restore();await securityAudit(db,actor,`scheduling.${input.action}`,"scheduling_group",groupId,"blocked",{reason:"SLOT_TAKEN"});return json({error:"SLOT_TAKEN",message:"The replacement slot was taken concurrently; the existing assignment was left in place",restored:previousRows.results.length>0},409);}throw error;}
  await saveDecision(db,groupId,String(stored.strategy) as "auto"|"admin_choice",original,decision,"assigned",decision.provider.id,actor.email,input.reason??`${input.action} assignment`);const offer=decision.provider.model==="commission"?await createAssignmentOffer(db,{groupId,providerId:decision.provider.id,attemptNo:Number((await db.prepare("SELECT attempt_no FROM provider_assignment_offers WHERE group_id=?").bind(groupId).first<{attempt_no:number}>())?.attempt_no||0)+1}):null;
  await securityAudit(db,actor,`scheduling.${input.action}`,"scheduling_group",groupId,"completed",{fromProviderId:previousProviderId,toProviderId:decision.provider.id,reason:input.reason??null});
  return json({data:{groupId,status:"assigned",provider:decision.provider,previousProviderId,offer,shortlist:decision.shortlist,explanation:decision.explanation}});}

export async function POST(request:Request){try{const db=await database();const input=await request.json() as RequestBody;
  // Identity BEFORE field validation, so an unauthenticated caller is answered 401 rather than being
  // told which fields it got wrong. tests/route-authorization-class.test.mjs enforces this ordering for
  // every guarded route, and adding the gate below brought this one into that set.
  const actor=await resolveActor(request);
  if(input.action&&input.action!=="reserve"){
  // The SECOND gate. lib/api-gateway.ts already maps this path to scheduling.manage for any action other
  // than reserve, and the worker sends every /api/ request through it - executed, a customer session is
  // refused 403 there. But this handler had no authorization of its own, while the reserve branch three
  // lines down calls requireCustomerOwnership, so anything reaching the handler without the gateway
  // (an internal server-side call, a future route composition) could cancel, reassign or manually
  // override ANY scheduling group by id. Same permission the gateway declares, named here on purpose -
  // the convention this repository already follows in app/api/location-recovery/route.ts. [PTJA-P1-F36]
  requirePermission(actor,"scheduling.manage");await seedProviderCapacityDefaults(db);await ensureSchedulingTables(db);return operateAssignment(db,input,actor);}// Reserve is the customer's own path. Identity, then ownership, then the payload - in that order, so
  // an unauthorized caller is never answered "Missing scheduling fields" instead of being refused. For a
  // customer-owned write, an absent customerId is an ownership failure and not a shape failure:
  // requireCustomerOwnership refuses it, which is why it runs before the field check rather than after.
  // scheduling.book is the permission the gateway already declares for reserve, named here on purpose.
  requirePermission(actor,"scheduling.book");await requireCustomerOwnership(db,actor,input.customerId);
  if(!input.clientRequestId||!input.customerId||!input.petIds?.length||!input.serviceCode||!input.scheduledStart||!input.scheduledEnd)return json({error:"Missing scheduling fields"},400);
  // A slot that has already started can never be delivered, so reserving one only manufactures a future
  // refund, dispute or false no-show against the provider - while silently consuming that provider's
  // overlap guard and daily count for a day that is already over. Nothing here bounded the date except
  // the service's roster window, so ANY past date inside 09:00-19:00 IST was accepted, assigned, and
  // confirmed. This is the platform's own rule, already written in lib/sitting-finance-governance.ts
  // validFutureWindow: a window whose start is not in the future is a 400.
  const reserveStart=new Date(input.scheduledStart).getTime(),reserveEnd=new Date(input.scheduledEnd).getTime();
  if(!Number.isFinite(reserveStart)||!Number.isFinite(reserveEnd)||reserveEnd<=reserveStart)return json({error:"A valid scheduling window is required"},400);
  if(reserveStart<=Date.now())return json({error:"A scheduling window must start in the future; this slot has already passed"},400);await seedProviderCapacityDefaults(db);await ensureSchedulingTables(db);await cleanupExpiredReservationLeases(db);const lease=await reservationLeaseForRequest(db,request,input.customerId);
  // Host selection is a pure request-shape check needing no data access, so it answers first and keeps
  // its own error contract. The boarding pet authority gate moved below it still runs before ANY capacity
  // is reserved, which is what issue #197 item 4 requires.
  const AUTO_ASSIGN_SERVICES=new Set(["grooming","dog_training","pet_taxi","dog_walking"]);
  if(!AUTO_ASSIGN_SERVICES.has(input.serviceCode)&&!input.preferredProviderId&&(input.assignmentStrategy??"auto")!=="admin_choice")return json({error:"host_selection_required",message:"Boarding and pet sitting are host-selected — choose a host before confirming. Auto-assignment is disabled for these services."},409);
  if(input.serviceCode==="boarding"){if(!await tableExists(db,"canonical_pets"))return json({error:"Boarding requires canonical pet records before capacity can be reserved"},409);for(const petId of input.petIds){const pet=await db.prepare("SELECT customer_id,vaccination_status FROM canonical_pets WHERE id=?").bind(petId).first<Record<string,unknown>>();if(!pet||String(pet.customer_id)!==input.customerId)return json({error:"Boarding pet ownership could not be verified before reservation"},403);if(String(pet.vaccination_status)!=="verified")return json({error:"Boarding requires verified vaccination for every selected pet"},409);}}const prior=await db.prepare("SELECT * FROM scheduling_assignment_decisions WHERE group_id=?").bind(input.clientRequestId).first<Record<string,unknown>>();if(prior){
  // A scheduling group identifies ONE requested window. This replay used to answer with the stored
  // decision without ever comparing the window it was asked about, so a second reserve carrying the same
  // clientRequestId and a DIFFERENT date was told {status:"assigned"} for a day on which nothing was
  // reserved - and the booking built on that answer was confirmed and PAID. Measured: reserve 11-20,
  // reserve 11-27 under the same group -> 200 assigned, one reservation row still on 11-20, then a
  // confirmed booking for 11-27 with 1899 captured. Same rule as the lifecycle and payment keys: a key
  // reused for a different request is a CONFLICT, not a duplicate. [PTJA-P1-F28]
  const held=await db.prepare("SELECT scheduled_start,scheduled_end FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' ORDER BY occurrence_number LIMIT 1").bind(input.clientRequestId).first<Record<string,unknown>>();
  const sameInstant=(a:unknown,b:unknown)=>new Date(String(a)).getTime()===new Date(String(b)).getTime();
  if(held&&(!sameInstant(held.scheduled_start,input.scheduledStart)||!sameInstant(held.scheduled_end,input.scheduledEnd)))
    return json({error:"This scheduling group already holds a different window; use a new request id for a different time",code:"scheduling_group_window_conflict",held:{scheduledStart:held.scheduled_start,scheduledEnd:held.scheduled_end}},409);
  const provider=prior.selected_provider_id?await getGovernedProvider(db,String(prior.selected_provider_id)):null;return json({data:{groupId:input.clientRequestId,status:prior.status,provider,duplicatePrevented:true}});}await seedUatRoster(input,db);const rules=await activeRules(db,input);const requestInput:ScheduleRequest={cityId:cityIdFor(input),zoneId:input.zoneId,serviceCode:input.serviceCode,petIds:input.petIds,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,occurrences:input.occurrences,cadenceDays:input.cadenceDays,weekdays:input.weekdays,careMode:input.careMode,preferredProviderId:input.preferredProviderId,customRules:rules};const decision=await schedule(repository(db),requestInput);if(!decision.provider)return json({error:"NO_SCHEDULE_AVAILABLE",evaluations:decision.evaluations},409);const strategy=input.assignmentStrategy??"auto";if(strategy==="admin_choice"){await saveDecision(db,input.clientRequestId,strategy,input,decision,"awaiting_admin");return json({data:{groupId:input.clientRequestId,status:"awaiting_admin",shortlist:decision.shortlist,explanation:decision.explanation}});}try{await insertReservations(db,input.clientRequestId,input,decision,lease);}catch(error){if(error instanceof SlotConflictError){const winner=await db.prepare("SELECT * FROM scheduling_assignment_decisions WHERE group_id=?").bind(input.clientRequestId).first<Record<string,unknown>>();if(winner&&winner.selected_provider_id)return json({data:{groupId:input.clientRequestId,status:String(winner.status),provider:await getGovernedProvider(db,String(winner.selected_provider_id)),duplicatePrevented:true}});return json({error:"SLOT_TAKEN",message:"Another reservation took this provider/slot a moment ago — pick a different time or retry for the next eligible provider"},409);}throw error;}await saveDecision(db,input.clientRequestId,strategy,input,decision,"assigned",decision.provider.id,"system","Auto-assigned by ranked rules");const offer=decision.provider.model==="commission"?await createAssignmentOffer(db,{groupId:input.clientRequestId,providerId:decision.provider.id}):null;return json({data:{groupId:input.clientRequestId,status:"assigned",provider:decision.provider,mode:decision.mode,offer,occurrences:decision.occurrences,shortlist:decision.shortlist,explanation:decision.explanation,evaluations:decision.evaluations}});}catch(error){return authError(error,"Scheduling failed");}}

export async function GET(request:Request){try{
  // The day board lists every reservation in a day - group, provider, service, zone and the CUSTOMER ID
  // of each one. lib/api-gateway.ts already maps this path to scheduling.manage for GET, and the worker
  // sends every /api/ request through it, but this handler had no identity check of its own and
  // answered 200 to an anonymous caller. Second gate, same permission the gateway declares. [PTJA-P1-F36]
  requirePermission(await resolveActor(request),"scheduling.manage");
  const db=await database();const url=new URL(request.url);const date=String(url.searchParams.get("date")||"").trim()||new Date(Date.now()+330*60_000).toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"A valid IST date (YYYY-MM-DD) is required"},400);
  const dayStart=new Date(`${date}T00:00:00+05:30`).toISOString(),dayEnd=new Date(new Date(dayStart).getTime()+86_400_000).toISOString();
  if(!await tableExists(db,"scheduling_reservations"))return json({data:{date,dayStartUtc:dayStart,dayEndUtc:dayEnd,providers:[],total:0}});
  const hasProfiles=await tableExists(db,"provider_capacity_profiles"),hasDecisions=await tableExists(db,"scheduling_assignment_decisions");
  const selectProfile=hasProfiles?"p.name provider_name,p.provider_model":"NULL provider_name,NULL provider_model";
  const selectDecision=hasDecisions?"d.status decision_status":"NULL decision_status";
  const joinProfile=hasProfiles?" LEFT JOIN provider_capacity_profiles p ON p.id=r.provider_id":"";
  const joinDecision=hasDecisions?" LEFT JOIN scheduling_assignment_decisions d ON d.group_id=r.group_id":"";
  const rows=await db.prepare(`SELECT r.id,r.group_id,r.provider_id,r.service_code,r.zone_id,r.customer_id,r.scheduled_start,r.scheduled_end,r.status,r.occurrence_number,r.capacity_units,${selectProfile},${selectDecision} FROM scheduling_reservations r${joinProfile}${joinDecision} WHERE r.scheduled_start>=? AND r.scheduled_start<? ORDER BY r.provider_id,r.scheduled_start`).bind(dayStart,dayEnd).all<Record<string,unknown>>();
  const columns=new Map<string,{providerId:string;providerName:string;providerModel:string;reservations:Array<Record<string,unknown>>}>();
  for(const row of rows.results){const key=String(row.provider_id);if(!columns.has(key))columns.set(key,{providerId:key,providerName:String(row.provider_name||key),providerModel:String(row.provider_model||"commission"),reservations:[]});columns.get(key)!.reservations.push({id:String(row.id),groupId:String(row.group_id),serviceCode:String(row.service_code),zoneId:String(row.zone_id),customerId:String(row.customer_id),scheduledStart:String(row.scheduled_start),scheduledEnd:String(row.scheduled_end),status:String(row.status),occurrenceNumber:Number(row.occurrence_number),capacityUnits:Number(row.capacity_units),decisionStatus:String(row.decision_status||"")});}
  return json({data:{date,dayStartUtc:dayStart,dayEndUtc:dayEnd,providers:[...columns.values()],total:rows.results.length}});}catch(error){return authError(error,"Unable to load the scheduling day board");}}
