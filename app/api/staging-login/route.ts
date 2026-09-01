import{database}from"../../../lib/server-auth";
import{uatLoginEnabled,uatAccessCodeValid,issueUatToken,uatCookie,clearUatCookie,resolveUatStaffActor,uatStaffIdentityAllowed}from"../../../lib/uat-staging-auth";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200,cookie?:string)=>{const h:Record<string,string>={"cache-control":"no-store"};if(cookie)h["set-cookie"]=cookie;return Response.json(value,{status,headers:h});};
const dependencyUnavailable=()=>json({error:"Staging authentication dependency is unavailable",code:"staging_dependency_unavailable"},503);
// UAT browser sessions are intentionally long-lived so human testers do not have to re-authenticate
// several times a day. This path remains staging-only because uatLoginEnabled() requires the explicit
// PAWSPACE_UAT_LOGIN=on flag plus the staging signing key; production never enables that branch.
const TTL=30*24*3600;

// Staging identity/schema bootstrap is an explicit deploy concern. The deployment workflow seeds the
// staff directory before certification; login itself stays read-only so a sign-in request never performs
// DDL or self-healing writes against D1. This also makes infrastructure failures observable as 503s
// instead of mixing authentication with runtime schema mutation.
export async function GET(request:Request){
 const {env}=await import("cloudflare:workers");
 if(!uatLoginEnabled(env as never))return json({enabled:false},404);
 try{
  const db=await database();
  const actor=await resolveUatStaffActor(db,request,env as never);
  return json({enabled:true,signedInAs:actor?{email:actor.email,role:actor.roleCode}:null});
 }catch(error){console.error("[staging-login] dependency unavailable",error);return dependencyUnavailable();}
}

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
  if(!await uatStaffIdentityAllowed(db,email))return json({error:"That email cannot sign in here. UAT sign-in needs an active seeded staff account whose role has a definition. Sign in as one of the staging staff identities in docs/UAT-TESTER-GUIDE.md."},403);
  const token=await issueUatToken(env as never,email,TTL);
  return json({ok:true,email},200,uatCookie(token,TTL));
 }catch(error){console.error("[staging-login] dependency unavailable",error);return dependencyUnavailable();}
}
