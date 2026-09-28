import {executeCanonicalBookingRequest} from "../app/api/canonical-bookings/route";
import {ensureSecurityTables, type AuthenticatedActor} from "../lib/server-auth";
// Transaction isolation test only. Authentication is covered by separate real-handler tests.
const actor: AuthenticatedActor = {email:"atomicity@pawspace.test",name:"Local atomicity fixture",roleCode:"superuser",permissions:["*"],developmentPreview:true,identitySource:"workspace",principalType:"email",principalKey:"atomicity@pawspace.test"};

type Env={DB:D1Database;NODE_ENV?:string};
type Row=Record<string,unknown>;
const groupId="atomicity-proof-group";
const customerId="atomicity-proof-customer";
const idempotencyKey="atomicity-proof-booking";
const providerId="vet_atomicity_provider";
const url="http://127.0.0.1";

async function count(db:D1Database,table:string,where:string,binds:unknown[]){const row=await db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${where}`).bind(...binds).first<{count:number}>();return Number(row?.count||0);}

async function run(db:D1Database){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)"),
  ]);
  await ensureSecurityTables(db);
  const start=new Date(Date.now()+48*60*60_000);start.setUTCHours(10,0,0,0);const end=new Date(start.getTime()+60*60_000);
  // A governed single-patient Vet booking exercises the same canonical fanout without an obsolete
  // unquoted Sitting payload. This is synthetic local data, not a clinical or payment transaction.
  const request=()=>new Request(`${url}/api/canonical-bookings`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({idempotencyKey,scheduleGroupId:groupId,customer:{id:customerId,name:"Atomicity Proof Customer",primaryPhone:"+919999999977",email:"atomicity@pawspace.test"},pets:[{sourceId:"atomicity-pet",name:"Atomicity Pet",species:"dog",vaccinationStatus:"verified"}],cityId:"blr",zoneId:"blr-east",serviceCode:"vet_consult",packageCode:"vet_home_visit",packageName:"Doorstep Vet Consultation",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),provider:{id:providerId,name:"Atomicity Provider",model:"commission"},totalAmount:599,amountDueNow:599,payment:{method:"card",mode:"prepaid",status:"created",detail:"Local rollback fixture"},pricing:{discount:0,requirements:[],vetTriageLevel:"routine",vetTriageSummary:"Synthetic test only"}})});
  // Initialize through the real booking execution path. Never depend on an unauthenticated GET
  // creating tables: the real API must continue to reject such a request before data access.
  const warm=await executeCanonicalBookingRequest(request(),actor);
  if(warm.status!==409)throw new Error(`Schema warmup did not reach scheduling validation: ${warm.status} ${await warm.text()}`);
  await db.prepare("DROP TRIGGER IF EXISTS atomicity_fail_work_order").run();
  await db.batch([
    db.prepare("DELETE FROM scheduling_reservations WHERE group_id=?").bind(groupId),
    db.prepare("DELETE FROM scheduling_assignment_decisions WHERE group_id=?").bind(groupId),
    db.prepare("DELETE FROM booking_lifecycle_events WHERE actor_id=?").bind(customerId),
    db.prepare("DELETE FROM booking_payments WHERE customer_id=?").bind(customerId),
    db.prepare("DELETE FROM provider_work_orders WHERE schedule_group_id=?").bind(groupId),
    db.prepare("DELETE FROM canonical_bookings WHERE idempotency_key=? OR schedule_group_id=?").bind(idempotencyKey,groupId),
    db.prepare("DELETE FROM canonical_pets WHERE customer_id=?").bind(customerId),
    db.prepare("DELETE FROM canonical_customers WHERE id=?").bind(customerId),
  ]);
  await db.batch([
    db.prepare("INSERT INTO scheduling_assignment_decisions (group_id,selected_provider_id,status,shortlist_json,strategy,updated_at) VALUES (?,?, 'assigned','[]','fixture',?)").bind(groupId,providerId,Date.now()),
    db.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,customer_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,occurrence_number,status,pet_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,'active','[]',?)").bind("atomicity-proof-reservation",groupId,providerId,customerId,"vet_consult","blr","blr-east",start.toISOString(),end.toISOString(),Date.now()),
  ]);
  await db.prepare("CREATE TRIGGER atomicity_fail_work_order BEFORE INSERT ON provider_work_orders BEGIN SELECT RAISE(ABORT,'fanout_atomicity_sabotage'); END").run();
  const response=await executeCanonicalBookingRequest(request(),actor);const body=await response.text();
  if(response.status!==500||!body.includes("fanout_atomicity_sabotage"))throw new Error(`The injected mid-batch fault was not reached: ${response.status} ${body}`);
  await db.prepare("DROP TRIGGER IF EXISTS atomicity_fail_work_order").run();
  const assertions={
    customers:await count(db,"canonical_customers","id=?",[customerId]),
    pets:await count(db,"canonical_pets","customer_id=?",[customerId]),
    bookings:await count(db,"canonical_bookings","idempotency_key=?",[idempotencyKey]),
    workOrders:await count(db,"provider_work_orders","schedule_group_id=?",[groupId]),
    payments:await count(db,"booking_payments","customer_id=?",[customerId]),
    lifecycleEvents:await count(db,"booking_lifecycle_events","actor_id=?",[customerId]),
    reservations:await count(db,"scheduling_reservations","group_id=? AND status!='cancelled'",[groupId]),
  };
  const fanoutKeys=["customers","pets","bookings","workOrders","payments","lifecycleEvents"] as const;
  const fanoutRolledBack=fanoutKeys.every(key=>assertions[key]===0);
  if(response.ok)throw new Error(`sabotaged booking unexpectedly succeeded: ${body}`);
  if(!fanoutRolledBack)throw new Error(`D1 fanout was partially persisted: ${JSON.stringify(assertions)}`);
  if(assertions.reservations!==1)throw new Error(`pre-existing scheduling reservation was unexpectedly changed: ${JSON.stringify(assertions)}`);
  const healthy=await executeCanonicalBookingRequest(request(),actor);
  if(healthy.status!==201)throw new Error(`Positive control failed after removing the fault: ${healthy.status} ${await healthy.text()}`);
  return{ok:true,status:response.status,injectedFaultReached:true,positiveControlStatus:healthy.status,fanoutRolledBack,assertions};
}

export default{async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(env.NODE_ENV!=="test")return new Response("Local test worker only",{status:403});if(path==="/health")return Response.json({ok:true});if(path!=="/run")return new Response("Not found",{status:404});try{return Response.json(await run(env.DB));}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null},{status:500});}}};
