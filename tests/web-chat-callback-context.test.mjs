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


const bot=await import("../lib/web-chat-bot.ts");
const adapter=await import("../lib/ai-web-chat-adapter.ts");
function selected(answers={}){return{...bot.initialBotState(),status:"collecting",flow:"boarding",answers:{petId:"PET-FIRST",serviceCode:"boarding",date:"28/09/2027",city:"Hyderabad",bookingId:"BOOK-FIRST",...answers}};}
async function guidedFixture(){const ctx=await fixture({...uatVoiceEnv(),PAWSPACE_VOICE_TRANSPORT:"",PAWSPACE_VOICE_RUNTIME:"not_a_provider"});const cookie=await customerCookie(ctx.db,"CUS-REG",PHONE);await post(ctx.db,{mode:"authenticated",bot:true,start:true},{cookie});await adapter.saveWebChatBotState(ctx.db,"customer:CUS-REG",selected());return{...ctx,cookie};}
const callBody=(extra={})=>({mode:"authenticated",bot:true,choiceId:"request_call",idempotencyKey:"guided-call",...extra});
const notices=sqlite=>sqlite.prepare("SELECT payload_json FROM communication_messages WHERE idempotency_key LIKE '%callback-notice%'").all().map(row=>JSON.parse(row.payload_json).text);

test("call event carries explicit selection without pretending a call was placed",()=>{
 const turn=bot.runBotTurn(selected(),{choiceId:"request_call",signedIn:true});
 assert.deepEqual(turn.event,{type:"call",petId:"PET-FIRST",serviceCode:"boarding",serviceDate:"28/09/2027",requestedStart:null,cityId:"hyd",bookingId:"BOOK-FIRST",leadId:null});assert.doesNotMatch(turn.reply.text,/arranging|placed|calling.*now/i);
 const fresh=bot.runBotTurn({...selected(),answers:{petType:"Dog",breed:"Labrador"}},{choiceId:"request_call",signedIn:true});assert.equal(fresh.event.petId,null);assert.equal(fresh.event.bookingId,null);
 const team=bot.runBotTurn({...selected(),flow:"team",answers:{}},{choiceId:"request_call",signedIn:true});assert.equal(team.event.serviceCode,null);
});

test("guided route binds selected context and persists a truthful outcome exactly once on replay",async()=>{
 const ctx=await guidedFixture();const first=await post(ctx.db,callBody(),{cookie:ctx.cookie});assert.equal(first.status,201,JSON.stringify(first.payload));
 const callback=first.payload.data.callback;assert.equal(callback.petId,"PET-FIRST");assert.equal(callback.cityId,"hyd");assert.equal(callback.bookingId,"BOOK-FIRST");assert.equal(callback.serviceDate,"28/09/2027");assert.equal(callback.requestedStart,null);
 const replay=await post(ctx.db,callBody({petId:"PET-SECOND",bookingId:"BOOK-SECOND",cityId:"maa",serviceDate:"29/09/2027"}),{cookie:ctx.cookie});assert.equal(replay.status,201,JSON.stringify(replay.payload));assert.equal(replay.payload.data.duplicatePrevented,true);assert.deepEqual(fields(replay.payload.data.callback),fields(callback));
 assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.deepEqual(notices(ctx.sqlite),[first.payload.data.callbackNotice]);assert.deepEqual(fetches,[]);
});

test("body conflicts and foreign pets fail before consent or voice order",async()=>{
 for(const body of [{petId:"PET-SECOND"},{cityId:"maa"}]){const ctx=await guidedFixture();const response=await post(ctx.db,callBody(body),{cookie:ctx.cookie});assert.equal(response.status,409,JSON.stringify(response.payload));assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(notices(ctx.sqlite),[]);}
 const ctx=await guidedFixture();seedPet(ctx.sqlite,"FOREIGN","CUS-OTHER");await adapter.saveWebChatBotState(ctx.db,"customer:CUS-REG",selected({petId:"FOREIGN"}));const response=await post(ctx.db,callBody(),{cookie:ctx.cookie});assert.equal(response.status,403);assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);
});

