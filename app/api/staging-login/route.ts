import{database,ensureSecurityTables}from"../../../lib/server-auth";
import{uatLoginEnabled,uatAccessCodeValid,issueUatToken,uatCookie,clearUatCookie,resolveUatStaffActor,uatStaffIdentityAllowed}from"../../../lib/uat-staging-auth";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200,cookie?:string)=>{const h:Record<string,string>={"cache-control":"no-store"};if(cookie)h["set-cookie"]=cookie;return Response.json(value,{status,headers:h});};
const TTL=8*3600;

export async function GET(request:Request){const {env}=await import("cloudflare:workers");if(!uatLoginEnabled(env as never))return json({enabled:false},404);const db=await database();await ensureSecurityTables(db);const actor=await resolveUatStaffActor(db,request,env as never);return json({enabled:true,signedInAs:actor?{email:actor.email,role:actor.roleCode}:null});}

export async function POST(request:Request){
 const {env}=await import("cloudflare:workers");
 if(!uatLoginEnabled(env as never))return json({error:"UAT sign-in is not enabled here"},404);
 const body=await request.json().catch(()=>({})) as Row,action=text(body.action)||"login";
 if(action==="logout")return json({ok:true},200,clearUatCookie());
 if(!uatAccessCodeValid(env as never,text(body.code)))return json({error:"Invalid access code"},401);
 const email=text(body.email).toLowerCase();
 if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return json({error:"Enter a valid email to sign in as"},400);
 // A valid UAT sign-in can be followed immediately by a gateway denial. That denial is audited before
 // any route handler runs, so a freshly isolated preview D1 must have the security audit table too.
 // Bootstrapping the canonical auth schema here keeps the first signed-in request from turning an
 // intended 403 into a 500 merely because no earlier staff route happened to create the table.
 const db=await database();
 await ensureSecurityTables(db);
 if(!await uatStaffIdentityAllowed(db,email))return json({error:"That email cannot sign in here. UAT sign-in needs an active staff account whose role has a definition — an unknown email, a suspended account, or a role nobody has defined are all refused. Sign in as one of the seeded staff identities in docs/UAT-TESTER-GUIDE.md; UAT sign-in no longer grants an unrecognised email full access."},403);
 const token=await issueUatToken(env as never,email,TTL);
 return json({ok:true,email},200,uatCookie(token,TTL));
}
