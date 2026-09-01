import { defaultRoles, hasPermission, parsePermissions, type Permission } from "./platform-security";
import {ensureIdentityBindingTables,findIdentityBinding,type IdentitySource,type PrincipalType} from "./identity-binding";
import {resolvePlatformSession} from "./platform-session";
import {isDevelopmentPreviewRequest} from "./development-preview";
import {resolveUatStaffActor,signInRequiredResponse} from "./uat-staging-auth";
import {governedJsonError,isGovernedHttpError,markGovernedHttpError} from "./governed-http-error";

type Db = Awaited<ReturnType<typeof database>>;
export type AuthenticatedActor = { email:string; name:string; roleCode:string; permissions:string[]; developmentPreview:boolean; identitySource:IdentitySource; principalType:PrincipalType; principalKey:string };

export async function database(){const {env}=await import("cloudflare:workers");return env.DB;}

function forwardedIdentity(request:Request){
  const email=(request.headers.get("oai-authenticated-user-email")||"").trim().toLowerCase();
  const encoded=request.headers.get("oai-authenticated-user-full-name")||"";
  let name=email.split("@")[0]||"Workspace user";
  if(request.headers.get("oai-authenticated-user-full-name-encoding")==="percent-encoded-utf-8"&&encoded){try{name=decodeURIComponent(encoded)}catch{}}
  return {email,name};
}

// One definition, in lib/development-preview.ts. This copy read an ABSENT NODE_ENV as "not
// production", and two sibling copies of the same rule carried no environment guard at all. [PTJA-W3C]
const isDevelopmentPreview=(request:Request)=>isDevelopmentPreviewRequest(request);

// Per-isolate memoization: security DDL, identity-binding DDL and the fixed role catalogue are
// idempotent. resolveActor() runs this on every authenticated request; before this it also issued 9
// sequential role upserts each time. Batching + the WeakSet keep it to a single round-trip once, then
// a no-op for the rest of the isolate's life.
const securityTablesEnsured=new WeakSet<Db>();

export async function ensureSecurityTables(db:Db){
  if(securityTablesEnsured.has(db))return;
  const now=Date.now();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS customer_identity_links (email TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
  await ensureIdentityBindingTables(db);
  await db.batch(defaultRoles.map(role=>db.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,permissions_json=CASE WHEN role_definitions.system_role=1 THEN excluded.permissions_json ELSE role_definitions.permissions_json END,system_role=excluded.system_role,updated_at=excluded.updated_at")
      .bind(role.code,role.name,role.description,JSON.stringify(role.permissions),1,now)));
  securityTablesEnsured.add(db);
}

/** Every governed API failure is JSON, caller-safe, marked, and non-cacheable. */
export function authFailure(message:string,status:number){return governedJsonError({error:message},status);}

export async function resolveActor(request:Request):Promise<AuthenticatedActor>{
  const db=await database(); await ensureSecurityTables(db);
  if(isDevelopmentPreview(request))return {email:"preview@pawspace.test",name:"Preview operator",roleCode:"superuser",permissions:["*"],developmentPreview:true,identitySource:"workspace",principalType:"email",principalKey:"preview@pawspace.test"};
  // Staging-only UAT sign-in (flag-gated; a no-op in production where PAWSPACE_UAT_LOGIN is unset).
  const {env:uatEnv}=await import("cloudflare:workers");
  const uatActor=await resolveUatStaffActor(db,request,uatEnv as Record<string,unknown>);
  if(uatActor)return uatActor;
  const session=await resolvePlatformSession(db,request);
  if(session)return {email:session.auditId,name:`${session.subjectType==="customer"?"Customer":"Provider"} ${session.subjectId}`,roleCode:session.roleCode,permissions:session.permissions,developmentPreview:false,identitySource:session.identitySource,principalType:session.principalType,principalKey:session.principalKey};
  const identity=forwardedIdentity(request);
  if(!identity.email)throw markGovernedHttpError(signInRequiredResponse(uatEnv as unknown as Record<string,unknown>));
  let user=await db.prepare("SELECT email,name,role_code,status FROM app_users WHERE email=?").bind(identity.email).first<Record<string,unknown>>();
  if(!user){
    const {env}=await import("cloudflare:workers"); const founderEmail=String(env.FOUNDER_EMAIL||"").trim().toLowerCase();
    if(!founderEmail||identity.email!==founderEmail)throw authFailure("Access has not been provisioned for this identity",403);
    const now=Date.now(); await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),identity.email,identity.name,"founder","active",now,now).run();
    user={email:identity.email,name:identity.name,role_code:"founder",status:"active"};
  }
  if(user.status!=="active")throw authFailure("Identity is disabled",403);
  const role=await db.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(String(user.role_code)).first<{permissions_json:string}>();
  if(!role)throw authFailure("Assigned role is unavailable",403);
  return {email:identity.email,name:String(user.name||identity.name),roleCode:String(user.role_code),permissions:parsePermissions(role.permissions_json),developmentPreview:false,identitySource:"workspace",principalType:"email",principalKey:identity.email};
}

