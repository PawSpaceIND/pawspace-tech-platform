/**
 * Shared callback context and cancel adapter. Fetch is mocked. No live telephony or model spend.
 * Does not change tests/ai-web-chat-callback-handoff.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installWorkersHooks("__CB_REGRESSION_DB__", "__CB_REGRESSION_ENV__");

const fetches = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`unexpected network fetch blocked: ${url}`);
};

const control = await import("../lib/ai-first-control-plane.ts");
const gov = await import("../lib/voice-outbound-governance.ts");
const route = await import("../app/api/ai-web-chat/route.ts");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/ai-web-chat`;
const PHONE = `+91${ALLOWLISTED_PHONE}`;

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function world(env) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CB_REGRESSION_DB__ = db;
  globalThis.__CB_REGRESSION_ENV__ = env;
  // The first cloudflare:workers shim in a combined run bakes its own env global.
  globalThis.__CHAT_CB_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db };
}

function seedCustomer(sqlite, customerId, phone) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, "blr", `Customer ${customerId}`, phone, now, now);
}

function actor(permissions = ["customers.manage"], principalKey = PHONE) {
  return {
    email: "customer.callback@pawspace.test",
    name: "Callback Customer",
    roleCode: "customer",
    permissions,
    developmentPreview: false,
    identitySource: "customer_app",
    principalType: "phone",
    principalKey,
  };
}


function seedLead(sqlite, leadId, customerId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT)");
  sqlite.prepare("INSERT INTO lead_work_items (id, customer_id) VALUES (?,?)").run(leadId, customerId);
}
function seedPet(sqlite, petId, customerId) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(petId, customerId, "Indie", "dog", "Indie", "verified", now, now);
}
function seedService(sqlite, serviceCode, cityId = "blr") {
  sqlite.exec("CREATE TABLE IF NOT EXISTS catalogue_packages (id TEXT PRIMARY KEY, service_code TEXT NOT NULL, package_code TEXT NOT NULL, city_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)");
  sqlite.prepare("INSERT OR REPLACE INTO catalogue_packages (id, service_code, package_code, city_id, active) VALUES (?,?,?,?,1)")
    .run(`pkg-${serviceCode}-${cityId}`, serviceCode, "standard", cityId);
}
function seedCityService(sqlite, cityCode, services, status = "Live") {
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL DEFAULT 'Test',state TEXT NOT NULL DEFAULT 'Test',status TEXT NOT NULL,centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL DEFAULT 'test',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT OR REPLACE INTO city_launch_configs (id, city_code, status, services_json) VALUES (?,?,?,?)")
    .run(`city-${cityCode}`, cityCode, status, JSON.stringify(services));
}
function n(sqlite, name) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return exists ? Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) : 0;
}

function liveFetches() {
  return fetches.filter((url) => /exotel|elevenlabs|twilio|telephony|api\.openai/i.test(url));
}

async function customerCookie(db, customerId, phone) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: phone,
    subjectType: "customer", subjectId: customerId, cityId: "blr", verificationState: "verified",
    expiresAt: null, metadata: {}, actorId: "test", reason: "shared callback",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function post(db, body, headers = {}) {
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const response = await runWithWorkersDb(db, () => route.POST(request));
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

const future = () => new Date(Date.now() + 3 * 86400000).toISOString();
const past = () => new Date(Date.now() - 3 * 86400000).toISOString();

// These are deterministic source/SQLite regressions; every external fetch throws.
function seedBooking(sqlite,id,cityId,status="confirmed",customerId="CUS-REG"){
 sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL)");
 sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?,?)").run(id,customerId,cityId,"boarding",status);
}
const request=(extra={})=>({actor:actor(),customerId:"CUS-REG",message:"Please call me back",idempotencyKey:"regression",...extra});
async function fixture(env=uatVoiceEnv()){
 const ctx=await world(env);seedCustomer(ctx.sqlite,"CUS-REG",PHONE);
 seedPet(ctx.sqlite,"PET-FIRST","CUS-REG");seedPet(ctx.sqlite,"PET-SECOND","CUS-REG");
 seedBooking(ctx.sqlite,"BOOK-FIRST","hyd");seedBooking(ctx.sqlite,"BOOK-SECOND","maa");
 seedService(ctx.sqlite,"boarding","hyd");seedService(ctx.sqlite,"boarding","maa");
 return{...ctx,env};
}
const fields=result=>Object.fromEntries(["requestedStart","petId","serviceCode","leadId","serviceDate","cityId","bookingId"].map(key=>[key,result[key]]));

test("changed retry date, destination and booking preserve the complete original context",async()=>{
 const ctx=await fixture();
 const first=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({serviceDate:"28-09-2027",petId:"PET-FIRST",bookingId:"BOOK-FIRST"}));
 const before=ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context").get();
 const replay=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({serviceDate:"29/09/2027",petId:"PET-SECOND",bookingId:"BOOK-SECOND"}));
 assert.equal(replay.callback.callId,first.callback.callId);assert.equal(replay.callback.duplicatePrevented,true);
 assert.deepEqual(fields(replay),fields(first));assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context").get(),before);
 const order=ctx.sqlite.prepare("SELECT city_id,booking_id FROM voice_call_orders").get();
 assert.equal(order.city_id,"hyd");assert.equal(order.booking_id,"BOOK-FIRST");
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_callback_dispatch_intents"),1);assert.deepEqual(fetches,[]);
});

test("omitted retry fields and cancel replay never erase first-bound date or booking",async()=>{
 const ctx=await fixture();
 const first=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({serviceDate:"28/09/2027",petId:"PET-FIRST",bookingId:"BOOK-FIRST"}));
 const before=ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context").get();
 const replay=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request());
 assert.deepEqual(fields(replay),fields(first));
 await control.cancelGovernedCustomerCallback(ctx.db,{actor:actor(),customerId:"CUS-REG",callId:first.callback.callId});
 const cancelled=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request());
 assert.equal(cancelled.callback.state,"cancelled");assert.equal(cancelled.callback.callId,first.callback.callId);
 assert.deepEqual(fields(cancelled),fields(first));assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM ai_callback_request_context").get(),before);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.deepEqual(fetches,[]);
});

test("context is already bound atomically when the canonical voice order INSERT completes",async()=>{
 const ctx=await fixture(),prepare=ctx.db.prepare.bind(ctx.db);let observed=false;
 ctx.db.prepare=sql=>{
  const wrapped=args=>{
   const stmt=prepare(sql).bind(...args);
   return{...stmt,bind:(...next)=>wrapped(next),run:async()=>{
    const result=await stmt.run();
    if(sql.startsWith("INSERT INTO voice_call_orders")){
     const context=ctx.sqlite.prepare("SELECT c.* FROM ai_callback_request_context c JOIN voice_call_orders v ON v.id=c.call_id").get();
     assert.equal(context.booking_id,"BOOK-FIRST");assert.equal(context.service_date,"28/09/2027");observed=true;
    }
    return result;
   }};
  };return wrapped([]);
 };
 await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({serviceDate:"28/09/2027",bookingId:"BOOK-FIRST"}));
 assert.equal(observed,true);assert.deepEqual(fetches,[]);
});

for(const failure of ["incompatible context","ALTER permission","PRAGMA permission","trigger permission","intent write","missing intent read"]){
 test(`${failure} fails before consent and any voice order`,async()=>{
  const ctx=await fixture();
  if(failure==="incompatible context")ctx.sqlite.exec("CREATE TABLE ai_callback_request_context (call_id TEXT PRIMARY KEY)");
  if(failure==="ALTER permission")ctx.sqlite.exec("CREATE TABLE ai_callback_request_context (call_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,customer_id TEXT NOT NULL,requested_start TEXT,pet_id TEXT,service_code TEXT,lead_id TEXT,created_at INTEGER NOT NULL)");
  const prepare=ctx.db.prepare.bind(ctx.db);
  const matches=sql=>failure==="ALTER permission"?sql.startsWith("ALTER TABLE ai_callback_request_context"):failure==="PRAGMA permission"?sql.startsWith("PRAGMA table_info(ai_callback_request_context)"):failure==="trigger permission"?sql.startsWith("CREATE TRIGGER IF NOT EXISTS trg_callback_context"):failure==="intent write"?sql.startsWith("INSERT INTO ai_callback_dispatch_intents"):failure==="missing intent read"?sql.startsWith("SELECT * FROM ai_callback_dispatch_intents"):false;
  ctx.db.prepare=sql=>{
   if(!matches(sql))return prepare(sql);
   const stmt={bind:()=>stmt,run:async()=>{throw new Error("callback storage permission denied");},all:async()=>{throw new Error("callback storage permission denied");},first:async()=>null};return stmt;
  };
  await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request()),error=>error instanceof Error||error instanceof Response&&error.status===403);
  assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(fetches,[]);
 });
}

test("context INSERT failure rolls back the voice order before provider dispatch and can be retried",async()=>{
 const ctx=await fixture();
 // Install the reviewed schema first, then simulate a failing storage trigger during order insertion.
 const {ensureCallbackContextSchema}=await import("../lib/customer-callback-context.ts");
 await gov.ensureVoiceCallTables(ctx.db);await ensureCallbackContextSchema(ctx.db);
 ctx.sqlite.exec("CREATE TRIGGER reject_callback_context BEFORE INSERT ON ai_callback_request_context BEGIN SELECT RAISE(ABORT,'context storage failed'); END");
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-FIRST",serviceDate:"28/09/2027"})),/context storage failed/);
 assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"ai_callback_request_context"),0);assert.deepEqual(fetches,[]);
 ctx.sqlite.exec("DROP TRIGGER reject_callback_context");
 const retried=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-SECOND",serviceDate:"29/09/2027"}));
 assert.equal(retried.bookingId,"BOOK-FIRST");assert.equal(retried.cityId,"hyd");assert.equal(retried.serviceDate,"28/09/2027");
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.deepEqual(fetches,[]);
});

test("concurrent requests share one immutable intent, context and call",async()=>{
 const ctx=await fixture();
 const results=await Promise.all([
  control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-FIRST",serviceDate:"28/09/2027",petId:"PET-FIRST"})),
  control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-SECOND",serviceDate:"29/09/2027",petId:"PET-SECOND"})),
 ]);
 assert.equal(results[0].callback.callId,results[1].callback.callId);assert.deepEqual(fields(results[0]),fields(results[1]));
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_callback_request_context"),1);assert.equal(n(ctx.sqlite,"ai_callback_dispatch_intents"),1);
 assert.equal(results.filter(result=>result.callback.duplicatePrevented).length,1);assert.deepEqual(fetches,[]);
});

test("foreign occupied intent is refused before consent",async()=>{
 const ctx=await fixture(),{ensureCallbackContextSchema}=await import("../lib/customer-callback-context.ts");
 await gov.ensureVoiceCallTables(ctx.db);await ensureCallbackContextSchema(ctx.db);
 ctx.sqlite.prepare("INSERT INTO ai_callback_dispatch_intents (idempotency_key,customer_id,phone_key,city_id,created_at) VALUES (?,?,?,?,?)").run(`ai-callback:v2:${JSON.stringify(["CUS-REG","regression"])}`,"CUS-FOREIGN","919000000011","hyd",Date.now());
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request()),error=>error instanceof Response&&error.status===403);
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(fetches,[]);
});

test("future calendar request has a truthful notice and no consent, context or call",async()=>{
 const ctx=await fixture(),date=new Date(Date.now()+7*86400000),dmy=`${date.getUTCDate()}/${date.getUTCMonth()+1}/${date.getUTCFullYear()}`;
 const result=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({requestedStart:dmy}));
 assert.equal(result.scheduling,"unsupported");assert.equal(result.notice,"Scheduling is not available.");
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"ai_callback_dispatch_intents"),0);assert.deepEqual(fetches,[]);
 for(const invalid of ["31/02/2027","2027-02-31","02/10","11am-1pm"]){
  await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({requestedStart:invalid})),error=>error instanceof Response&&error.status===400);
 }
});

test("route replay keeps original fields and exactly one blocked-provider handoff",async()=>{
 const ctx=await fixture({...uatVoiceEnv(),PAWSPACE_VOICE_TRANSPORT:"",PAWSPACE_VOICE_RUNTIME:"not_a_provider"});
 const cookie=await customerCookie(ctx.db,"CUS-REG",PHONE);
 await post(ctx.db,{mode:"authenticated",bot:true,start:true},{cookie});
 const first=await post(ctx.db,{mode:"authenticated",message:"Please call me back",idempotencyKey:"regression",serviceDate:"28/09/2027",bookingId:"BOOK-FIRST",petId:"PET-FIRST"},{cookie});
 const replay=await post(ctx.db,{mode:"authenticated",message:"Please call me back",idempotencyKey:"regression",serviceDate:"29/09/2027",bookingId:"BOOK-SECOND",petId:"PET-SECOND"},{cookie});
 assert.equal(first.status,201,JSON.stringify(first.payload));assert.equal(replay.status,201,JSON.stringify(replay.payload));
 assert.deepEqual(fields(replay.payload.data.callback),fields(first.payload.data.callback));
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(first.payload.data.callbackOutcome,"not_placed");assert.deepEqual(fetches,[]);
 const date=new Date(Date.now()+7*86400000),dmy=`${date.getUTCDate()}/${date.getUTCMonth()+1}/${date.getUTCFullYear()}`;
 const later=await post(ctx.db,{mode:"authenticated",message:"Please call me back",idempotencyKey:"future",requestedStart:dmy},{cookie});
 assert.equal(later.status,200);assert.equal(later.payload.data.callback.notice,"Scheduling is not available.");
 assert.equal(later.payload.data.callbackNotice,"Scheduling is not available. The PawSpace team has been asked to follow up.");assert.equal(n(ctx.sqlite,"voice_call_orders"),1);
});

test("Active launch eligibility and explicit booking policy do not bypass terminal or city controls",async()=>{
 const active=await fixture();
 const {seedDefaultCityLaunchConfigs}=await import("../lib/city-governance.ts");await seedDefaultCityLaunchConfigs(active.db);
 active.sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,services_json,updated_by,created_at,updated_at) VALUES ('active','pnq','Pune','Test','Active',?,'test',0,0)").run(JSON.stringify({Grooming:{enabled:true}}));
 const placed=await control.requestGovernedCustomerCallback(active.db,active.env,request({cityId:"pnq",serviceCode:"grooming"}));
 assert.equal(placed.cityId,"pnq");
 for(const status of ["completed","refunded","cancelled","","unknown"]){
  const ctx=await fixture();ctx.sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id='BOOK-FIRST'").run(status);
  await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-FIRST"})),error=>error instanceof Response&&error.status===409);
  assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"voice_call_consents"),0);
 }
 for(const status of ["Paused","Closed"]){
  const ctx=await fixture();await seedDefaultCityLaunchConfigs(ctx.db);
  ctx.sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,services_json,updated_by,created_at,updated_at) VALUES ('hyd','hyd','Hyderabad','Test',?,?,'test',0,0)").run(status,JSON.stringify({Boarding:{enabled:true}}));
  if(status==="Paused"){
   const existing=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-FIRST"}));assert.equal(existing.cityId,"hyd");
  }else await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-FIRST"})),error=>error instanceof Response&&error.status===409);
  await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({idempotencyKey:"new",cityId:"hyd",serviceCode:"boarding"})),error=>error instanceof Response&&error.status===409);
 }
 assert.deepEqual(fetches,[]);
});

test("a stale incompatible binding trigger fails before consent",async()=>{
 const ctx=await fixture();await gov.ensureVoiceCallTables(ctx.db);
 ctx.sqlite.exec("CREATE TRIGGER trg_callback_context_before_dispatch_v1 AFTER INSERT ON voice_call_orders BEGIN SELECT 1; END");
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request()),/binding trigger is missing or incompatible/);
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(fetches,[]);
});

test("a pending original destination is revalidated even when the retry names an eligible city",async()=>{
 const ctx=await fixture(),{ensureCallbackContextSchema}=await import("../lib/customer-callback-context.ts");
 seedService(ctx.sqlite,"grooming","hyd");seedService(ctx.sqlite,"grooming","maa");
 await gov.ensureVoiceCallTables(ctx.db);await ensureCallbackContextSchema(ctx.db);
 ctx.sqlite.exec("CREATE TRIGGER reject_callback_context BEFORE INSERT ON ai_callback_request_context BEGIN SELECT RAISE(ABORT,'context storage failed'); END");
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({cityId:"hyd",serviceCode:"grooming"})),/context storage failed/);
 ctx.sqlite.exec("DROP TRIGGER reject_callback_context");
 ctx.sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,services_json,updated_by,created_at,updated_at) VALUES ('hyd','hyd','Hyderabad','Test','Paused',?,'test',0,0)").run(JSON.stringify({Grooming:{enabled:true}}));
 const consent=ctx.sqlite.prepare("SELECT * FROM voice_call_consents").all();
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({cityId:"maa",serviceCode:"grooming"})),error=>error instanceof Response&&error.status===409);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM voice_call_consents").all(),consent);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(fetches,[]);
});

test("owned context metadata corruption cannot replace the immutable intent on replay",async()=>{
 const ctx=await fixture();await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({bookingId:"BOOK-FIRST",serviceDate:"28/09/2027"}));
 ctx.sqlite.prepare("UPDATE ai_callback_request_context SET service_date='29/09/2027'").run();
 const consent=ctx.sqlite.prepare("SELECT * FROM voice_call_consents").all();
 await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request()),error=>error instanceof Response&&error.status===409);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM voice_call_consents").all(),consent);assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.deepEqual(fetches,[]);
});

test("concurrent guarded migration of the legacy context schema preserves both request contexts",async()=>{
 const ctx=await fixture();
 ctx.sqlite.exec("CREATE TABLE ai_callback_request_context (call_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,customer_id TEXT NOT NULL,requested_start TEXT,pet_id TEXT,service_code TEXT,lead_id TEXT,created_at INTEGER NOT NULL)");
 const results=await Promise.all([
  control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({idempotencyKey:"migration-a",bookingId:"BOOK-FIRST",serviceDate:"28/09/2027"})),
  control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({idempotencyKey:"migration-b",bookingId:"BOOK-SECOND",serviceDate:"29/09/2027"})),
 ]);
 assert.notEqual(results[0].callback.callId,results[1].callback.callId);
 assert.equal(results[0].serviceDate,"28/09/2027");assert.equal(results[1].serviceDate,"29/09/2027");
 assert.equal(n(ctx.sqlite,"voice_call_orders"),2);assert.equal(n(ctx.sqlite,"ai_callback_request_context"),2);assert.deepEqual(fetches,[]);
});

test("a historical booking never overrides a current disabled service or authorizes unselected cross-city work",async()=>{
 const {seedDefaultCityLaunchConfigs}=await import("../lib/city-governance.ts");
 for(const status of ["completed","refunded","cancelled","confirmed"]){
  const ctx=await fixture();await seedDefaultCityLaunchConfigs(ctx.db);seedService(ctx.sqlite,"grooming","hyd");
  ctx.sqlite.prepare("UPDATE canonical_bookings SET status=?,service_code='grooming' WHERE id='BOOK-FIRST'").run(status);
  ctx.sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,services_json,updated_by,created_at,updated_at) VALUES ('hyd','hyd','Hyderabad','Test','Live',?,'test',0,0)").run(JSON.stringify({Grooming:{enabled:false}}));
  for(const extra of [{cityId:"hyd",serviceCode:"grooming"},{bookingId:"BOOK-FIRST"},{cityId:"hyd"}]){
   await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request(extra)),error=>error instanceof Response&&error.status===409);
   assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"voice_call_consents"),0);
  }
 }
 assert.deepEqual(fetches,[]);
});

test("negated or cancelled callback wording is not customer consent",async()=>{
 const ctx=await fixture();
 for(const message of ["Please don't call me","Do not call me back","Don’t call me","Stop calling me","Cancel my callback","No callback needed","You did not call me"]){
  assert.equal(control.isCustomerCallbackRequest(message),false,message);
  const result=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({message}));assert.equal(result.matched,false,message);
 }
 assert.equal(control.isCustomerCallbackRequest("Can you call me back please?"),true);
 assert.equal(control.isCustomerCallbackRequest("No problem, please call me back"),true);
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(fetches,[]);
});

test("explicit future callback wording cannot become an immediate call when the timestamp is omitted",async()=>{
 const ctx=await fixture();
 for(const message of ["Please call me tomorrow","Call me back later","Please call me at 5pm","Please call me in 10 minutes","Please call me next week","Please call me in an hour","Call me this evening","Call me on Monday","Call me at noon","Please call me in two hours"]){
  const result=await control.requestGovernedCustomerCallback(ctx.db,ctx.env,request({message}));
  assert.equal(result.scheduling,"unsupported",message);assert.equal(result.notice,"Scheduling is not available.");
 }
 assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"ai_callback_dispatch_intents"),0);assert.deepEqual(fetches,[]);
});

test("canonical dog_training obeys Training disabled for catalogue and active-booking requests",async()=>{
 const {seedDefaultCityLaunchConfigs}=await import("../lib/city-governance.ts");
 for(const booking of [false,true]){
  const ctx=await fixture();await seedDefaultCityLaunchConfigs(ctx.db);seedService(ctx.sqlite,"dog_training","hyd");
  ctx.sqlite.prepare("UPDATE canonical_bookings SET service_code='dog_training' WHERE id='BOOK-FIRST'").run();
  ctx.sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,services_json,updated_by,created_at,updated_at) VALUES ('hyd','hyd','Hyderabad','Test','Live',?,'test',0,0)").run(JSON.stringify({Training:{enabled:false}}));
  await assert.rejects(()=>control.requestGovernedCustomerCallback(ctx.db,ctx.env,request(booking?{bookingId:"BOOK-FIRST"}:{cityId:"hyd",serviceCode:"dog_training"})),error=>error instanceof Response&&error.status===409);
  assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"voice_call_consents"),0);
 }
 assert.deepEqual(fetches,[]);
});
