/**
 * Staging-ONLY UAT sign-in. On the isolated staging worker there is no workspace identity proxy, so
 * protected pages would 401 for a browser tester. This module lets a tester authenticate with a shared
 * access code + an identity, and issues a short-lived signed cookie that resolveActor honours.
 */
import{parsePermissions}from"./platform-security";
import{constantTimeEqual}from"./security-crypto";

type Db=D1Database;
type Row=Record<string,unknown>;
type UatEnv={PAWSPACE_UAT_LOGIN?:unknown;PAWSPACE_UAT_ACCESS_CODE?:unknown;PAWSPACE_UAT_SIGNING_KEY?:unknown};
const COOKIE="pawspace_uat";
const enc=new TextEncoder();

export const UAT_SIGNING_KEY_MIN_LENGTH=32;
export function uatLoginEnabled(env:UatEnv){return String(env?.PAWSPACE_UAT_LOGIN||"")==="on"&&String(env?.PAWSPACE_UAT_SIGNING_KEY||"").length>=UAT_SIGNING_KEY_MIN_LENGTH;}

/**
 * Customer-app API surfaces, listed one path at a time on purpose.
 *
 * A customer authenticates by phone OTP and holds a platform session cookie. They never hold - and
 * can never obtain - the staging STAFF cookie /staging-login issues, so "Your staging sign-in has
 * expired. Open /staging-login to sign in again." was an instruction they could not act on, and
 * /staging-login is the staff UAT switch: it names the internal staff identities it accepts
 * (Founder / Finance / Manager / Employee addresses). Sending an expired customer there was both a
 * dead end and an internal-identity disclosure on a customer-facing error path.
 *
 * Every entry below resolves a CUSTOMER identity server-side (requireCustomerOwnership and/or a
 * customer platform session). Staff CRM surfaces that merely have "customer" in the name -
 * /api/customer-360, /api/customer-contact, /api/customer-data-reveal, /api/customer-targeting,
 * /api/customer-business-view - are deliberately NOT here: a staff tester on those routes still
 * needs the staging remedy. A path is never matched by prefix, for the same reason
 * PROVIDER_SCOPED_API_PATHS in lib/server-auth.ts is not: a route's name does not say who it serves.
 */
export const CUSTOMER_SCOPED_API_PATHS=new Set(["/api/customer-account","/api/customer-billing","/api/customer-checkout","/api/customer-grooming-summary","/api/customer-notifications","/api/customer-offers","/api/customer-profile","/api/customer-reminders","/api/customer-support-case"]);

export function customerScopedRequest(request:Request|null|undefined){
 if(!request)return false;
 let pathname:string;
 try{pathname=new URL(request.url).pathname;}catch{return false;}
 const path=pathname.length>1&&pathname.endsWith("/")?pathname.slice(0,-1):pathname;
 return CUSTOMER_SCOPED_API_PATHS.has(path);
}

/**
 * The remedy an OTP customer can actually act on. It never names /staging-login, never leaks a staff
 * identity, and does NOT vary with the staging flag: a customer has no staging sign-in to expire in
 * either environment, so the same sentence is correct in production and on staging.
 */
export function customerSignInRequiredResponse(){
 return Response.json({error:"Your PawSpace sign-in has expired. Open the PawSpace app and verify your phone number again to continue.",code:"customer_sign_in_required",signInUrl:"/mobile-app"},{status:401,headers:{"cache-control":"no-store"}});
}

/**
 * `request` is optional so every existing caller keeps its exact behaviour; pass it wherever the
 * refusal can reach a customer (lib/server-auth.ts resolvePrimaryActor) and a customer-scoped path
 * gets the customer remedy instead of the staff one.
 */
export function signInRequiredResponse(env:UatEnv,request?:Request|null){
 if(customerScopedRequest(request))return customerSignInRequiredResponse();
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

const uatActorReads=new WeakMap<Db,Map<string,Promise<Row|null>>>();
async function readUatActorRow(db:Db,email:string){
 let byEmail=uatActorReads.get(db);if(!byEmail){byEmail=new Map();uatActorReads.set(db,byEmail);}
 const running=byEmail.get(email);if(running)return running;
 const pending=db.prepare("SELECT u.id,u.name,u.role_code,u.status,r.permissions_json FROM app_users u LEFT JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").bind(email).first<Row>().catch(()=>null)
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
 const row=await db.prepare("SELECT status,role_code FROM app_users WHERE email=?").bind(String(email).trim().toLowerCase()).first<Row>().catch(()=>null);
 if(!row||String(row.status)!=="active")return false;
 const roleCode=String(row.role_code||"").trim();
 if(!roleCode)return false;
 const role=await db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(roleCode).first<Row>().catch(()=>null);
 return Boolean(role);
}
