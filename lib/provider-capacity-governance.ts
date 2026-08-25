import type{Provider}from"../backend/src/domain";

type Db=D1Database;
type Row=Record<string,unknown>;

const defaults=[
  {id:"groom_arun",cityId:"blr",name:"Arun R.",model:"full_time",services:["grooming"],zones:["blr-east"],rating:4.9,qualityScore:96,capacity:1,travelBufferMinutes:30,maxDailyJobs:4,acceptanceTimeoutMinutes:0},
  {id:"groom_kiran",cityId:"blr",name:"Kiran S.",model:"commission",services:["grooming"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:1,travelBufferMinutes:30,maxDailyJobs:5,acceptanceTimeoutMinutes:3},
  {id:"groom_sanjay",cityId:"blr",name:"Sanjay P.",model:"full_time",services:["grooming"],zones:["blr-east"],rating:4.7,qualityScore:89,capacity:1,travelBufferMinutes:30,maxDailyJobs:4,acceptanceTimeoutMinutes:0},
  {id:"train_kiran",cityId:"blr",name:"Kiran S.",model:"commission",services:["dog_training"],zones:["blr-east"],rating:4.9,qualityScore:95,capacity:1,travelBufferMinutes:45,maxDailyJobs:4,acceptanceTimeoutMinutes:3},
  {id:"train_ramesh",cityId:"blr",name:"Ramesh P.",model:"commission",services:["dog_training"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:1,travelBufferMinutes:45,maxDailyJobs:4,acceptanceTimeoutMinutes:3},
  {id:"train_meera",cityId:"blr",name:"Meera T.",model:"commission",services:["dog_training"],zones:["blr-east"],rating:4.7,qualityScore:89,capacity:1,travelBufferMinutes:45,maxDailyJobs:4,acceptanceTimeoutMinutes:3},
  {id:"host_maya_rohan",cityId:"blr",name:"Maya & Rohan",model:"commission",services:["boarding"],zones:["blr-east"],rating:4.9,qualityScore:96,capacity:4,travelBufferMinutes:0,maxDailyJobs:12,acceptanceTimeoutMinutes:3},
  {id:"host_sana",cityId:"blr",name:"Sana F.",model:"commission",services:["boarding"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:3,travelBufferMinutes:0,maxDailyJobs:10,acceptanceTimeoutMinutes:3},
  {id:"host_arjun_tara",cityId:"blr",name:"Arjun & Tara",model:"commission",services:["boarding"],zones:["blr-east"],rating:4.7,qualityScore:89,capacity:3,travelBufferMinutes:0,maxDailyJobs:10,acceptanceTimeoutMinutes:3},
  {id:"host_priya_dev",cityId:"blr",name:"Priya & Dev",model:"commission",services:["boarding"],zones:["blr-east"],rating:4.8,qualityScore:91,capacity:4,travelBufferMinutes:0,maxDailyJobs:12,acceptanceTimeoutMinutes:3},
  {id:"sit_sana",cityId:"blr",name:"Sana F.",model:"commission",services:["pet_sitting"],zones:["blr-east"],rating:4.9,qualityScore:95,capacity:4,travelBufferMinutes:30,maxDailyJobs:6,acceptanceTimeoutMinutes:3},
  {id:"sit_neha",cityId:"blr",name:"Neha P.",model:"commission",services:["pet_sitting"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:4,travelBufferMinutes:30,maxDailyJobs:6,acceptanceTimeoutMinutes:3},
  {id:"sit_asha",cityId:"blr",name:"Asha R.",model:"commission",services:["pet_sitting"],zones:["blr-east"],rating:4.7,qualityScore:89,capacity:4,travelBufferMinutes:30,maxDailyJobs:6,acceptanceTimeoutMinutes:3},
  {id:"taxi_rahul",cityId:"blr",name:"Rahul K.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.9,qualityScore:96,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},
  {id:"taxi_meera",cityId:"blr",name:"Meera S.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},
  {id:"taxi_imran",cityId:"blr",name:"Imran A.",model:"full_time",services:["pet_taxi"],zones:["blr-east"],rating:4.9,qualityScore:94,capacity:1,travelBufferMinutes:20,maxDailyJobs:8,acceptanceTimeoutMinutes:3},
  {id:"walk_nisha",cityId:"blr",name:"Nisha P.",model:"commission",services:["dog_walking"],zones:["blr-east"],rating:4.9,qualityScore:96,capacity:1,travelBufferMinutes:20,maxDailyJobs:10,acceptanceTimeoutMinutes:3},
  {id:"walk_kiran",cityId:"blr",name:"Kiran M.",model:"commission",services:["dog_walking"],zones:["blr-east"],rating:4.8,qualityScore:92,capacity:1,travelBufferMinutes:20,maxDailyJobs:10,acceptanceTimeoutMinutes:3},
  {id:"walk_asha",cityId:"blr",name:"Asha R.",model:"commission",services:["dog_walking"],zones:["blr-east"],rating:5.0,qualityScore:94,capacity:1,travelBufferMinutes:20,maxDailyJobs:10,acceptanceTimeoutMinutes:3},
] as const;

// Per-isolate memoization: table DDL and the fixed default roster are idempotent constants, so once
// they have run against a given D1 binding there is no reason to re-issue them on every helper call.
// Before this, seedProviderCapacityDefaults ran ~18 sequential INSERTs and was invoked 3+ times per
// scheduling request (POST + loadGovernedProviders in seedUatRoster + loadGovernedProviders in the
// engine), i.e. ~57 sequential D1 round-trips that dominated the ~20s reserve latency.
const capacityTablesEnsured=new WeakSet<Db>();
const capacityDefaultsSeeded=new WeakSet<Db>();

export async function ensureProviderCapacityTables(db:Db){if(capacityTablesEnsured.has(db))return;await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_capacity_audit (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_recovery_cases (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,booking_id TEXT,failed_provider_id TEXT NOT NULL,reason_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',replacement_provider_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',opened_at INTEGER NOT NULL,resolved_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_performance_events (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,group_id TEXT,booking_id TEXT,event_type TEXT NOT NULL,impact_score INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_unavailability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_capacity_profiles_lookup ON provider_capacity_profiles(city_id,live,status,effective_from,effective_to)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_unavailability_active ON provider_unavailability(provider_id,status,starts_at,ends_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_assignment_offers_group ON provider_assignment_offers(group_id)"),
]);capacityTablesEnsured.add(db);}

export async function seedProviderCapacityDefaults(db:Db){if(capacityDefaultsSeeded.has(db))return;await ensureProviderCapacityTables(db);const now=Date.now();await db.batch(defaults.map(p=>db.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,'active',1,'2026-08-01',NULL,'founder_seed',?)").bind(p.id,p.cityId,p.name,p.model,JSON.stringify(p.services),JSON.stringify(p.zones),p.rating,p.qualityScore,p.capacity,p.travelBufferMinutes,p.maxDailyJobs,p.acceptanceTimeoutMinutes,now)));capacityDefaultsSeeded.add(db);}

function parse<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}
/**
 * A configured number, with the documented default used ONLY when there is no number.
 *
 * These fields used to be read as Number(row.max_daily_jobs||6) and friends, so 0 - the one value an
 * operator uses to stand a provider DOWN - is falsy and was silently replaced by the hardcoded default:
 * a driver whose row said max_daily_jobs=0 was handed six jobs, and the scheduler then refused the
 * seventh with "Daily job limit 6 reached", quoting a number the row does not contain. Same idiom turned
 * capacity 0 into 1 (a host with no kennels still took a stay) and a deliberate 0 travel buffer into 30.
 *
 * Present-but-zero is a decision and is honoured. Absent is still the default, which is the existing
 * contract for a column nobody has set. A stored value that is not a number at all falls back too - the
 * PATCH now refuses to create one, and reading a legacy NaN as 0 would silently make a live provider
 * unbookable rather than merely mis-limited. [PTJA-P1-F29]
 */
function configuredNumber(value:unknown,fallback:number){if(value===null||value===undefined||value==="")return fallback;const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;}
function rowToProvider(row:Row):Provider{return{id:String(row.id),cityId:String(row.city_id),name:String(row.name),model:String(row.provider_model) as Provider["model"],services:parse<string[]>(row.services_json,[]),zones:parse<string[]>(row.zones_json,[]),live:Boolean(row.live)&&String(row.status)==="active",rating:configuredNumber(row.rating,0),qualityScore:configuredNumber(row.quality_score,0),capacity:configuredNumber(row.capacity,1),travelBufferMinutes:configuredNumber(row.travel_buffer_minutes,30),maxDailyJobs:configuredNumber(row.max_daily_jobs,6)};}

export async function loadGovernedProviders(db:Db,cityId:string,zoneId:string,serviceCode:string,at=new Date()){await seedProviderCapacityDefaults(db);const date=at.toISOString().slice(0,10);const rows=await db.prepare("SELECT * FROM provider_capacity_profiles WHERE city_id=? AND live=1 AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)").bind(cityId,date,date).all<Row>();const providers=rows.results.map(rowToProvider).filter(p=>p.services.includes(serviceCode)&&p.zones.includes(zoneId));const nowIso=at.toISOString();const blocks=await Promise.all(providers.map(provider=>db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<=? AND ends_at>? LIMIT 1").bind(provider.id,nowIso,nowIso).first<Row>()));return providers.filter((_,index)=>!blocks[index]);}

export async function getGovernedProvider(db:Db,providerId:string){await seedProviderCapacityDefaults(db);const row=await db.prepare("SELECT * FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();return row?rowToProvider(row):null;}
export async function providerUnavailableForWindow(db:Db,input:{providerId:string;scheduledStart:string;scheduledEnd:string}){
  await ensureProviderCapacityTables(db);
  const blocked=await db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1")
    .bind(input.providerId,input.scheduledEnd,input.scheduledStart).first<Row>();
  return Boolean(blocked);
}
export async function ensureProviderBookingGuard(db:Db){
  await ensureProviderCapacityTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS provider_booking_confirmation_guards (group_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)"),
    // This trigger executes in the SAME D1 batch/transaction as the canonical customer, pet,
    // booking, work-order and payment writes. A leave inserted after the friendly pre-check but before
    // that batch therefore aborts the whole batch instead of leaving a contradictory booking.
    db.prepare("CREATE TRIGGER IF NOT EXISTS block_unavailable_provider_booking BEFORE INSERT ON provider_booking_confirmation_guards WHEN EXISTS (SELECT 1 FROM scheduling_reservations r JOIN provider_unavailability u ON u.provider_id=r.provider_id AND u.status='active' AND u.starts_at<r.scheduled_end AND u.ends_at>r.scheduled_start WHERE r.group_id=NEW.group_id AND r.status!='cancelled') BEGIN SELECT RAISE(ABORT,'provider_unavailable_before_booking'); END"),
  ]);
}
export async function getProviderAcceptanceTimeout(db:Db,providerId:string){await seedProviderCapacityDefaults(db);const row=await db.prepare("SELECT acceptance_timeout_minutes FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();return Math.max(1,Number(row?.acceptance_timeout_minutes||3));}

export async function createAssignmentOffer(db:Db,input:{groupId:string;bookingId?:string;providerId:string;attemptNo?:number}){await seedProviderCapacityDefaults(db);const timeout=await getProviderAcceptanceTimeout(db,input.providerId),now=Date.now(),expiresAt=now+timeout*60_000;await db.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,responded_at,response_reason,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,NULL,NULL,?,?) ON CONFLICT(group_id) DO UPDATE SET booking_id=COALESCE(excluded.booking_id,booking_id),provider_id=excluded.provider_id,status='pending',offered_at=excluded.offered_at,expires_at=excluded.expires_at,responded_at=NULL,response_reason=NULL,attempt_no=excluded.attempt_no,updated_at=excluded.updated_at").bind(input.groupId,input.bookingId??null,input.providerId,now,expiresAt,input.attemptNo??1,now).run();return{timeoutMinutes:timeout,expiresAt};}

export async function recordProviderPerformance(db:Db,input:{providerId:string;groupId?:string;bookingId?:string;eventType:string;impactScore:number;detail?:unknown}){await ensureProviderCapacityTables(db);await db.prepare("INSERT INTO provider_performance_events (id,provider_id,group_id,booking_id,event_type,impact_score,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.providerId,input.groupId??null,input.bookingId??null,input.eventType,input.impactScore,JSON.stringify(input.detail??{}),Date.now()).run();}

/**
 * The real write path the partner app's Available/Offline toggle should call. Before this
 * function existed, that toggle was pure local UI state - loadGovernedProviders() has always
 * correctly checked provider_unavailability, but nothing anywhere ever wrote a real row to it from
 * the provider's own self-service toggle. Going offline creates a real, open-ended unavailability
 * window (closed only by explicitly going available again, not auto-expiring) - matching how a real
 * "I'm offline" toggle should behave: it stays off until the provider turns it back on themselves.
 */
/**
 * Going UNAVAILABLE is always the provider's own call. Coming BACK is not.
 *
 * Unavailability is two different things wearing one row: a provider taking a day off, and the platform
 * restricting a provider it does not currently trust — a rejected KYC check, a suspension, an
 * accountability case. Clearing every active window on request treated those as the same thing, so a
 * provider suspended by staff could lift the suspension by asking to be available again. Ownership was
 * enforced and authority was not: the record is theirs, the restriction is not.
 *
 * A window may therefore only be cleared by the actor who imposed it, unless the caller is acting as
 * staff over providers. `actorIsStaff` defaults to FALSE so a caller that has not established authority
 * gets the restrictive branch rather than the permissive one.
 */
export async function setProviderAvailability(db:Db,input:{providerId:string;available:boolean;reason:string;actorId:string;actorIsStaff?:boolean}){
  await ensureProviderCapacityTables(db);
  if(!input.providerId.trim())throw new Error("Provider is required");
  if(input.reason.trim().length<3)throw new Error("A real reason is required");
  const now=Date.now();
  if(input.available){
    const nowIso=new Date(now).toISOString();
    const staff=input.actorIsStaff===true;
    const sql="UPDATE provider_unavailability SET ends_at=?,status='cleared',updated_at=? WHERE provider_id=? AND status='active' AND starts_at<=? AND ends_at>?"+(staff?"":" AND created_by=?");
    const args=[nowIso,now,input.providerId,nowIso,nowIso];
    if(!staff)args.push(input.actorId);
    const result=await db.prepare(sql).bind(...args).run();
    const cleared=Number(result.meta?.changes||0);
    // Anything still standing was imposed by somebody else and stays standing. Reported rather than
    // thrown: asking to be available when nothing blocks you is not an error, and the caller needs to
    // know it did not take effect.
    const blocking=await db.prepare("SELECT COUNT(*) n FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<=? AND ends_at>?")
      .bind(input.providerId,nowIso,nowIso).first<Row>();
    const restricted=Number(blocking?.n||0);
    return{providerId:input.providerId,available:restricted===0,windowsCleared:cleared,restrictionsRemaining:restricted};
  }
  const startsAt=new Date(now).toISOString(),endsAt=new Date(now+10*365*86400000).toISOString();
  const id=`PUNAVAIL-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  await db.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .bind(id,input.providerId,startsAt,endsAt,input.reason.trim(),input.actorId,now,now).run();
  return{providerId:input.providerId,available:false,unavailabilityId:id};
}
