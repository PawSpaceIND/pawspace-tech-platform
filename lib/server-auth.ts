import { defaultRoles, hasPermission, parsePermissions, type Permission } from "./platform-security";

type Db = Awaited<ReturnType<typeof database>>;
export type AuthenticatedActor = { email:string; name:string; roleCode:string; permissions:string[]; developmentPreview:boolean };

export async function database(){const {env}=await import("cloudflare:workers");return env.DB;}

function forwardedIdentity(request:Request){
  const email=(request.headers.get("oai-authenticated-user-email")||"").trim().toLowerCase();
  const encoded=request.headers.get("oai-authenticated-user-full-name")||"";
  let name=email.split("@")[0]||"Workspace user";
  if(request.headers.get("oai-authenticated-user-full-name-encoding")==="percent-encoded-utf-8"&&encoded){try{name=decodeURIComponent(encoded)}catch{}}
  return {email,name};
}

function isDevelopmentPreview(request:Request){
  const host=new URL(request.url).hostname;
  return process.env.NODE_ENV!=="production"&&["terminal.local","localhost","127.0.0.1"].includes(host);
}

export async function ensureSecurityTables(db:Db){
  const now=Date.now();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS customer_identity_links (email TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
  for(const role of defaultRoles){
    await db.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,system_role=excluded.system_role")
      .bind(role.code,role.name,role.description,JSON.stringify(role.permissions),1,now).run();
  }
}

export async function resolveActor(request:Request):Promise<AuthenticatedActor>{
  const db=await database(); await ensureSecurityTables(db);
  if(isDevelopmentPreview(request))return {email:"preview@pawspace.test",name:"Preview operator",roleCode:"superuser",permissions:["*"],developmentPreview:true};
  const identity=forwardedIdentity(request);
  if(!identity.email)throw new Response("Authentication required",{status:401});
  let user=await db.prepare("SELECT email,name,role_code,status FROM app_users WHERE email=?").bind(identity.email).first<Record<string,unknown>>();
  if(!user){
    const {env}=await import("cloudflare:workers"); const founderEmail=String(env.FOUNDER_EMAIL||"").trim().toLowerCase();
    if(!founderEmail||identity.email!==founderEmail)throw new Response("Access has not been provisioned for this identity",{status:403});
    const now=Date.now(); await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),identity.email,identity.name,"founder","active",now,now).run();
    user={email:identity.email,name:identity.name,role_code:"founder",status:"active"};
  }
  if(user.status!=="active")throw new Response("Identity is disabled",{status:403});
  const role=await db.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(String(user.role_code)).first<{permissions_json:string}>();
  if(!role)throw new Response("Assigned role is unavailable",{status:403});
  return {email:identity.email,name:String(user.name||identity.name),roleCode:String(user.role_code),permissions:parsePermissions(role.permissions_json),developmentPreview:false};
}

export function requirePermission(actor:AuthenticatedActor,permission:Permission){
  if(!hasPermission(actor.permissions,permission))throw new Response("Permission denied",{status:403});
  return actor;
}

export async function authorize(request:Request,permission:Permission){return requirePermission(await resolveActor(request),permission);}

export async function requireCustomerOwnership(db:Db,actor:AuthenticatedActor,customerId:string){
  if(actor.developmentPreview||hasPermission(actor.permissions,"customers.manage")||hasPermission(actor.permissions,"bookings.manage"))return actor;
  const link=await db.prepare("SELECT customer_id,status FROM customer_identity_links WHERE email=?").bind(actor.email).first<Record<string,unknown>>();
  if(!link||link.status!=="active"||String(link.customer_id)!==customerId)throw new Response("Customer ownership denied",{status:403});
  return actor;
}

export async function requireProviderOwnership(db:Db,actor:AuthenticatedActor,providerId:string){
  if(actor.developmentPreview||hasPermission(actor.permissions,"providers.manage")||hasPermission(actor.permissions,"grooming.manage")||hasPermission(actor.permissions,"bookings.manage"))return actor;
  const link=await db.prepare("SELECT provider_id,status FROM provider_identity_links WHERE email=?").bind(actor.email).first<Record<string,unknown>>();
  if(!link||link.status!=="active"||String(link.provider_id)!==providerId)throw new Response("Provider ownership denied",{status:403});
  return actor;
}

export async function securityAudit(db:Db,actor:AuthenticatedActor,action:string,resourceType:string,resourceId:string|null,outcome:"allowed"|"denied"|"completed",detail:unknown={}){
  await db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),actor.email,actor.roleCode,action,resourceType,resourceId,outcome,JSON.stringify(detail),Date.now()).run();
}

export function authError(error:unknown,fallback="Request failed"){
  if(error instanceof Response)return error;
  return Response.json({error:error instanceof Error?error.message:fallback},{status:500});
}
