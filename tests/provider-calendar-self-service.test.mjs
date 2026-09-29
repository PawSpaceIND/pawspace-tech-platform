import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {employeeAuditD1} from "./helpers/employee-audit-d1.mjs";

installWorkersHooks("__G17_CALENDAR_DB__","__G17_CALENDAR_ENV__");
const route=await import("../app/api/provider-availability/route.ts");
const auth=await import("../lib/server-auth.ts");
const capacity=await import("../lib/provider-capacity-governance.ts");
const security=await import("../lib/platform-security.ts");

const HOST="https://app.pawspace.in/api/provider-availability";
const COMMISSION="groom_kiran",FULL_TIME="groom_arun";
const COMMISSION_EMAIL="kiran.calendar@providers.pawspace.test";
const FULL_TIME_EMAIL="arun.calendar@providers.pawspace.test";
const DAY="2026-10-15";

async function world(t){
 const w=employeeAuditD1(t);globalThis.__G17_CALENDAR_DB__=w.db;globalThis.__G17_CALENDAR_ENV__={};
 await auth.ensureSecurityTables(w.db);await capacity.seedProviderCapacityDefaults(w.db);
 const calendar=await import("../lib/provider-calendar-self-service.ts");await calendar.ensureProviderSelfCalendarTable(w.db);
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',verified_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 const role=security.defaultRoles.find(item=>item.code==="service_provider");assert.ok(role);
 const now=Date.now(),user=w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
 for(const [id,email,provider] of [["C",COMMISSION_EMAIL,COMMISSION],["F",FULL_TIME_EMAIL,FULL_TIME]]){
  user.run("USR-G17-"+id,email,email,role.code,now,now);
  w.sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email,provider,now,now);
 }
 return w;
}
const request=(email,method,body,url=HOST)=>new Request(url,{method,headers:{"content-type":"application/json","oai-authenticated-user-email":email},...(body?{body:JSON.stringify(body)}:{})});
async function put(email,body){const response=await route.PUT(request(email,"PUT",body));let json={};try{json=await response.clone().json();}catch{}return{response,json};}
async function get(email,providerId=COMMISSION){const response=await route.GET(request(email,"GET",null,`${HOST}?providerId=${providerId}&from=2026-10-01&to=2026-10-31`));return{response,json:await response.json()};}
const rows=(w,provider=COMMISSION)=>w.sqlite.prepare("SELECT provider_id,date,zone_id,windows_json,source FROM scheduling_availability WHERE provider_id=? ORDER BY date,zone_id,source").all(provider).map(row=>({...row}));

test("G17 commission provider publishes multiple Open windows and reads them back",async t=>{
 const w=await world(t);
 const saved=await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-12:00","14:00-18:00"]});
 assert.equal(saved.response.status,200,JSON.stringify(saved.json));assert.equal(saved.json.data.source,"partner_app");
 assert.deepEqual(rows(w),[{provider_id:COMMISSION,date:DAY,zone_id:"blr-east",windows_json:'["09:00-12:00","14:00-18:00"]',source:"partner_app"}]);
 const loaded=await get(COMMISSION_EMAIL);assert.equal(loaded.response.status,200);assert.equal(loaded.json.data.editable,true);
 assert.deepEqual(loaded.json.data.days[0],{id:`availability_${COMMISSION}_${DAY}_blr-east`,date:DAY,zoneId:"blr-east",windows:["09:00-12:00","14:00-18:00"],state:"open",source:"partner_app",locked:false,updatedAt:loaded.json.data.days[0].updatedAt});
 const audit=w.sqlite.prepare("SELECT action,resource_id,detail_json FROM security_audit_events WHERE action='provider.calendar.self_set'").get();
 assert.equal(audit.resource_id,COMMISSION);assert.match(audit.detail_json,/"state":"open"/);
});

test("G17 Blocked replaces the provider's own Open row instead of leaving a stale widening row",async t=>{
 const w=await world(t);
 assert.equal((await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-19:00"]})).response.status,200);
 const blocked=await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"blocked",windows:["09:00-19:00"]});
 assert.equal(blocked.response.status,200);assert.equal(blocked.json.data.state,"blocked");assert.deepEqual(blocked.json.data.windows,[]);
 const current=rows(w);assert.equal(current.length,1);assert.equal(current[0].windows_json,"[]");
});

