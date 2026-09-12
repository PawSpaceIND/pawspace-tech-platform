import{constantTimeEqual}from"./security-crypto";

type Db=D1Database;
type Row=Record<string,unknown>;
const COOKIE="pawspace_admin_mfa";
const PRIVILEGED=new Set(["admin","finance"]);
const enc=new TextEncoder();

function b64url(bytes:Uint8Array){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
async function sha256(value:string){const d=await crypto.subtle.digest("SHA-256",enc.encode(value));return b64url(new Uint8Array(d));}
function token(){const b=new Uint8Array(32);crypto.getRandomValues(b);return b64url(b);}
function readCookie(request:Request,name:string){for(const part of (request.headers.get("cookie")||"").split(";")){const[k,...rest]=part.trim().split("=");if(k===name)return decodeURIComponent(rest.join("="));}return"";}
function base32(value:string){const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",clean=value.toUpperCase().replace(/[^A-Z2-7]/g,"");let bits="",out=[] as number[];for(const ch of clean){const n=alphabet.indexOf(ch);if(n<0)throw new Error("Invalid TOTP secret");bits+=n.toString(2).padStart(5,"0");}for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return new Uint8Array(out);}

export function privilegedRole(roleCode:string){return PRIVILEGED.has(String(roleCode).toLowerCase());}
export function adminMfaCookie(value:string,ttlSeconds:number){return`${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(60,ttlSeconds)}`;}
export function clearAdminMfaCookie(){return`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;}
export async function totpCode(secret:string,at=Date.now()){
 const counter=Math.floor(at/30000),msg=new Uint8Array(8);let n=counter;for(let i=7;i>=0;i--){msg[i]=n&255;n=Math.floor(n/256);}
 const key=await crypto.subtle.importKey("raw",base32(secret),{name:"HMAC",hash:"SHA-1"},false,["sign"]),sig=new Uint8Array(await crypto.subtle.sign("HMAC",key,msg)),offset=sig[sig.length-1]&15;
 const bin=((sig[offset]&127)<<24)|(sig[offset+1]<<16)|(sig[offset+2]<<8)|sig[offset+3];return String(bin%1000000).padStart(6,"0");
}
export async function verifyTotp(secret:string,code:string,at=Date.now()){for(const drift of[-30000,0,30000])if(constantTimeEqual(await totpCode(secret,at+drift),String(code)))return true;return false;}

export async function issuePrivilegedSession(db:Db,userId:string,ttlSeconds=28800){const raw=token(),hash=await sha256(raw),now=Date.now(),ttl=Math.min(Math.max(ttlSeconds,300),28800),id=`mfa_${crypto.randomUUID()}`;await db.prepare("INSERT INTO active_sessions(id,user_id,token_hash,mfa_verified_at,issued_at,expires_at,revoked_at,revoke_reason) VALUES (?,?,?,?,?,?,NULL,NULL)").bind(id,userId,hash,now,now,now+ttl*1000).run();return{token:raw,ttlSeconds:ttl,id};}
export async function hasValidPrivilegedSession(db:Db,request:Request,userId:string){const raw=readCookie(request,COOKIE);if(!raw)return false;const hash=await sha256(raw),row=await db.prepare("SELECT id FROM active_sessions WHERE user_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>? LIMIT 1").bind(userId,hash,Date.now()).first<Row>();return Boolean(row);}
export async function revokeAllPrivilegedSessions(db:Db,userId:string,reason="security_revoke_all"){const now=Date.now(),result=await db.prepare("UPDATE active_sessions SET revoked_at=?,revoke_reason=? WHERE user_id=? AND revoked_at IS NULL").bind(now,reason,userId).run();return{revoked:Number(result.meta?.changes||0),revokedAt:now};}