test("failed outcome persistence is repaired by replay without another call or handoff",async()=>{
 const ctx=await guidedFixture();ctx.sqlite.exec("CREATE TRIGGER reject_callback_notice BEFORE INSERT ON communication_messages WHEN NEW.idempotency_key LIKE '%callback-notice%' BEGIN SELECT RAISE(ABORT,'test notice unavailable'); END");
 const failed=await post(ctx.db,callBody(),{cookie:ctx.cookie});assert.equal(failed.status,500);assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.deepEqual(notices(ctx.sqlite),[]);
 ctx.sqlite.exec("DROP TRIGGER reject_callback_notice");const replay=await post(ctx.db,callBody(),{cookie:ctx.cookie});assert.equal(replay.status,201,JSON.stringify(replay.payload));assert.equal(notices(ctx.sqlite).length,1);assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.deepEqual(fetches,[]);
});

test("future callback timestamp remains unsupported without premature dispatch claims",async()=>{
 const ctx=await guidedFixture();await adapter.saveWebChatBotState(ctx.db,"customer:CUS-REG",selected({requestedStart:future()}));const response=await post(ctx.db,callBody(),{cookie:ctx.cookie});assert.equal(response.status,200,JSON.stringify(response.payload));assert.equal(response.payload.data.callback.notice,"Scheduling is not available.");assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.deepEqual(notices(ctx.sqlite),[response.payload.data.callbackNotice]);
});

test("pet taxi rejects addresses as times and changed details require explicit confirmation",()=>{
 const flow=bot.WEB_CHAT_FLOWS.find(row=>row.code==="pet_taxi");const timeIndex=flow.steps.filter(step=>!step.anonymousOnly).findIndex(step=>step.key==="time");
 const state={...bot.initialBotState(),status:"collecting",flow:"pet_taxi",step:timeIndex,answers:{purpose:"Vet Visits",date:"05/10/2027"}};
 for(const text of ["HSR Layout","25:00 AM","13 PM","10:78 AM"]){const turn=bot.runBotTurn(state,{text,signedIn:true});assert.equal(turn.state.answers.time,undefined,text);assert.notEqual(turn.event.type,"completed");}
 assert.equal(bot.runBotTurn(state,{text:"10:30 am",signedIn:true}).state.answers.time,"10:30 AM");
 let result=bot.runBotTurn(bot.initialBotState(),{choiceId:"pet_taxi",signedIn:true});for(const text of ["Incity","Dog","1","3+ years","1-2","Yes","Vet Visits","05/10","10:30 AM","Round Trip","60 mins","HSR Layout","Cessna vet clinic","No","Pick up at 11 AM instead"])result=bot.runBotTurn(result.state,{text,signedIn:true});
 assert.equal(result.event.type,"none");assert.match(result.reply.text,/confirm.*requested change/);const done=bot.runBotTurn(result.state,{text:"Yes",signedIn:true});assert.equal(done.event.type,"completed");assert.equal(done.event.followUp,"team");
 const old=bot.parseBotState({...result.state,version:2});assert.equal(old.status,"menu");
});

test("grooming enquiry completion never claims an order exists",()=>{
 let result=bot.runBotTurn(bot.initialBotState(),{choiceId:"grooming",signedIn:true});for(const text of ["No","Dog","1","Labrador","Bath & Basic","28/09","9am-11am","HSR Layout","OK"])result=bot.runBotTurn(result.state,{text,signedIn:true});assert.equal(result.event.type,"completed");assert.match(result.reply.text,/grooming enquiry/i);assert.doesNotMatch(result.reply.text,/your order|order confirmation/i);
});

test("anonymous grooming completion is an enquiry without a fictitious order",()=>{
 let result=bot.runBotTurn(bot.initialBotState(),{choiceId:"grooming",signedIn:false});for(const text of ["Asha Rao","9876543210","No","Dog","1","Labrador","Bath & Basic","28/09","9am-11am","HSR Layout","OK","No, call me instead"])result=bot.runBotTurn(result.state,{text,signedIn:false});assert.equal(result.event.type,"completed");assert.match(result.reply.text,/Thank you for your grooming enquiry/);assert.doesNotMatch(result.reply.text,/your order|order confirmation/i);
});

test("failed human handoff cannot persist a claim the team has been connected",async()=>{
 const ctx=await guidedFixture();const handoff=await import("../lib/ai-human-handoff.ts");await handoff.ensureAiHumanHandoff(ctx.db);ctx.sqlite.exec("CREATE TRIGGER reject_human_handoff BEFORE INSERT ON ai_handoffs BEGIN SELECT RAISE(ABORT,'test handoff unavailable'); END");
 const before=ctx.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n;const response=await post(ctx.db,{mode:"authenticated",bot:true,choiceId:"talk_to_team",idempotencyKey:"guided-human"},{cookie:ctx.cookie});assert.equal(response.status,500,JSON.stringify(response.payload));assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n,before);assert.equal(n(ctx.sqlite,"ai_handoffs"),0);
});