test("G17 self-service cannot widen an Operations or approved-roster date",async t=>{
 const w=await world(t);
 await w.db.prepare("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)").run();
 w.sqlite.prepare("INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?,?,?)").run("OPS-LOCK",COMMISSION,"blr","blr-east",DAY,'["09:00-11:00"]',"operations",1);
 const attempt=await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-19:00"]});
 assert.equal(attempt.response.status,409);assert.match(attempt.json.error,/managed by Operations/);
 assert.deepEqual(rows(w),[{provider_id:COMMISSION,date:DAY,zone_id:"blr-east",windows_json:'["09:00-11:00"]',source:"operations"}]);
});

test("G17 full-time provider cannot use the commission Open / Blocked calendar",async t=>{
 const w=await world(t);
 const result=await put(FULL_TIME_EMAIL,{providerId:FULL_TIME,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-19:00"]});
 assert.equal(result.response.status,409);assert.match(result.json.error,/only for commission providers/);
 assert.deepEqual(rows(w,FULL_TIME),[]);
 const loaded=await get(FULL_TIME_EMAIL,FULL_TIME);assert.equal(loaded.response.status,200);assert.equal(loaded.json.data.editable,false);
});

test("G17 provider ownership blocks cross-provider calendar writes",async t=>{
 const w=await world(t);
 const result=await put(COMMISSION_EMAIL,{providerId:FULL_TIME,date:DAY,zoneId:"blr-east",state:"blocked",windows:[]});
 assert.equal(result.response.status,403);assert.deepEqual(rows(w,FULL_TIME),[]);
});

test("G17 invalid zones and overlapping windows fail closed without writes",async t=>{
 const w=await world(t);
 const badZone=await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-west",state:"open",windows:["09:00-19:00"]});
 assert.equal(badZone.response.status,400);
 const overlap=await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-13:00","12:00-16:00"]});
 assert.equal(overlap.response.status,400);assert.match(overlap.json.error,/cannot overlap/);
 assert.deepEqual(rows(w),[]);
});

test("G17 staff cannot impersonate partner self-service calendar writes",async t=>{
 const w=await world(t),role=security.defaultRoles.find(item=>item.code==="manager");assert.ok(role);
 const now=Date.now(),email="ops-calendar@pawspace.test";
 w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run("USR-G17-OPS",email,email,role.code,now,now);
 const result=await put(email,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-19:00"]});
 assert.equal(result.response.status,403);assert.match(result.json.error,/Operations calendar controls/);assert.deepEqual(rows(w),[]);
});

test("G17 calendar read range is bounded",async t=>{
 await world(t);
 const response=await route.GET(request(COMMISSION_EMAIL,"GET",null,`${HOST}?providerId=${COMMISSION}&from=2026-10-01&to=2027-01-15`));
 const json=await response.json();assert.equal(response.status,400);assert.match(json.error,/limited to 62 days/);
});

test("G17 self-service Blocked/Open writes are consumed by the canonical scheduler",async t=>{
 const w=await world(t),provider=await capacity.getGovernedProvider(w.db,COMMISSION);assert.ok(provider);
 const start=DAY+"T10:00:00+05:30",end=DAY+"T12:00:00+05:30";
 const decide=async()=>{
  const {schedulingCalendarReads}=await import("../lib/scheduling-calendar-reads.ts");
  const {schedule}=await import("../backend/src/scheduling.ts");
  const calendar=schedulingCalendarReads(w.db,"blr",[{start,end}],330);
  const repository={listEligibleProviders:async()=>[provider],listBookings:async()=>[],
   listAvailability:async(id,date)=>(await calendar.availability(id,date)).map(row=>({id:String(row.id),providerId:String(row.provider_id),cityId:String(row.city_id),zoneId:String(row.zone_id),date:String(row.date),windows:JSON.parse(String(row.windows_json)),source:String(row.source),updatedAt:new Date(Number(row.updated_at)).toISOString()})),
   providerUnavailableForWindow:async(id,a,b)=>calendar.unavailable(id,a,b),
   getPet:async id=>({id,customerId:"G17-C",name:"Synthetic",species:"dog",allergies:[],vaccinationStatus:"verified"})};
  return schedule(repository,{cityId:"blr",zoneId:"blr-east",serviceCode:"grooming",petIds:["G17-P"],scheduledStart:start,scheduledEnd:end});
 };
 assert.equal((await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"blocked",windows:[]})).response.status,200);
 assert.equal((await decide()).provider,null);
 assert.equal((await put(COMMISSION_EMAIL,{providerId:COMMISSION,date:DAY,zoneId:"blr-east",state:"open",windows:["09:00-19:00"]})).response.status,200);
 assert.equal((await decide()).provider?.id,COMMISSION);
});
