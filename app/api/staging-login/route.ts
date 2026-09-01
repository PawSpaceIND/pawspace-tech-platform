import{database,ensureSecurityTables}from"../../../lib/server-auth";
import{uatLoginEnabled,uatAccessCodeValid,issueUatToken,uatCookie,clearUatCookie,resolveUatStaffActor,uatStaffIdentityAllowed}from"../../../lib/uat-staging-auth";

type Row=Record<string,unknown>;
type Db=Awaited<ReturnType<typeof database>>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200,cookie?:string)=>{const h:Record<string,string>={"cache-control":"no-store"};if(cookie)h["set-cookie"]=cookie;return Response.json(value,{status,headers:h});};
const dependencyUnavailable=(error:unknown)=>{
 console.error("[staging-login] staging dependency unavailable",error);
 return json({error:"Staging authentication dependency is unavailable",code:"staging_dependency_unavailable"},503);
};
// UAT browser sessions are intentionally long-lived so human testers do not have to re-authenticate
// several times a day. This path remains staging-only because uatLoginEnabled() requires the explicit
// PAWSPACE_UAT_LOGIN=on flag plus the staging signing key; production never enables that branch.
const TTL=30*24*3600;

// These are the identities advertised by /staging-login and docs/UAT-TESTER-GUIDE.md. A freshly
// isolated release-preview D1 does not load the large employee/payroll demo seed, so advertising these
// identities without provisioning their minimal staff-directory rows makes every quick-login button
// fail. Provision only the identity rows needed for UAT authentication; role definitions remain owned
// by ensureSecurityTables(). This code is unreachable unless PAWSPACE_UAT_LOGIN is explicitly enabled.
const UAT_IDENTITIES=[
 {id:"UAT-FOUNDER",email:"founder@pawspace.in",name:"PawSpace Founder",role:"founder"},
 {id:"UAT-FINANCE",email:"anjali.finance33@tkpetcare.in",name:"Anjali Finance",role:"finance"},
 {id:"UAT-MANAGER",email:"jyoti.manager39@tkpetcare.in",name:"Jyoti Manager",role:"manager"},
 {id:"UAT-GROOMER",email:"asha.groomer1@tkpetcare.in",name:"Asha Groomer",role:"service_provider"},
 {id:"UAT-ASSOCIATE",email:"anita.associate17@tkpetcare.in",name:"Anita Associate",role:"associate"},
] as const;
// The dedicated preview D1 persists between candidate deploys. These exact, hard-coded UAT identities
// are configuration, not mutable employee truth, so re-assert their advertised name/role/active state
// if a prior run left a stale, suspended or differently-role'd row behind. Preserve id + created_at;
// unknown emails are still refused by the allowlist/uatStaffIdentityAllowed gate below.
async function ensureUatIdentities(db:Db){const now=Date.now();await db.batch(UAT_IDENTITIES.map(identity=>db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role_code=excluded.role_code,status='active',updated_at=excluded.updated_at").bind(identity.id,identity.email,identity.name,identity.role,now,now)));}

export async function GET(request:Request){const {env}=await import("cloudflare:workers");if(!uatLoginEnabled(env as never))return json({enabled:false},404);try{const db=await database();await ensureSecurityTables(db);await ensureUatIdentities(db);const actor=await resolveUatStaffActor(db,request,env as never);return json({enabled:true,signedInAs:actor?{email:actor.email,role:actor.roleCode}:null});}catch(error){return dependencyUnavailable(error);}}

export async function POST(request:Request){
 const {env}=await import("cloudflare:workers");
 if(!uatLoginEnabled(env as never))return json({error:"UAT sign-in is not enabled here"},404);
 const body=await request.json().catch(()=>({})) as Row,action=text(body.action)||"login";
 if(action==="logout")return json({ok:true},200,clearUatCookie());
 if(!uatAccessCodeValid(env as never,text(body.code)))return json({error:"Invalid access code"},401);
 const email=text(body.email).toLowerCase();
 if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return json({error:"Enter a valid email to sign in as"},400);
 try{
  const db=await database();
  await ensureSecurityTables(db);
  await ensureUatIdentities(db);
  if(!await uatStaffIdentityAllowed(db,email))return json({error:"That email cannot sign in here. UAT sign-in needs an active staff account whose role has a definition — an unknown email, a suspended account, or a role nobody has defined are all refused. Sign in as one of the seeded staff identities in docs/UAT-TESTER-GUIDE.md; UAT sign-in no longer grants an unrecognised email full access."},403);
  const token=await issueUatToken(env as never,email,TTL);
  return json({ok:true,email},200,uatCookie(token,TTL));
 }catch(error){return dependencyUnavailable(error);}
}