import{DELETE as deleteRule,GET as getRules,PATCH as patchRule,POST as postRule}from"../app/api/scheduling-rules/route";
import{ensureSecurityTables}from"../lib/server-auth";
import{upsertIdentityBinding}from"../lib/identity-binding";
import{issuePlatformSession,platformSessionCookie}from"../lib/platform-session";

type Env={DB:D1Database};
type Rule={id:string;name:string;priority:number;active:number};
const baseUrl="https://api.pawspace.test/api/scheduling-rules";

async function setup(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL,condition_json TEXT NOT NULL,active INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
 await ensureSecurityTables(db);
 const now=Date.now();
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
function expectDenied(response:Response,label:string){if(response.status!==401&&response.status!==403)throw new Error(`${label} expected 401/403, got ${response.status}`);}
async function run(db:D1Database){
 const sessions=await setup(db);const before=await row(db,"rule_existing");const beforeCount=await count(db);
 const anonymousGet=await (getRules as unknown as (request:Request)=>Promise<Response>)(req("GET"));expectDenied(anonymousGet,"anonymous GET");
 const anonymousPost=await postRule(req("POST",{name:"Anonymous insert",conditions:[{}]}));expectDenied(anonymousPost,"anonymous POST");if(await count(db)!==beforeCount)throw new Error("anonymous POST changed persistence");
 const anonymousPatch=await patchRule(req("PATCH",{id:"rule_existing",name:"Anonymous patch",priority:999}));expectDenied(anonymousPatch,"anonymous PATCH");const afterPatch=await row(db,"rule_existing");if(JSON.stringify(afterPatch)!==JSON.stringify(before))throw new Error(`anonymous PATCH changed persistence: ${JSON.stringify(afterPatch)}`);
 const anonymousDelete=await deleteRule(req("DELETE",undefined,{},"?id=rule_existing"));expectDenied(anonymousDelete,"anonymous DELETE");if(!await row(db,"rule_existing"))throw new Error("anonymous DELETE removed persisted rule");
 const providerGet=await (getRules as unknown as (request:Request)=>Promise<Response>)(req("GET",undefined,{cookie:sessions.providerCookie}));if(providerGet.status!==200)throw new Error(`provider scheduling.view GET failed: ${providerGet.status}`);
 for(const [label,response] of [
  ["provider POST",await postRule(req("POST",{name:"Provider insert",conditions:[{}]},{cookie:sessions.providerCookie}))],
  ["provider PATCH",await patchRule(req("PATCH",{id:"rule_existing",name:"Provider patch"},{cookie:sessions.providerCookie}))],
  ["provider DELETE",await deleteRule(req("DELETE",undefined,{cookie:sessions.providerCookie},"?id=rule_existing"))],
 ] as const)expectDenied(response,label);
 const customerGet=await (getRules as unknown as (request:Request)=>Promise<Response>)(req("GET",undefined,{cookie:sessions.customerCookie}));expectDenied(customerGet,"customer GET");
 const managerHeaders={"oai-authenticated-user-email":"manager@pawspace.test","oai-authenticated-user-full-name":"Scheduling%20Manager","oai-authenticated-user-full-name-encoding":"percent-encoded-utf-8"};
 const managerGet=await (getRules as unknown as (request:Request)=>Promise<Response>)(req("GET",undefined,managerHeaders));if(managerGet.status!==200)throw new Error(`manager GET failed: ${managerGet.status}`);
 const managerPost=await postRule(req("POST",{name:"Manager insert",conditions:[{}]},managerHeaders));if(managerPost.status!==201)throw new Error(`manager POST failed: ${managerPost.status}`);const created=await managerPost.json() as {data?:{id?:string}};const createdId=String(created.data?.id||"");if(!createdId||!await row(db,createdId))throw new Error("manager POST did not persist");
 const managerPatch=await patchRule(req("PATCH",{id:createdId,name:"Manager patched",priority:7},managerHeaders));if(managerPatch.status!==200)throw new Error(`manager PATCH failed: ${managerPatch.status}`);const patched=await row(db,createdId);if(patched?.name!=="Manager patched"||Number(patched.priority)!==7)throw new Error("manager PATCH did not persist expected values");
 const managerDelete=await deleteRule(req("DELETE",undefined,managerHeaders,`?id=${createdId}`));if(managerDelete.status!==200)throw new Error(`manager DELETE failed: ${managerDelete.status}`);if(await row(db,createdId))throw new Error("manager DELETE did not remove rule");
 return{ok:true,permissions:{read:"scheduling.view",write:"scheduling.manage"},anonymousPersistenceUnchanged:true,providerReadAllowed:true,providerWritesDenied:true,customerReadDenied:true,managerAllMethodsAllowed:true};
}
export default{async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==="/health")return Response.json({ok:true});if(path!=="/run")return new Response("Not found",{status:404});try{return Response.json(await run(env.DB));}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null},{status:500});}}};
