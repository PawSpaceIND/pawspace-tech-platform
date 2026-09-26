import{ensureD1Once}from"./d1-ensure-once.js";
import{defaultRoles}from"./platform-security";
import{ensureIdentityBindingTables,type IdentitySource,type IdentitySubjectType,type PrincipalType}from"./identity-binding";

type Row=Record<string,unknown>;
export const PLATFORM_SESSION_COOKIE="pawspace_identity_session";
/** A session is resolved several times per request and on every chat poll; its last-seen time is written at most this often. */
const SESSION_SEEN_WRITE_MS=60_000;

export type PlatformSessionActor={sessionId:string;bindingId:string;identitySource:IdentitySource;principalType:PrincipalType;principalKey:string;subjectType:IdentitySubjectType;subjectId:string;roleCode:"customer"|"service_provider";permissions:string[];expiresAt:number;auditId:string};

export async function ensurePlatformSessionTables(db:D1Database){return ensureD1Once(db,"platform_session_tables",async()=>{await ensureIdentityBindingTables(db);await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS platform_identity_sessions (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,binding_id TEXT NOT NULL,identity_source TEXT NOT NULL,principal_type TEXT NOT NULL,principal_key TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,revoked_at INTEGER,metadata_json TEXT NOT NULL DEFAULT '{}')"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_platform_identity_sessions_subject ON platform_identity_sessions(subject_type,subject_id,status,expires_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS platform_identity_session_audit (id TEXT PRIMARY KEY,session_id TEXT,action TEXT NOT NULL,identity_source TEXT,subject_type TEXT,subject_id TEXT,outcome TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);});}

function rolePermissions(roleCode:"customer"|"service_provider"){const role=defaultRoles.find(item=>item.code===roleCode);return role?[...role.permissions]:[];}
function bytesToBase64Url(bytes:Uint8Array){let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");}
async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return bytesToBase64Url(new Uint8Array(digest));}
function sessionToken(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return bytesToBase64Url(bytes);}
function cookieValue(request:Request,name:string){const source=request.headers.get("cookie")||"";for(const part of source.split(";")){const [key,...rest]=part.trim().split("=");if(key===name)return decodeURIComponent(rest.join("="));}return "";}

export function platformSessionCookie(token:string,ttlSeconds:number){return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1,Math.floor(ttlSeconds))}`;}
export function clearPlatformSessionCookie(){return `${PLATFORM_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;}

export async function issuePlatformSession(db:D1Database,input:{bindingId:string;identitySource:IdentitySource;principalType:PrincipalType;principalKey:string;subjectType:IdentitySubjectType;subjectId:string;ttlSeconds?:number;metadata?:Record<string,unknown>}){await ensurePlatformSessionTables(db);forgetSessions(db,item=>item.subjectType===input.subjectType&&item.subjectId===input.subjectId);const roleCode=input.subjectType==="customer"?"customer":"service_provider",ttl=Math.min(Math.max(Number(input.ttlSeconds||28_800),900),86_400),issuedAt=Date.now(),expiresAt=issuedAt+ttl*1000,token=sessionToken(),tokenHash=await sha256(token),id=`sess_${crypto.randomUUID().slice(0,16)}`;await db.batch([
  db.prepare("UPDATE platform_identity_sessions SET status='superseded',revoked_at=? WHERE subject_type=? AND subject_id=? AND status='active'").bind(issuedAt,input.subjectType,input.subjectId),
  db.prepare("INSERT INTO platform_identity_sessions (id,token_hash,binding_id,identity_source,principal_type,principal_key,subject_type,subject_id,role_code,status,issued_at,expires_at,last_seen_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?,?)").bind(id,tokenHash,input.bindingId,input.identitySource,input.principalType,input.principalKey,input.subjectType,input.subjectId,roleCode,issuedAt,expiresAt,issuedAt,JSON.stringify(input.metadata??{})),
  db.prepare("INSERT INTO platform_identity_session_audit (id,session_id,action,identity_source,subject_type,subject_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,'{}',?)").bind(crypto.randomUUID(),id,"issued",input.identitySource,input.subjectType,input.subjectId,"completed",issuedAt),
]);return{token,ttlSeconds:ttl,session:{id,bindingId:input.bindingId,identitySource:input.identitySource,principalType:input.principalType,principalKey:input.principalKey,subjectType:input.subjectType,subjectId:input.subjectId,roleCode,issuedAt,expiresAt}};}

/* One request resolves its session several times (API gateway, actor, route), and every D1 call costs the
 * customer latency. The result is reused only within that same request, identified by Cloudflare's
 * per-request cf-ray (the gateway's clone carries the same header); another request always reads the
 * session afresh, so a revoked, suspended or expired session stops at once. A request without cf-ray is
 * never cached, and UAT persona sessions depend on the request, so they are never reused either. */
/** Longest a single request is expected to take; entries older than this are dropped. */
const SESSION_MEMO_MS=30_000;
const sessionMemo=new WeakMap<D1Database,Map<string,{at:number;actor:PlatformSessionActor}>>();
function forgetSessions(db:D1Database,match:(actor:PlatformSessionActor)=>boolean){const memo=sessionMemo.get(db);if(!memo)return;for(const [key,entry] of memo)if(match(entry.actor))memo.delete(key);}
export async function resolvePlatformSession(db:D1Database,request:Request):Promise<PlatformSessionActor|null>{const token=cookieValue(request,PLATFORM_SESSION_COOKIE);if(!token)return null;const tokenHash=await sha256(token),now=Date.now(),ray=request.headers.get("cf-ray");if(!ray)return resolvePlatformSessionFromDb(db,request,tokenHash,now);const key=`${ray}:${tokenHash}`;let memo=sessionMemo.get(db);if(!memo){memo=new Map();sessionMemo.set(db,memo);}const hit=memo.get(key);if(hit&&now-hit.at<SESSION_MEMO_MS&&hit.actor.expiresAt>now)return hit.actor;const actor=await resolvePlatformSessionFromDb(db,request,tokenHash,now);if(memo.size>=1000)memo.clear();else for(const [stale,entry] of memo)if(now-entry.at>=SESSION_MEMO_MS)memo.delete(stale);if(actor&&actor.identitySource!=="uat_persona")memo.set(key,{at:now,actor});else memo.delete(key);return actor;}
async function resolvePlatformSessionFromDb(db:D1Database,request:Request,tokenHash:string,now:number):Promise<PlatformSessionActor|null>{await ensurePlatformSessionTables(db);const row=await db.prepare("SELECT s.*,b.status binding_status,b.verification_state binding_verification,b.expires_at binding_expires,b.subject_id binding_subject_id,b.principal_key binding_principal_key FROM platform_identity_sessions s JOIN identity_bindings b ON b.id=s.binding_id WHERE s.token_hash=? AND s.status='active' AND s.expires_at>? LIMIT 1").bind(tokenHash,now).first<Row>();if(!row)return null;if(row.identity_source==="uat_persona"){const {env}=await import("cloudflare:workers");const {uatCustomerTestingEnabled}=await import("./uat-customer-testing");if(!uatCustomerTestingEnabled(request,env as unknown as Record<string,unknown>))return null;}if(row.binding_status!=="active"||row.binding_verification!=="verified"||(row.binding_expires!=null&&Number(row.binding_expires)<=now)||String(row.binding_subject_id)!==String(row.subject_id)||String(row.binding_principal_key)!==String(row.principal_key)){await db.prepare("UPDATE platform_identity_sessions SET status='revoked',revoked_at=? WHERE id=?").bind(now,row.id).run();return null;}const roleCode=String(row.role_code)==="service_provider"?"service_provider":"customer";if(now-Number(row.last_seen_at||0)>=SESSION_SEEN_WRITE_MS)await db.prepare("UPDATE platform_identity_sessions SET last_seen_at=? WHERE id=?").bind(now,row.id).run();return{sessionId:String(row.id),bindingId:String(row.binding_id),identitySource:String(row.identity_source) as IdentitySource,principalType:String(row.principal_type) as PrincipalType,principalKey:String(row.principal_key),subjectType:String(row.subject_type) as IdentitySubjectType,subjectId:String(row.subject_id),roleCode,permissions:rolePermissions(roleCode),expiresAt:Number(row.expires_at),auditId:`${String(row.subject_type)}:${String(row.subject_id)}`};}

export async function revokePlatformSession(db:D1Database,request:Request,reason="logout"){const actor=await resolvePlatformSession(db,request);if(!actor)return null;const now=Date.now();forgetSessions(db,item=>item.sessionId===actor.sessionId);await db.batch([
  db.prepare("UPDATE platform_identity_sessions SET status='revoked',revoked_at=? WHERE id=?").bind(now,actor.sessionId),
  db.prepare("INSERT INTO platform_identity_session_audit (id,session_id,action,identity_source,subject_type,subject_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?, ?,?)").bind(crypto.randomUUID(),actor.sessionId,"revoked",actor.identitySource,actor.subjectType,actor.subjectId,"completed",JSON.stringify({reason}),now),
]);return actor;}
