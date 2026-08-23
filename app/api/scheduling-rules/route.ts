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
export async function GET(request:Request){try{await authorize(request,"scheduling.view");const db=await database();const result=await db.prepare("SELECT * FROM scheduling_rules ORDER BY priority ASC, updated_at DESC").all();return response({data:result.results});}catch(error){return authError(error,"Unable to load scheduling rules");}}
export async function POST(request:Request){try{const actor=await authorize(request,"scheduling.manage");const db=await database();const body=await request.json() as {name?:string;serviceCode?:string;cityId?:string;zoneId?:string;priority?:number;conditions?:unknown[]};if(!body.name||!body.conditions?.length)return response({error:"Rule name and at least one condition are required"},400);const id=`rule_${crypto.randomUUID().slice(0,12)}`;const now=Date.now();
  // created_by is the verified actor, never a caller-supplied field: once the request is authorized
  // there is a real identity to attribute the change to, and trusting the body for it recorded
  // whatever the caller typed.
  await db.prepare("INSERT INTO scheduling_rules (id,name,service_code,city_id,zone_id,priority,condition_json,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id,body.name,body.serviceCode??null,body.cityId??"blr",body.zoneId??null,body.priority??100,JSON.stringify(body.conditions),1,actor.email,now,now).run();return response({data:{id,name:body.name,active:true}},201);}catch(error){return authError(error,"Unable to create scheduling rule");}}
export async function PATCH(request:Request){try{await authorize(request,"scheduling.manage");const db=await database();const body=await request.json() as {id?:string;active?:boolean;name?:string;priority?:number};if(!body.id)return response({error:"Rule ID is required"},400);await db.prepare("UPDATE scheduling_rules SET active=COALESCE(?,active),name=COALESCE(?,name),priority=COALESCE(?,priority),updated_at=? WHERE id=?").bind(body.active===undefined?null:body.active?1:0,body.name??null,body.priority??null,Date.now(),body.id).run();return response({data:{id:body.id,updated:true}});}catch(error){return authError(error,"Unable to update scheduling rule");}}
export async function DELETE(request:Request){try{await authorize(request,"scheduling.manage");const db=await database();const id=new URL(request.url).searchParams.get("id");if(!id)return response({error:"Rule ID is required"},400);await db.prepare("DELETE FROM scheduling_rules WHERE id=?").bind(id).run();return response({data:{id,deleted:true}});}catch(error){return authError(error,"Unable to delete scheduling rule");}}
