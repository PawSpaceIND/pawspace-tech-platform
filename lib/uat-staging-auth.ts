/**
 * Staging-ONLY UAT sign-in. On the isolated staging worker there is no workspace identity proxy, so
 * protected pages would 401 for a browser tester. This module lets a tester authenticate with a shared
 * access code + an identity, and issues a short-lived signed cookie that resolveActor honours.
 */
import{parsePermissions}from"./platform-security";
import{constantTimeEqual}from"./security-crypto";
import{isTransientD1Refusal}from"./d1-transient";

type Db=D1Database;
type Row=Record<string,unknown>;
type UatEnv={PAWSPACE_UAT_LOGIN?:unknown;PAWSPACE_UAT_ACCESS_CODE?:unknown;PAWSPACE_UAT_SIGNING_KEY?:unknown};
const COOKIE="pawspace_uat";
const enc=new TextEncoder();

export const UAT_SIGNING_KEY_MIN_LENGTH=32;
export function uatLoginEnabled(env:UatEnv){return String(env?.PAWSPACE_UAT_LOGIN||"")==="on"&&String(env?.PAWSPACE_UAT_SIGNING_KEY||"").length>=UAT_SIGNING_KEY_MIN_LENGTH;}

export function signInRequiredResponse(env:UatEnv){
 if(!uatLoginEnabled(env))return Response.json({error:"Authentication required"},{status:401});
 return Response.json({error:"Your staging sign-in has expired. Open /staging-login to sign in again.",code:"sign_in_required",signInUrl:"/staging-login"},{status:401,headers:{"cache-control":"no-store"}});
}
export function uatAccessCodeValid(env:UatEnv,code:unknown){const expected=String(env?.PAWSPACE_UAT_ACCESS_CODE||"");return expected.length>0&&constantTimeEqual(String(code||""),expected);}

function b64url(bytes:Uint8Array){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function b64urlToStr(s:string){const b64=s.replace(/-/g,"+").replace(/_/g,"/");return atob(b64);}
async function hmac(key:string,msg:string){const k=await crypto.subtle.importKey("raw",enc.encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const sig=await crypto.subtle.sign("HMAC",k,enc.encode(msg));return b64url(new Uint8Array(sig));}

export async function issueUatToken(env:UatEnv,email:string,ttlSeconds:number){
 const exp=Date.now()+Math.max(60,ttlSeconds)*1000;
 const payload=b64url(enc.encode(JSON.stringify({email:String(email).trim().toLowerCase(),exp})));
 const sig=await hmac(String(env.PAWSPACE_UAT_SIGNING_KEY),payload);
 return`${payload}.${sig}`;
}
export function uatCookie(token:string,ttlSeconds:number){return`${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(60,ttlSeconds)}`;}
export function clearUatCookie(){return`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;}

function readCookie(request:Request,name:string){const raw=request.headers.get("cookie")||"";for(const part of raw.split(";")){const [k,...rest]=part.trim().split("=");if(k===name)return decodeURIComponent(rest.join("="));}return"";}

async function verifyUatToken(env:UatEnv,token:string):Promise<string|null>{
 const [payload,sig]=String(token).split(".");
 if(!payload||!sig)return null;
 const expect=await hmac(String(env.PAWSPACE_UAT_SIGNING_KEY),payload);
 if(!constantTimeEqual(expect,sig))return null;
 let obj:Row;try{obj=JSON.parse(b64urlToStr(payload)) as Row;}catch{return null;}
 if(!obj||typeof obj.email!=="string"||Number(obj.exp||0)<Date.now())return null;
 return obj.email;
}

/** A failed directory read is not proof that the staff identity is absent. Swallowing it let
 * a valid Founder cookie fall through to a customer/partner cookie and become "Permission denied".
 * Retry only a recognised pre-execution D1 refusal, only this SELECT, and only once. Persistent or
 * unexpected errors must propagate to the error boundary, never become a different identity.
 */
async function readStaffDirectory<T>(read:()=>Promise<T>):Promise<T>{
 try{return await read();}catch(error){
  if(!isTransientD1Refusal(error))throw error;
  await new Promise(resolve=>setTimeout(resolve,150));
  return read();
 }
}

const uatActorReads=new WeakMap<Db,Map<string,Promise<Row|null>>>();
async function readUatActorRow(db:Db,email:string){
 let byEmail=uatActorReads.get(db);if(!byEmail){byEmail=new Map();uatActorReads.set(db,byEmail);}
 const running=byEmail.get(email);if(running)return running;
 const pending=readStaffDirectory(()=>db.prepare("SELECT u.id,u.name,u.role_code,u.status,r.permissions_json FROM app_users u LEFT JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").bind(email).first<Row>())
  .finally(()=>{if(byEmail!.get(email)===pending)byEmail!.delete(email);});
 byEmail.set(email,pending);return pending;
}

export async function resolveUatStaffActor(db:Db,request:Request,env:UatEnv){
 if(!uatLoginEnabled(env))return null;
 const token=readCookie(request,COOKIE);
 if(!token)return null;
 const email=await verifyUatToken(env,token);
 if(!email)return null;
 const user=await readUatActorRow(db,email);
 if(!user||String(user.status)!=="active")return null;
 const roleCode=String(user.role_code||"").trim();
 if(!roleCode||user.permissions_json===null||user.permissions_json===undefined)return null;
 const permissions=parsePermissions(user.permissions_json);
 return{userId:String(user.id),email,name:String(user.name||email),roleCode,permissions,developmentPreview:false,identitySource:"workspace" as const,principalType:"email" as const,principalKey:email};
}

export async function uatStaffIdentityAllowed(db:Db,email:string){
 const row=await readStaffDirectory(()=>db.prepare("SELECT status,role_code FROM app_users WHERE email=?").bind(String(email).trim().toLowerCase()).first<Row>());
 if(!row||String(row.status)!=="active")return false;
 const roleCode=String(row.role_code||"").trim();
 if(!roleCode)return false;
 const role=await readStaffDirectory(()=>db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(roleCode).first<Row>());
 return Boolean(role);
}
