import{GET as bookingGet,POST as bookingPost}from"../app/api/canonical-bookings/route";

type Env={DB:D1Database};
type Row=Record<string,unknown>;
const groupId="atomicity-proof-group";
const customerId="atomicity-proof-customer";
const idempotencyKey="atomicity-proof-booking";
const providerId="sit_atomicity_provider";
const url="http://127.0.0.1";

async function count(db:D1Database,table:string,where:string,binds:unknown[]){const row=await db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${where}`).bind(...binds).first<{count:number}>();return Number(row?.count||0);}

async function run(db:D1Database){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,selected_provider_id TEXT,status TEXT NOT NULL,shortlist_json TEXT NOT NULL DEFAULT '[]')"),
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_number INTEGER NOT NULL,status TEXT NOT NULL)"),
  ]);
  await bookingGet(new Request(`${url}/api/canonical-bookings`));
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
  const start=new Date(Date.now()+48*60*60_000);start.setUTCHours(10,0,0,0);const end=new Date(start.getTime()+60*60_000);
  await db.batch([
    db.prepare("INSERT INTO scheduling_assignment_decisions (group_id,selected_provider_id,status,shortlist_json) VALUES (?,?, 'assigned','[]')").bind(groupId,providerId),
    db.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,customer_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,occurrence_number,status) VALUES (?,?,?,?,?,?,?,?,?,1,'active')").bind("atomicity-proof-reservation",groupId,providerId,customerId,"pet_sitting","blr","blr-east",start.toISOString(),end.toISOString()),
  ]);
  await db.prepare("CREATE TRIGGER atomicity_fail_work_order BEFORE INSERT ON provider_work_orders BEGIN SELECT RAISE(ABORT,'fanout_atomicity_sabotage'); END").run();
  const request=new Request(`${url}/api/canonical-bookings`,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"203.0.113.77"},body:JSON.stringify({idempotencyKey,scheduleGroupId:groupId,customer:{id:customerId,name:"Atomicity Proof Customer",primaryPhone:"+919999999977",email:"atomicity@pawspace.test"},pets:[{sourceId:"atomicity-pet",name:"Atomicity Pet",species:"dog",vaccinationStatus:"verified"}],cityId:"blr",zoneId:"blr-east",serviceCode:"pet_sitting",packageCode:"atomicity_visit",packageName:"Atomicity Sitting Visit",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),provider:{id:providerId,name:"Atomicity Provider",model:"commission"},totalAmount:1200,amountDueNow:1200,payment:{method:"card",mode:"prepaid",status:"captured",detail:"Atomicity sabotage proof"},pricing:{discount:0,requirements:[]}})});
  const response=await bookingPost(request);const body=await response.text();
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
  return{ok:true,status:response.status,fanoutRolledBack,assertions};
}

export default{async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==="/health")return Response.json({ok:true});if(path!=="/run")return new Response("Not found",{status:404});try{return Response.json(await run(env.DB));}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null},{status:500});}}};
