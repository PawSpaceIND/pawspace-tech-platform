import{database}from"../../../lib/server-auth";
import{uatLoginEnabled,uatAccessCodeValid,issueUatToken,uatCookie,clearUatCookie,resolveUatStaffActor,uatStaffIdentityAllowed}from"../../../lib/uat-staging-auth";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200,cookie?:string)=>{const h:Record<string,string>={"cache-control":"no-store"};if(cookie)h["set-cookie"]=cookie;return Response.json(value,{status,headers:h});};
const TTL=8*3600;

export async function GET(request:Request){const {env}=await import("cloudflare:workers");if(!uatLoginEnabled(env as never))return json({enabled:false},404);const db=await database();const actor=await resolveUatStaffActor(db,request,env as never);return json({enabled:true,signedInAs:actor?{email:actor.email,role:actor.roleCode}:null});}

export async function POST(request:Request){
 const {env}=await import("cloudflare:workers");
 if(!uatLoginEnabled(env as never))return json({error:"UAT sign-in is not enabled here"},404);
 const body=await request.json().catch(()=>({})) as Row,action=text(body.action)||"login";
 if(action==="logout")return json({ok:true},200,clearUatCookie());
 if(!uatAccessCodeValid(env as never,text(body.code)))return json({error:"Invalid access code"},401);
 const email=text(body.email).toLowerCase();
 if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return json({error:"Enter a valid email to sign in as"},400);
 // The email must be a real staff record. This used to accept ANY address and hand it a founder
 // identity with ["*"], so the access code alone conferred full authority over the staging workspace.
 // Checked here as well as in resolveUatStaffActor so a tester is told at sign-in rather than handed a
 // cookie that every later request refuses without explanation.
 const db=await database();
 if(!await uatStaffIdentityAllowed(db,email))return json({error:"That email cannot sign in here. UAT sign-in needs an active staff account whose role has a definition — an unknown email, a suspended account, or a role nobody has defined are all refused. Sign in as one of the seeded staff identities in docs/UAT-TESTER-GUIDE.md; UAT sign-in no longer grants an unrecognised email full access."},403);
 const token=await issueUatToken(env as never,email,TTL);
 return json({ok:true,email},200,uatCookie(token,TTL));
}
