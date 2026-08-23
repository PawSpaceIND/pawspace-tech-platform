// Scheduling rules are operations configuration: they decide how work is allocated, so a read
// exposes allocation logic and a write changes it for every future booking.
//
// The worker gateway already maps this path (lib/api-gateway.ts) to scheduling.view for GET and
// scheduling.manage for writes, and refuses an anonymous caller before the route runs. This route
// had no check of its own, which made that gateway entry a single point of failure: one edit to the
// allowlist or the map and the handler would happily serve and mutate for anybody. Its sibling on
// the same permission, /api/provider-capacity-control, carries the route-level check as well, so
// this is that convention applied here - the same permissions the gateway already declares, asserted
// a second time at the boundary, before any read or write of scheduling configuration.
import{authError,authorize}from"../../../lib/server-auth";

async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
const response=(data:unknown,status=200)=>Response.json(data,{status});
const scheduleRuleFields=new Set(["rating","qualityScore","model","providerId","zone","capacity"]);
const scheduleRuleOperators=new Set(["eq","neq","gte","lte","in","not_in"]);
function validScheduleRule(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const rule=value as Record<string,unknown>,expected=rule.value;
  return typeof rule.code==="string"&&Boolean(rule.code.trim())&&typeof rule.field==="string"&&scheduleRuleFields.has(rule.field)&&typeof rule.operator==="string"&&scheduleRuleOperators.has(rule.operator)&&(typeof expected==="string"||(typeof expected==="number"&&Number.isFinite(expected))||(Array.isArray(expected)&&expected.every(item=>typeof item==="string")));
}
// SCHEMA OWNERSHIP. Nothing owned this table. The only CREATE TABLE for scheduling_rules lives in
// app/api/uat-scheduling/route.ts, so on a fresh database an authorized operator got
// 500 "Unable to load scheduling rules" from a route that is otherwise working correctly - the read
// simply had no table to read. There is no migrations/ directory in this repository; routes bootstrap
// their own schema, which is the convention followed here.
//
// The write paths ensure the table, because DDL on a write is unremarkable. The read deliberately
// does NOT: tests/d7-read-side-effects.test.mjs holds reads to creating nothing at all on a cold
// database, so GET reports an empty rule set instead of bootstrapping. That keeps both contracts -
// a cold read is side-effect free, and a cold write still succeeds.
const SCHEDULING_RULES_DDL="CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL DEFAULT 100,condition_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
async function ensureSchedulingRulesTable(db:D1Database){await db.prepare(SCHEDULING_RULES_DDL).run();}
async function schedulingRulesTableExists(db:D1Database){const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_rules'").first<{name?:string}>();return Boolean(row?.name);}
export async function GET(request:Request){try{await authorize(request,"scheduling.view");const db=await database();if(!await schedulingRulesTableExists(db))return response({data:[]});const result=await db.prepare("SELECT * FROM scheduling_rules ORDER BY priority ASC, updated_at DESC").all();return response({data:result.results});}catch(error){return authError(error,"Unable to load scheduling rules");}}
export async function POST(request:Request){try{const actor=await authorize(request,"scheduling.manage");const db=await database();await ensureSchedulingRulesTable(db);const body=await request.json() as {name?:unknown;serviceCode?:string;cityId?:string;zoneId?:string;priority?:number;conditions?:unknown};if(typeof body.name!=="string"||!body.name.trim()||!Array.isArray(body.conditions)||body.conditions.length===0||!body.conditions.every(validScheduleRule))return response({error:"Rule name and valid conditions are required"},400);const id=`rule_${crypto.randomUUID().slice(0,12)}`;const now=Date.now();
  // created_by is the verified actor, never a caller-supplied field: once the request is authorized
  // there is a real identity to attribute the change to, and trusting the body for it recorded
  // whatever the caller typed.
  await db.prepare("INSERT INTO scheduling_rules (id,name,service_code,city_id,zone_id,priority,condition_json,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id,body.name,body.serviceCode??null,body.cityId??"blr",body.zoneId??null,body.priority??100,JSON.stringify(body.conditions),1,actor.email,now,now).run();return response({data:{id,name:body.name,active:true}},201);}catch(error){return authError(error,"Unable to create scheduling rule");}}
export async function PATCH(request:Request){try{await authorize(request,"scheduling.manage");const db=await database();await ensureSchedulingRulesTable(db);const body=await request.json() as {id?:string;active?:unknown;name?:string;priority?:number};if(!body.id)return response({error:"Rule ID is required"},400);if(body.active!==undefined&&typeof body.active!=="boolean")return response({error:"Rule active must be a boolean"},400);await db.prepare("UPDATE scheduling_rules SET active=COALESCE(?,active),name=COALESCE(?,name),priority=COALESCE(?,priority),updated_at=? WHERE id=?").bind(body.active===undefined?null:body.active?1:0,body.name??null,body.priority??null,Date.now(),body.id).run();return response({data:{id:body.id,updated:true}});}catch(error){return authError(error,"Unable to update scheduling rule");}}
export async function DELETE(request:Request){try{await authorize(request,"scheduling.manage");const db=await database();await ensureSchedulingRulesTable(db);const id=new URL(request.url).searchParams.get("id");if(!id)return response({error:"Rule ID is required"},400);await db.prepare("DELETE FROM scheduling_rules WHERE id=?").bind(id).run();return response({data:{id,deleted:true}});}catch(error){return authError(error,"Unable to delete scheduling rule");}}
