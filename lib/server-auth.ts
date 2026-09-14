import { defaultRoles, hasPermission, parsePermissions, type Permission } from "./platform-security";
import {ensureIdentityBindingTables,findIdentityBinding,type IdentitySource,type IdentitySubjectType,type PrincipalType} from "./identity-binding";
import {resolvePlatformSession} from "./platform-session";
import{ensureAdminMfaTables,hasValidPrivilegedSession,privilegedRole}from"./admin-mfa";
import {isDevelopmentPreviewRequest} from "./development-preview";
import {resolveUatStaffActor,signInRequiredResponse} from "./uat-staging-auth";
import {governedJsonError,isGovernedHttpError,markGovernedHttpError} from "./governed-http-error";
import {resolveTrustedWorkspaceIdentity} from "./trusted-workspace-identity";

type Db = Awaited<ReturnType<typeof database>>;
export type AuthenticatedActor = { userId?:string; email:string; name:string; roleCode:string; permissions:string[]; developmentPreview:boolean; identitySource:IdentitySource; principalType:PrincipalType; principalKey:string; subjectType?:IdentitySubjectType };
export type SecurityAuditOutcome="allowed"|"denied"|"completed"|"rejected"|"blocked";

export async function database(){const {env}=await import("cloudflare:workers");return env.DB;}

const isDevelopmentPreview=(request:Request)=>isDevelopmentPreviewRequest(request);
const securityTablesEnsured=new WeakSet<Db>();

export async function ensureSecurityTables(db:Db){
  if(securityTablesEnsured.has(db))return;
  const now=Date.now();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS security_audit_outbox (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, detail_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', created_at INTEGER NOT NULL, completed_at INTEGER)"),
    db.prepare("CREATE INDEX IF NOT EXISTS security_audit_outbox_status_idx ON security_audit_outbox(status,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS customer_identity_links (email TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
  await ensureIdentityBindingTables(db);
  await db.batch(defaultRoles.map(role=>db.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,permissions_json=CASE WHEN role_definitions.system_role=1 THEN excluded.permissions_json ELSE role_definitions.permissions_json END,system_role=excluded.system_role,updated_at=excluded.updated_at")
      .bind(role.code,role.name,role.description,JSON.stringify(role.permissions),1,now)));
  securityTablesEnsured.add(db);
}

export function authFailure(message:string,status:number){return governedJsonError({error:message},status);}

/**
 * Routes whose handlers gate on requireProviderOwnership. A generic staging-login staff cookie is
 * resolved before the platform session, so on these routes it used to shadow an explicit provider
 * binding: the partner presented the credential the UAT switch had just issued and still got a
 * redacted 403, with no way to make the binding count. Here the explicit binding wins instead.
 * Staff who can actually manage providers keep precedence, so ops/admin behaviour is unchanged,
 * and the effect is confined to these paths so no permission changes anywhere else.
 *
 * Every entry is a route that calls requireProviderOwnership, listed one by one on purpose. An
 * earlier revision matched the /api/provider- and /api/partner- prefixes instead, which also caught
 * twelve routes that do not gate on ownership at all -- among them /api/provider-workspace, which
 * resolves its provider from actor.email and would have seen the synthetic "provider:<id>" address a
 * platform session carries, and /api/partner-otp, the login surface itself. Prefixes are not safe
 * here: a route's name does not say how it authorises. tests/provider-scope-precedence.test.mjs
 * pins this set in BOTH directions against the routes that really call the gate.
 */
export const PROVIDER_SCOPED_API_PATHS=new Set(["/api/boarding-proof","/api/boarding-stays","/api/booking-operations","/api/food-proof","/api/grooming-lifecycle","/api/grooming-payment-sandbox","/api/grooming-route","/api/location-recovery","/api/partner-grooming-jobs","/api/partner-job-feed","/api/provider-assignment-recovery","/api/provider-availability","/api/provider-chat","/api/provider-lms","/api/provider-safety-flag","/api/service-media","/api/service-media/upload","/api/sitting-lifecycle","/api/sitting-proof","/api/taxi-adjustments","/api/taxi-lifecycle","/api/taxi-proof","/api/taxi-recovery","/api/training-provider-earnings","/api/training-session-media","/api/training-sessions","/api/walking-lifecycle","/api/walking-proof","/api/walking-recovery"]);

export function providerScopedRequest(request:Request){
  let pathname:string;
  try{pathname=new URL(request.url).pathname;}catch{return false;}
  const path=pathname.length>1&&pathname.endsWith("/")?pathname.slice(0,-1):pathname;
  return PROVIDER_SCOPED_API_PATHS.has(path);
}

export async function resolvePrimaryActor(request:Request):Promise<AuthenticatedActor>{
  const db=await database(); await ensureSecurityTables(db);
  if(isDevelopmentPreview(request))return {email:"preview@pawspace.test",name:"Preview operator",roleCode:"superuser",permissions:["*"],developmentPreview:true,identitySource:"workspace",principalType:"email",principalKey:"preview@pawspace.test"};
  const {env:uatEnv}=await import("cloudflare:workers");
  const runtime=uatEnv as unknown as Record<string,unknown>;
  const uatActor=await resolveUatStaffActor(db,request,runtime);
  // The staff cookie yields only where provider ownership is the gate, and only to a staff identity
  // that cannot manage providers itself; anything else keeps the staff actor exactly as before.
  const bindingOutranksStaff=Boolean(uatActor)&&providerScopedRequest(request)&&!actorManagesProviders(uatActor!);
  if(uatActor&&!bindingOutranksStaff)return uatActor;
  const session=await resolvePlatformSession(db,request);
  // With a staff cookie also present, only a provider-scoped session may take over a provider route.
  if(session&&uatActor&&session.subjectType!=="provider")return uatActor;
  if(session)return {email:session.auditId,name:`${session.subjectType==="customer"?"Customer":"Provider"} ${session.subjectId}`,roleCode:session.roleCode,permissions:session.permissions,developmentPreview:false,identitySource:session.identitySource,principalType:session.principalType,principalKey:session.principalKey,subjectType:session.subjectType};
  // Provider-scoped route, staff cookie set aside, but no platform session to replace it.
  if(uatActor)return uatActor;
  const identity=resolveTrustedWorkspaceIdentity(request,runtime);
  if(!identity)throw markGovernedHttpError(signInRequiredResponse(runtime));
  const user=await db.prepare("SELECT id,email,name,role_code,status FROM app_users WHERE email=?").bind(identity.email).first<Record<string,unknown>>();
  if(!user)throw authFailure("Access has not been provisioned for this identity",403);
  if(user.status!=="active")throw authFailure("Identity is disabled",403);
  const role=await db.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(String(user.role_code)).first<{permissions_json:string}>();
  if(!role)throw authFailure("Assigned role is unavailable",403);
  return {userId:String(user.id),email:identity.email,name:String(user.name||identity.name),roleCode:String(user.role_code),permissions:parsePermissions(role.permissions_json),developmentPreview:false,identitySource:"workspace",principalType:"email",principalKey:identity.email};
}

function legacyTestMfaCompatibility(){
 try{return typeof process!=="undefined"&&process.env?.NODE_ENV==="test"&&!process.env?.PAWSPACE_DEPLOYMENT_ENV&&process.env?.PAWSPACE_TEST_MFA_COMPAT==="legacy-route-fixtures";}catch{return false;}
}

export async function requirePrivilegedMfa(request:Request,actor:AuthenticatedActor){
 if(actor.developmentPreview||!privilegedRole(actor.roleCode)||legacyTestMfaCompatibility())return actor;
 const db=await database();
 await ensureAdminMfaTables(db);
 const user=actor.userId?await db.prepare("SELECT id,mfa_enabled,mfa_secret FROM app_users WHERE id=?").bind(actor.userId).first<Record<string,unknown>>():await db.prepare("SELECT id,mfa_enabled,mfa_secret FROM app_users WHERE email=?").bind(actor.email).first<Record<string,unknown>>();
 if(!user||Number(user.mfa_enabled)!==1||!String(user.mfa_secret||"").trim())throw authFailure("MFA enrollment required",403);
 actor.userId=String(user.id);
 if(!await hasValidPrivilegedSession(db,request,actor.userId))throw authFailure("MFA required",401);
 return actor;
}

export async function resolveActor(request:Request):Promise<AuthenticatedActor>{return requirePrivilegedMfa(request,await resolvePrimaryActor(request));}

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

function securityAuditDetailJson(detail:unknown){return JSON.stringify(detail)??"null";}

export function securityAuditStatement(db:Db,actor:AuthenticatedActor,action:string,resourceType:string,resourceId:string|null,outcome:SecurityAuditOutcome,detail:unknown={}){
  return db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),actor.email,actor.roleCode,action,resourceType,resourceId,outcome,securityAuditDetailJson(detail),Date.now());
}

