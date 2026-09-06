import{defaultRoles}from"./platform-security";
import{ensureIdentityBindingTables,type IdentitySource,type IdentitySubjectType,type PrincipalType}from"./identity-binding";

type Row=Record<string,unknown>;
export const PLATFORM_SESSION_COOKIE="pawspace_identity_session";

export type PlatformSessionActor={sessionId:string;bindingId:string;identitySource:IdentitySource;principalType:PrincipalType;principalKey:string;subjectType:IdentitySubjectType;subjectId:string;roleCode:"customer"|"service_provider";permissions:string[];expiresAt:number;auditId:string};

let stagingRuntimePromise:Promise<boolean>|undefined;
async function stagingRuntime(){stagingRuntimePromise??=import("cloudflare:workers").then(({env})=>String((env as unknown as Record<string,unknown>).PAWSPACE_DEPLOYMENT_ENV||"").trim().toLowerCase()==="staging").catch(()=>false);return stagingRuntimePromise;}

/** On staging these tables are deployment-owned; customer auth must not run DDL on every request. */
export async function ensurePlatformSessionTables(db:D1Database){if(await stagingRuntime())return;await ensureIdentityBindingTables(db);await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS platform_identity_sessions (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,binding_id TEXT NOT NULL,identity_source TEXT NOT NULL,principal_type TEXT NOT NULL,principal_key TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,revoked_at INTEGER,metadata_json TEXT NOT NULL DEFAULT '{}')"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_platform_identity_sessions_subject ON platform_identity_sessions(subject_type,subject_id,status,expires_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS platform_identity_session_audit (id TEXT PRIMARY KEY,session_id TEXT,action TEXT NOT NULL,identity_source TEXT,subject_type TEXT,subject_id TEXT,outcome TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

function rolePermissions(roleCode:"customer"|"service_provider"){const role=defaultRoles.find(item=>item.code===roleCode);return role?[...role.permissions]:[];}
function bytesToBase64Url(bytes:Uint8Array){let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");}
async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return bytesToBase64Url(new Uint8Array(digest));}
function sessionToken(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return bytesToBase64Url(bytes);}
function cookieValue(request:Request,name:string){const source=request.headers.get("cookie")||"";for(const part of source.split(";")){const [key,...rest]=part.trim().split("=");if(key===name)return decodeURIComponent(rest.join("="));}return "";}

export function platformSessionCookie(token:string,ttlSeconds:number){return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1,Math.floor(ttlSeconds))}`;}
export function clearPlatformSessionCookie(){return `${PLATFORM_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;}

export async function issuePlatformSession(db:D1Database,input:{bindingId:string;identitySource:IdentitySource;principalType:PrincipalType;principalKey:string;subjectType:IdentitySubjectType;subjectId:string;ttlSeconds?:number;metadata?:Record<string,unknown>}){await ensurePlatformSessionTables(db);const roleCode=input.subjectType==="customer"?"customer":"service_provider",ttl=Math.min(Math.max(Number(input.ttlSeconds||28_800),900),86_400),issuedAt=Date.now(),expiresAt=issuedAt+ttl*1000,token=sessionToken(),tokenHash=await sha256(token),id=`sess_${crypto.randomUUID().slice(0,16)}`;await db.batch([
  db.prepare("UPDATE platform_identity_sessions SET status='superseded',revoked_at=? WHERE subject_type=? AND subject_id=? AND status='active'").bind(issuedAt,input.subjectType,input.subjectId),
  // token_hash is the second column and must be the second bound value. The prior bind omitted it,
  // leaving 13 placeholders with 12 values and causing OTP verification/session issuance to fail with
  // D1_ERROR: Wrong number of parameter bindings under the pilot identity swarm.
  db.prepare("INSERT INTO platform_identity_sessions (id,token_hash,binding_id,identity_source,principal_type,principal_key,subject_type,subject_id,role_code,status,issued_at,expires_at,last_seen_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?,?)").bind(id,tokenHash,input.bindingId,input.identitySource,input.principalType,input.principalKey,input.subjectType,input.subjectId,roleCode,issuedAt,expiresAt,issuedAt,JSON.stringify(input.metadata??{})),
  db.prepare("INSERT INTO platform_identity_session_audit (id,session_id,action,identity_source,subject_type,subject_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,'{}',?)").bind(crypto.randomUUID(),id,"issued",input.identitySource,input.subjectType,input.subjectId,"completed",issuedAt),
]);return{token,ttlSeconds:ttl,session:{id,bindingId:input.bindingId,identitySource:input.identitySource,principalType:input.principalType,principalKey:input.principalKey,subjectType:input.subjectType,subjectId:input.subjectId,roleCode,issuedAt,expiresAt}};}

export async function resolvePlatformSession(db:D1Database,request:Request):Promise<PlatformSessionActor|null>{const token=cookieValue(request,PLATFORM_SESSION_COOKIE);if(!token)return null;await ensurePlatformSessionTables(db);const tokenHash=await sha256(token),now=Date.now();const row=await db.prepare("SELECT s.*,b.status binding_status,b.verification_state binding_verification,b.expires_at binding_expires,b.subject_id binding_subject_id,b.principal_key binding_principal_key FROM platform_identity_sessions s JOIN identity_bindings b ON b.id=s.binding_id WHERE s.token_hash=? AND s.status='active' AND s.expires_at>? LIMIT 1").bind(tokenHash,now).first<Row>();if(!row)return null;if(row.binding_status!=="active"||row.binding_verification!=="verified"||(row.binding_expires!=null&&Number(row.binding_expires)<=now)||String(row.binding_subject_id)!==String(row.subject_id)||String(row.binding_principal_key)!==String(row.principal_key)){await db.prepare("UPDATE platform_identity_sessions SET status='revoked',revoked_at=? WHERE id=?").bind(now,row.id).run();return null;}const roleCode=String(row.role_code)==="service_provider"?"service_provider":"customer";
 // A per-resolution heartbeat is not an authorization requirement and turns a read-only scheduling auth
 // check into a serialized D1 write. Production retains the existing audit heartbeat. Staging pilot traffic
 // relies on issued_at/expires_at and revocation state, all of which remain fully enforced above.
 if(!await stagingRuntime())await db.prepare("UPDATE platform_identity_sessions SET last_seen_at=? WHERE id=?").bind(now,row.id).run();
 return{sessionId:String(row.id),bindingId:String(row.binding_id),identitySource:String(row.identity_source) as IdentitySource,principalType:String(row.principal_type) as PrincipalType,principalKey:String(row.principal_key),subjectType:String(row.subject_type) as IdentitySubjectType,subjectId:String(row.subject_id),roleCode,permissions:rolePermissions(roleCode),expiresAt:Number(row.expires_at),auditId:`${String(row.subject_type)}:${String(row.subject_id)}`};}

export async function revokePlatformSession(db:D1Database,request:Request,reason="logout"){const actor=await resolvePlatformSession(db,request);if(!actor)return null;const now=Date.now();await db.batch([
  db.prepare("UPDATE platform_identity_sessions SET status='revoked',revoked_at=? WHERE id=?").bind(now,actor.sessionId),
  db.prepare("INSERT INTO platform_identity_session_audit (id,session_id,action,identity_source,subject_type,subject_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?, ?,?)").bind(crypto.randomUUID(),actor.sessionId,"revoked",actor.identitySource,actor.subjectType,actor.subjectId,"completed",JSON.stringify({reason}),now),
]);return actor;}
