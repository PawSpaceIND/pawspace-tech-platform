/**
 * Staging-ONLY UAT sign-in. On the isolated staging worker there is no workspace identity proxy, so
 * protected pages would 401 for a browser tester. This module lets a tester authenticate with a shared
 * access code + an identity, and issues a short-lived signed cookie that resolveActor honours.
 *
 * PRODUCTION-SAFE BY CONSTRUCTION: every function is a no-op unless env.PAWSPACE_UAT_LOGIN === "on" AND
 * a signing key is present. Those vars are set ONLY by scripts/stage-config.mjs for the staging build,
 * never in the production config, so this entire path is dead code in production. It never weakens the
 * real identity/session checks — it is an additional, flag-gated branch that only fires on staging.
 *
 * Identity → role: the email MUST resolve to an active row in app_users, and it gets exactly that
 * row's role and that role's permissions. Nothing is synthesised.
 *
 * It used to default an unrecognised email to roleCode "founder" with permissions ["*"], on the
 * reasoning that staging data is synthetic and a tester should be able to reach every admin surface.
 * That made the access code the only thing standing between any email address and full authority over
 * the staging workspace — including the founder-only surfaces, the payroll approvals and the
 * governance controls — and it meant a tester could never verify that a role boundary actually holds,
 * because every identity was a superuser. A tester who needs founder reach signs in as a seeded
 * founder account; one who needs to test an associate's view signs in as a seeded associate.
 */
import{parsePermissions}from"./platform-security";

type Db=D1Database;
type Row=Record<string,unknown>;
type UatEnv={PAWSPACE_UAT_LOGIN?:unknown;PAWSPACE_UAT_ACCESS_CODE?:unknown;PAWSPACE_UAT_SIGNING_KEY?:unknown};
const COOKIE="pawspace_uat";
const enc=new TextEncoder();

/**
 * UAT sign-in is live only when the flag is on AND the signing key clears the same 32-character floor
 * scripts/stage-config.mjs enforces at deploy time. The two used to disagree - the deploy demanded 32,
 * this accepted 16 - so a key too weak to deploy would still have been honoured had it reached the
 * worker by any other route. Below the floor the whole UAT branch is off: fail closed, not "on with a
 * weak key". Production is unaffected either way, because PAWSPACE_UAT_LOGIN is never set there.
 */
export const UAT_SIGNING_KEY_MIN_LENGTH=32;
export function uatLoginEnabled(env:UatEnv){return String(env?.PAWSPACE_UAT_LOGIN||"")==="on"&&String(env?.PAWSPACE_UAT_SIGNING_KEY||"").length>=UAT_SIGNING_KEY_MIN_LENGTH;}

/**
 * The UAT cookie lives for 8 hours (app/api/staging-login/route.ts). When it lapses every gated API
 * answered a bare "Authentication required", so a tester saw team pages render their shell with empty
 * data and no clue that the session - not the page - had ended; each link they clicked led to another
 * dead-looking screen. Where UAT sign-in exists, say so and hand back the route to recover. Production
 * keeps the original body byte-for-byte: this branch cannot fire there (PAWSPACE_UAT_LOGIN is unset).
 */
export function signInRequiredResponse(env:UatEnv){
 if(!uatLoginEnabled(env))return Response.json({error:"Authentication required"},{status:401});
 return Response.json({error:"Your staging sign-in has expired. Open /staging-login to sign in again.",code:"sign_in_required",signInUrl:"/staging-login"},{status:401,headers:{"cache-control":"no-store"}});
}
export function uatAccessCodeValid(env:UatEnv,code:unknown){const expected=String(env?.PAWSPACE_UAT_ACCESS_CODE||"");return expected.length>0&&String(code||"")===expected;}

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
 if(expect!==sig)return null;
 let obj:Row;try{obj=JSON.parse(b64urlToStr(payload)) as Row;}catch{return null;}
 if(!obj||typeof obj.email!=="string"||Number(obj.exp||0)<Date.now())return null;
 return obj.email;
}

// Coalesce only simultaneously in-flight identity reads. Nothing is cached after the read settles, so a
// role/status change is visible to the next request while a 100-way staging burst does not send 100
// byte-identical staff/role lookups to D1.
const uatActorReads=new WeakMap<Db,Map<string,Promise<Row|null>>>();
async function readUatActorRow(db:Db,email:string){
 let byEmail=uatActorReads.get(db);if(!byEmail){byEmail=new Map();uatActorReads.set(db,byEmail);}
 const running=byEmail.get(email);if(running)return running;
 const pending=db.prepare("SELECT u.name,u.role_code,u.status,r.permissions_json FROM app_users u LEFT JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").bind(email).first<Row>().catch(()=>null)
  .finally(()=>{if(byEmail!.get(email)===pending)byEmail!.delete(email);});
 byEmail.set(email,pending);return pending;
}

/**
 * Resolve a staff actor from a valid UAT cookie. Returns null unless UAT login is enabled, the cookie
 * verifies, AND the email is an active app_users row. Fail-closed at every step: an unknown email, a
 * suspended one, or a role with no definition yields no actor and no permissions, never a default.
 */
export async function resolveUatStaffActor(db:Db,request:Request,env:UatEnv){
 if(!uatLoginEnabled(env))return null;
 const token=readCookie(request,COOKIE);
 if(!token)return null;
 const email=await verifyUatToken(env,token);
 if(!email)return null;
 const user=await readUatActorRow(db,email);
 // One authoritative read keeps the fail-closed identity + role contract while avoiding a second D1
 // round-trip on every authenticated staging request. A missing role remains NULL and grants nothing.
 if(!user||String(user.status)!=="active")return null;
 const roleCode=String(user.role_code||"").trim();
 if(!roleCode||user.permissions_json===null||user.permissions_json===undefined)return null;
 const permissions=parsePermissions(user.permissions_json);
 return{email,name:String(user.name||email),roleCode,permissions,developmentPreview:false,identitySource:"workspace" as const,principalType:"email" as const,principalKey:email};
}

/**
 * Is this email allowed to sign in for UAT?
 *
 * This applies the SAME rule resolveUatStaffActor applies, deliberately: an active app_users row, a
 * role code, and a role_definitions row for that code. An earlier version checked only the status,
 * which meant a user whose role had no definition was handed a cookie at sign-in and then refused by
 * every subsequent request — a cookie that cannot authorise anything is worse than a refusal, because
 * the tester has no idea why the workspace is dead.
 */
export async function uatStaffIdentityAllowed(db:Db,email:string){
 const row=await db.prepare("SELECT status,role_code FROM app_users WHERE email=?").bind(String(email).trim().toLowerCase()).first<Row>().catch(()=>null);
 if(!row||String(row.status)!=="active")return false;
 const roleCode=String(row.role_code||"").trim();
 if(!roleCode)return false;
 const role=await db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(roleCode).first<Row>().catch(()=>null);
 return Boolean(role);
}
