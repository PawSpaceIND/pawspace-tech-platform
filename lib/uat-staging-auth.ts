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
 * Identity → role: a known seeded app_user gets its real role; any other email (behind the access code)
 * gets a founder/full-access role so a single tester can exercise every admin surface. Staging data is
 * synthetic/masked and payments are sandbox, so this convenience is safe here and nowhere else.
 */
import{parsePermissions}from"./platform-security";

type Db=D1Database;
type Row=Record<string,unknown>;
type UatEnv={PAWSPACE_UAT_LOGIN?:unknown;PAWSPACE_UAT_ACCESS_CODE?:unknown;PAWSPACE_UAT_SIGNING_KEY?:unknown};
const COOKIE="pawspace_uat";
const enc=new TextEncoder();

export function uatLoginEnabled(env:UatEnv){return String(env?.PAWSPACE_UAT_LOGIN||"")==="on"&&String(env?.PAWSPACE_UAT_SIGNING_KEY||"").length>=16;}

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

/** Resolve a staff/admin actor from a valid UAT cookie. Returns null unless UAT login is enabled and the cookie verifies. */
export async function resolveUatStaffActor(db:Db,request:Request,env:UatEnv){
 if(!uatLoginEnabled(env))return null;
 const token=readCookie(request,COOKIE);
 if(!token)return null;
 const email=await verifyUatToken(env,token);
 if(!email)return null;
 const user=await db.prepare("SELECT name,role_code,status FROM app_users WHERE email=?").bind(email).first<Row>().catch(()=>null);
 let roleCode="founder",permissions:string[]=["*"],name=`UAT ${email}`;
 if(user&&String(user.status)==="active"){
  roleCode=String(user.role_code);name=String(user.name||email);
  const role=await db.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(roleCode).first<Row>().catch(()=>null);
  permissions=role?parsePermissions(role.permissions_json):[];
 }
 return{email,name,roleCode,permissions,developmentPreview:false,identitySource:"workspace" as const,principalType:"email" as const,principalKey:email};
}