export async function securityAudit(db:Db,actor:AuthenticatedActor,action:string,resourceType:string,resourceId:string|null,outcome:SecurityAuditOutcome,detail:unknown={}){
  await securityAuditStatement(db,actor,action,resourceType,resourceId,outcome,detail).run();
}

export async function reserveSecurityAudit(db:Db,actor:AuthenticatedActor,action:string,resourceType:string,resourceId:string|null,detail:unknown={}){
  const id=crypto.randomUUID(),now=Date.now();
  await db.batch([
    db.prepare("INSERT INTO security_audit_outbox (id,actor_email,actor_role,action,resource_type,resource_id,detail_json,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,'reserved',?,NULL)")
      .bind(id,actor.email,actor.roleCode,action,resourceType,resourceId,securityAuditDetailJson(detail),now),
    securityAuditStatement(db,actor,`${action}.reserved`,resourceType,resourceId,"allowed",{operationId:id,...(detail&&typeof detail==="object"?detail as Record<string,unknown>:{detail})}),
  ]);
  return id;
}

export async function completeReservedSecurityAudit(db:Db,actor:AuthenticatedActor,operationId:string,action:string,resourceType:string,resourceId:string|null,outcome:SecurityAuditOutcome,detail:unknown={}){
  const now=Date.now();
  await db.batch([
    securityAuditStatement(db,actor,action,resourceType,resourceId,outcome,{operationId,...(detail&&typeof detail==="object"?detail as Record<string,unknown>:{detail})}),
    db.prepare("UPDATE security_audit_outbox SET status=?,detail_json=?,completed_at=? WHERE id=? AND status='reserved'")
      .bind(outcome,securityAuditDetailJson(detail),now,operationId),
  ]);
}

export function authError(error:unknown,fallback="Request failed"){
  if(error instanceof Response){
    if(isGovernedHttpError(error))return error;
    if(error.status>=400&&error.status<500){
      console.error("[api] ungoverned client error redacted",error);
      return Response.json({error:fallback},{status:error.status,headers:{"cache-control":"no-store"}});
    }
  }
  console.error("[api] unexpected error",error);
  return Response.json({error:fallback},{status:500,headers:{"cache-control":"no-store"}});
}