test("first body-supplied future timing stays unsupported on a retry that omits it",async()=>{
 const ctx=await guidedFixture();const first=await post(ctx.db,callBody({requestedStart:future()}),{cookie:ctx.cookie});assert.equal(first.status,200);assert.equal(first.payload.data.callback.notice,"Scheduling is not available.");
 const replay=await post(ctx.db,callBody({petId:"PET-SECOND",bookingId:"BOOK-SECOND",cityId:"maa"}),{cookie:ctx.cookie});assert.equal(replay.status,200,JSON.stringify(replay.payload));assert.equal(replay.payload.data.callback.notice,"Scheduling is not available.");assert.deepEqual(fields(replay.payload.data.callback),fields(first.payload.data.callback));assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(notices(ctx.sqlite).length,1);
});

test("human handoff failure recovers on the same key exactly once",async()=>{
 const ctx=await guidedFixture();const handoff=await import("../lib/ai-human-handoff.ts");await handoff.ensureAiHumanHandoff(ctx.db);ctx.sqlite.exec("CREATE TRIGGER reject_human_retry BEFORE INSERT ON ai_handoffs BEGIN SELECT RAISE(ABORT,'test pending handoff'); END");const body={mode:"authenticated",bot:true,choiceId:"talk_to_team",idempotencyKey:"human-retry"};
 assert.equal((await post(ctx.db,body,{cookie:ctx.cookie})).status,500);ctx.sqlite.exec("DROP TRIGGER reject_human_retry");for(let i=0;i<2;i++){const response=await post(ctx.db,body,{cookie:ctx.cookie});assert.equal(response.status,200,JSON.stringify(response.payload));assert.equal(response.payload.data.path,"human");}
 assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key='web-chat-bot:human-retry'").get().n,1);assert.deepEqual(fetches,[]);
});

test("null first-context slots remain null after an unsupported request replay",async()=>{
 const ctx=await guidedFixture();await adapter.saveWebChatBotState(ctx.db,"customer:CUS-REG",{...bot.initialBotState(),flow:"team",status:"collecting",answers:{}});const first=await post(ctx.db,callBody({requestedStart:future()}),{cookie:ctx.cookie});assert.equal(first.status,200,JSON.stringify(first.payload));
 const replay=await post(ctx.db,callBody({petId:"PET-SECOND",bookingId:"BOOK-SECOND",cityId:"maa",serviceCode:"boarding",serviceDate:"28/09/2027"}),{cookie:ctx.cookie});assert.equal(replay.status,200,JSON.stringify(replay.payload));assert.deepEqual(fields(replay.payload.data.callback),fields(first.payload.data.callback));assert.equal(replay.payload.data.callback.petId,null);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);
});

test("team enquiry handoff failure recovers on the same key without an AI booking",async()=>{
 const ctx=await guidedFixture();let turn=bot.runBotTurn(bot.initialBotState(),{choiceId:"grooming",signedIn:true});for(const text of ["Yes","30/09","3pm-5pm","No"])turn=bot.runBotTurn(turn.state,{text,signedIn:true});await adapter.saveWebChatBotState(ctx.db,"customer:CUS-REG",turn.state);
 const handoff=await import("../lib/ai-human-handoff.ts");await handoff.ensureAiHumanHandoff(ctx.db);ctx.sqlite.exec("CREATE TRIGGER reject_team_retry BEFORE INSERT ON ai_handoffs BEGIN SELECT RAISE(ABORT,'test pending team'); END");const body={mode:"authenticated",bot:true,message:"Yes, it's same",idempotencyKey:"team-retry"};assert.equal((await post(ctx.db,body,{cookie:ctx.cookie})).status,500);ctx.sqlite.exec("DROP TRIGGER reject_team_retry");for(let i=0;i<2;i++){const response=await post(ctx.db,body,{cookie:ctx.cookie});assert.equal(response.status,200,JSON.stringify(response.payload));assert.equal(response.payload.data.path,"completed");assert.equal(response.payload.data.handedOff,true);}assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key='web-chat-bot:team-retry'").get().n,1);assert.deepEqual(fetches,[]);
});