export function requirePermission(actor:AuthenticatedActor,permission:Permission){
  if(!hasPermission(actor.permissions,permission))throw authFailure("Permission denied",403);
  return actor;
}

export async function authorize(request:Request,permission:Permission){return requirePermission(await resolveActor(request),permission);}

export async function requireCustomerOwnership(db:Db,actor:AuthenticatedActor,customerId:string){
  if(actor.developmentPreview||hasPermission(actor.permissions,"customers.manage")||hasPermission(actor.permissions,"bookings.manage"))return actor;
  const binding=await findIdentityBinding(db,{identitySource:actor.identitySource,principalType:actor.principalType,principalKey:actor.principalKey,subjectType:"customer"});
  if(binding){if(String(binding.subject_id)!==customerId)throw authFailure("Customer ownership denied",403);return actor;}
  const legacy=await db.prepare("SELECT customer_id,status FROM customer_identity_links WHERE email=?").bind(actor.email).first<Record<string,unknown>>();
  if(!legacy||legacy.status!=="active"||String(legacy.customer_id)!==customerId)throw authFailure("Customer ownership denied",403);
  return actor;
}

/**
 * Whether this actor is acting as STAFF over providers, rather than as a provider acting on itself.
 *
 * This is the exact predicate requireProviderOwnership already used to let an operator through, lifted
 * out so callers can tell the two cases apart. Ownership alone does not imply authority: a provider
 * owns its own record and must still not be able to lift a restriction that staff placed on it.
 */
export function actorManagesProviders(actor:AuthenticatedActor){
  return Boolean(actor.developmentPreview)||hasPermission(actor.permissions,"providers.manage")||hasPermission(actor.permissions,"grooming.manage")||hasPermission(actor.permissions,"bookings.manage");
}

export async function requireProviderOwnership(db:Db,actor:AuthenticatedActor,providerId:string){
  if(actorManagesProviders(actor))return actor;
  const binding=await findIdentityBinding(db,{identitySource:actor.identitySource,principalType:actor.principalType,principalKey:actor.principalKey,subjectType:"provider"});
  if(binding){if(String(binding.subject_id)!==providerId)throw authFailure("Provider ownership denied",403);return actor;}
  const legacy=await db.prepare("SELECT provider_id,status FROM provider_identity_links WHERE email=?").bind(actor.email).first<Record<string,unknown>>();
  if(!legacy||legacy.status!=="active"||String(legacy.provider_id)!==providerId)throw authFailure("Provider ownership denied",403);
  return actor;
}

export async function securityAudit(db:Db,actor:AuthenticatedActor,action:string,resourceType:string,resourceId:string|null,outcome:"allowed"|"denied"|"completed"|"rejected"|"blocked",detail:unknown={}){
  await db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),actor.email,actor.roleCode,action,resourceType,resourceId,outcome,JSON.stringify(detail),Date.now()).run();
}

function safeApiErrorMetadata(error:unknown,classification:"unexpected"|"ungoverned_client"){
  if(error instanceof Response)return {event:"api_request_failed",classification,errorType:"Response",status:error.status};
  if(error instanceof Error)return {event:"api_request_failed",classification,errorType:"Error"};
  return {event:"api_request_failed",classification,errorType:typeof error};
}

/** Preserve factory-marked 4xx responses exactly. For legacy unmarked 4xx control responses, preserve only the status and redact the body. */
export function authError(error:unknown,fallback="Request failed"){
  if(error instanceof Response){
    if(isGovernedHttpError(error))return error;
    if(error.status>=400&&error.status<500){
      console.error("[api] request failed",safeApiErrorMetadata(error,"ungoverned_client"));
      return Response.json({error:fallback},{status:error.status,headers:{"cache-control":"no-store"}});
    }
  }
  console.error("[api] request failed",safeApiErrorMetadata(error,"unexpected"));
  return Response.json({error:fallback},{status:500,headers:{"cache-control":"no-store"}});
}
