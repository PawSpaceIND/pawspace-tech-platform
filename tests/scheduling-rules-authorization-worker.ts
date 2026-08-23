import{DELETE as deleteRule,GET as getRules,PATCH as patchRule,POST as postRule}from"../app/api/scheduling-rules/route";
import{ensureSecurityTables}from"../lib/server-auth";
import{upsertIdentityBinding}from"../lib/identity-binding";
import{issuePlatformSession,platformSessionCookie}from"../lib/platform-session";

type Env={DB:D1Database};
type Rule={id:string;name:string;priority:number;active:number};
const baseUrl="https://api.pawspace.test/api/scheduling-rules";

async function setup(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL,condition_json TEXT NOT NULL,active INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
 await ensureSecurityTables(db);const now=Date.now();
 await db.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('auth_manager','manager@pawspace.test','Scheduling Manager','manager','active',?,?)").bind(now,now).run();
 await db.prepare("DELETE FROM scheduling_rules").run();
 await db.prepare("INSERT INTO scheduling_rules (id,name,service_code,city_id,zone_id,priority,condition_json,active,created_by,created_at,updated_at) VALUES ('rule_existing','Original rule','pet_sitting','blr',NULL,50,'[{}]',1,'seed',?,?)").bind(now,now).run();
 const providerBinding=await upsertIdentityBinding(db,{identitySource:"partner_otp",principalType:"identity_subject",principalKey:"provider-auth-proof",subjectType:"provider",subjectId:"provider-auth-proof",actorId:"test",reason:"scheduling rules auth proof"});
 const providerSession=await issuePlatformSession(db,{bindingId:String(providerBinding?.id),identitySource:"partner_otp",principalType:"identity_subject",principalKey:"provider-auth-proof",subjectType:"provider",subjectId:"provider-auth-proof"});
 const customerBinding=await upsertIdentityBinding(db,{identitySource:"customer_otp",principalType:"identity_subject",principalKey:"customer-auth-proof",subjectType:"customer",subjectId:"customer-auth-proof",actorId:"test",reason:"scheduling rules auth proof"});
 const customerSession=await issuePlatformSession(db,{bindingId:String(customerBinding?.id),identitySource:"customer_otp",principalType:"identity_subject",principalKey:"customer-auth-proof",subjectType:"customer",subjectId:"customer-auth-proof"});
 return{providerCookie:platformSessionCookie(providerSession.token,providerSession.ttlSeconds).split(";")[0],customerCookie:platformSessionCookie(customerSession.token,customerSession.ttlSeconds).split(";")[0]};
}
function req(method:string,body?:unknown,headers:Record<string,string>={},suffix=""){return new Request(`${baseUrl}${suffix}`,{method,headers:{...(body?{"content-type":"application/json"}:{}),...headers},body:body?JSON.stringify(body):undefined});}
async function row(db:D1Database,id:string){return db.prepare("SELECT id,name,priority,active FROM scheduling_rules WHERE id=?").bind(id).first<Rule>();}
async function count(db:D1Database){const value=await db.prepare("SELECT COUNT(*) count FROM scheduling_rules").first<{count:number}>();return Number(value?.count||0);}
async function expectDenied(response:Response,label:string){if(response.status!==401&&response.status!==403)throw new Error(`${label} expected 401/403, got ${response.status}`);let body:unknown;try{body=await response.clone().json();}catch{throw new Error(`${label} denial was not JSON`);}if(!body||typeof body!=="object"||typeof (body as {error?:unknown}).error!=="string"||"data" in body)throw new Error(`${label} denial was not a governed authorization error: ${JSON.stringify(body)}`);const serialized=JSON.stringify(body);if(serialized.includes("rule_existing")||serialized.includes("Original rule"))throw new Error(`${label} denial leaked scheduling rule data`);}
async function assertBaseline(db:D1Database,before:Rule|null,beforeCount:number,label:string){const current=await row(db,"rule_existing");if(await count(db)!==beforeCount||JSON.stringify(current)!==JSON.stringify(before))throw new Error(`${label} changed scheduling-rule persistence: ${JSON.stringify(current)}`);}
async function deniedMutations(db:D1Database,headers:Record<string,string>,label:string,before:Rule|null,beforeCount:number){
 const post=await postRule(req("POST",{name:`${label} insert`,conditions:[{}]},headers));await expectDenied(post,`${label} POST`);await assertBaseline(db,before,beforeCount,`${label} POST`);
 const patch=await patchRule(req("PATCH",{id:"rule_existing",name:`${label} patch`,priority:999},headers));await expectDenied(patch,`${label} PATCH`);await assertBaseline(db,before,beforeCount,`${label} PATCH`);
 const del=await deleteRule(req("DELETE",undefined,headers,"?id=rule_existing"));await expectDenied(del,`${label} DELETE`);await assertBaseline(db,before,beforeCount,`${label} DELETE`);
}
async function publicRead(headers:Record<string,string>,label:string){const response=await getRules(req("GET",undefined,headers));if(response.status!==200)throw new Error(`${label} GET changed from public/read behavior: ${response.status}`);const body=await response.json() as {data?:Array<{id?:string}>};if(!body.data?.some(rule=>rule.id==="rule_existing"))throw new Error(`${label} GET did not return the existing rule`);}
async function run(db:D1Database){
 const sessions=await setup(db);const before=await row(db,"rule_existing");const beforeCount=await count(db);
 await publicRead({},"anonymous");await deniedMutations(db,{},"anonymous",before,beforeCount);
 const providerHeaders={cookie:sessions.providerCookie};await publicRead(providerHeaders,"provider");await deniedMutations(db,providerHeaders,"provider",before,beforeCount);
 const customerHeaders={cookie:sessions.customerCookie};await publicRead(customerHeaders,"customer");await deniedMutations(db,customerHeaders,"customer",before,beforeCount);
 const managerHeaders={"oai-authenticated-user-email":"manager@pawspace.test","oai-authenticated-user-full-name":"Scheduling%20Manager","oai-authenticated-user-full-name-encoding":"percent-encoded-utf-8"};
 await publicRead(managerHeaders,"manager");
 const managerPost=await postRule(req("POST",{name:"Manager insert",conditions:[{}]},managerHeaders));if(managerPost.status!==201)throw new Error(`manager POST failed: ${managerPost.status}`);const created=await managerPost.json() as {data?:{id?:string}};const createdId=String(created.data?.id||"");if(!createdId||!await row(db,createdId))throw new Error("manager POST did not persist");
 const managerPatch=await patchRule(req("PATCH",{id:createdId,name:"Manager patched",priority:7},managerHeaders));if(managerPatch.status!==200)throw new Error(`manager PATCH failed: ${managerPatch.status}`);const patched=await row(db,createdId);if(patched?.name!=="Manager patched"||Number(patched.priority)!==7)throw new Error("manager PATCH did not persist expected values");
 const managerDelete=await deleteRule(req("DELETE",undefined,managerHeaders,`?id=${createdId}`));if(managerDelete.status!==200)throw new Error(`manager DELETE failed: ${managerDelete.status}`);if(await row(db,createdId))throw new Error("manager DELETE did not remove rule");
 return{ok:true,readBehavior:"unchanged-public",writePermission:"scheduling.manage",anonymousWritesDeniedAndUnchanged:true,providerWritesDeniedAndUnchanged:true,customerWritesDeniedAndUnchanged:true,managerWritesAllowed:true};
}
export default{async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==="/health")return Response.json({ok:true});if(path!=="/run")return new Response("Not found",{status:404});try{return Response.json(await run(env.DB));}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null},{status:500});}}};