test("completed human handoff replay does not reopen a staff-resumed queue",async()=>{
 const ctx=await guidedFixture();const body={mode:"authenticated",bot:true,choiceId:"talk_to_team",idempotencyKey:"human-resumed"};assert.equal((await post(ctx.db,body,{cookie:ctx.cookie})).status,200);ctx.sqlite.exec("UPDATE ai_handoffs SET status='resumed'");const before=n(ctx.sqlite,"ai_handoff_events");assert.equal((await post(ctx.db,body,{cookie:ctx.cookie})).status,200);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(n(ctx.sqlite,"ai_handoff_events"),before);assert.equal(ctx.sqlite.prepare("SELECT status FROM ai_handoffs").get().status,"resumed");
});

test("missing callback notice repairs after staff resume without reopening its original fallback",async()=>{
 const ctx=await guidedFixture();ctx.sqlite.exec("CREATE TRIGGER reject_resumed_notice BEFORE INSERT ON communication_messages WHEN NEW.idempotency_key LIKE '%callback-notice%' BEGIN SELECT RAISE(ABORT,'test notice unavailable'); END");assert.equal((await post(ctx.db,callBody(),{cookie:ctx.cookie})).status,500);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);ctx.sqlite.exec("UPDATE ai_handoffs SET status='resumed'; DROP TRIGGER reject_resumed_notice");const before=n(ctx.sqlite,"ai_handoff_events");assert.equal((await post(ctx.db,callBody(),{cookie:ctx.cookie})).status,201);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(n(ctx.sqlite,"ai_handoff_events"),before);assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.equal(notices(ctx.sqlite).length,1);assert.deepEqual(fetches,[]);
});

test("guided call preserves future wording and refuses contradictory consent on replay",async()=>{
 const ctx=await guidedFixture();const futureBody=callBody({message:"Please call me in an hour"});assert.equal((await post(ctx.db,futureBody,{cookie:ctx.cookie})).status,200);const replay=await post(ctx.db,callBody(),{cookie:ctx.cookie});assert.equal(replay.status,200);assert.equal(replay.payload.data.callback.notice,"Scheduling is not available.");assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);
 const other=await guidedFixture();assert.equal((await post(other.db,callBody({message:"Do not call me"}),{cookie:other.cookie})).status,400);assert.equal((await post(other.db,callBody(),{cookie:other.cookie})).status,400);assert.equal(n(other.sqlite,"voice_call_consents"),0);assert.equal(n(other.sqlite,"voice_call_orders"),0);assert.equal(n(other.sqlite,"ai_handoffs"),0);assert.deepEqual(notices(other.sqlite),[]);
});

test("direct lane future body timing and future wording remain immutable on omitted-field retry",async()=>{
 for(const firstFields of [{message:"Please call me back",requestedStart:future()},{message:"Please call me tomorrow"}]){const ctx=await guidedFixture();const body={mode:"authenticated",message:"Please call me back",idempotencyKey:"direct-future"};const first=await post(ctx.db,{...body,...firstFields},{cookie:ctx.cookie});assert.equal(first.status,200,JSON.stringify(first.payload));const replay=await post(ctx.db,{...body,petId:"PET-SECOND",serviceCode:"boarding",cityId:"maa",bookingId:"BOOK-SECOND",serviceDate:"28/09/2027"},{cookie:ctx.cookie});assert.equal(replay.status,200,JSON.stringify(replay.payload));assert.equal(replay.payload.data.callback.notice,"Scheduling is not available.");assert.deepEqual(fields(replay.payload.data.callback),fields(first.payload.data.callback));assert.equal(n(ctx.sqlite,"voice_call_consents"),0);assert.equal(n(ctx.sqlite,"voice_call_orders"),0);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.deepEqual(fetches,[]);}
});

test("direct fallback replay after staff resume preserves the original queue and call",async()=>{
 const ctx=await guidedFixture();const body={mode:"authenticated",message:"Please call me back",idempotencyKey:"direct-resume",petId:"PET-FIRST",serviceCode:"boarding",cityId:"hyd",bookingId:"BOOK-FIRST"};assert.equal((await post(ctx.db,body,{cookie:ctx.cookie})).status,201);ctx.sqlite.exec("UPDATE ai_handoffs SET status='resumed'");const before=n(ctx.sqlite,"ai_handoff_events");assert.equal((await post(ctx.db,body,{cookie:ctx.cookie})).status,201);assert.equal(n(ctx.sqlite,"ai_handoffs"),1);assert.equal(n(ctx.sqlite,"ai_handoff_events"),before);assert.equal(n(ctx.sqlite,"voice_call_orders"),1);assert.deepEqual(fetches,[]);
});
