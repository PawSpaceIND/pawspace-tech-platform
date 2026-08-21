import{database}from"../../../lib/server-auth";
import{uatAccessCodeValid,uatLoginEnabled}from"../../../lib/uat-staging-auth";
import{getGovernedProvider,seedProviderCapacityDefaults}from"../../../lib/provider-capacity-governance";
import{upsertIdentityBinding}from"../../../lib/identity-binding";
import{issuePlatformSession,platformSessionCookie}from"../../../lib/platform-session";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200,cookie?:string)=>Response.json(value,{status,headers:{"cache-control":"no-store",...(cookie?{"set-cookie":cookie}:{})}});
function sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}

export async function GET(){
 const{env}=await import("cloudflare:workers");
 if(!uatLoginEnabled(env as never))return json({error:"UAT provider switching is not enabled here"},404);
 const db=await database();await seedProviderCapacityDefaults(db);
 const rows=await db.prepare("SELECT id,name,city_id,services_json FROM provider_capacity_profiles WHERE live=1 AND status='active' ORDER BY name,id").all<Row>();
 return json({data:{providers:rows.results.map(row=>({id:String(row.id),name:String(row.name),cityId:String(row.city_id),services:(()=>{try{return JSON.parse(String(row.services_json||"[]")) as string[]}catch{return[]}})()}))}});
}

export async function POST(request:Request){
 try{
  sameOriginWrite(request);
  const{env}=await import("cloudflare:workers");
  if(!uatLoginEnabled(env as never))return json({error:"UAT provider switching is not enabled here"},404);
  const body=await request.json().catch(()=>({})) as {providerId?:string;code?:string},providerId=String(body.providerId||"").trim();
  if(!uatAccessCodeValid(env as never,body.code))return json({error:"Invalid UAT access code"},401);
  if(!providerId)return json({error:"Provider is required"},400);
  const db=await database(),provider=await getGovernedProvider(db,providerId);
  if(!provider||!provider.live)return json({error:"That provider is not active in the UAT roster"},404);
  const principalKey=`uat-provider:${provider.id}`,actorId="uat-provider-switch";
  const binding=await upsertIdentityBinding(db,{identitySource:"partner_otp",principalType:"identity_subject",principalKey,subjectType:"provider",subjectId:provider.id,cityId:provider.cityId,verificationState:"verified",expiresAt:null,metadata:{uatProviderSwitch:true},actorId,reason:"UAT-only provider identity switch"});
  const issued=await issuePlatformSession(db,{bindingId:String(binding?.id||""),identitySource:"partner_otp",principalType:"identity_subject",principalKey,subjectType:"provider",subjectId:provider.id,ttlSeconds:28_800,metadata:{uatProviderSwitch:true}});
  return json({data:{providerId:provider.id,name:provider.name,services:provider.services}},200,platformSessionCookie(issued.token,issued.ttlSeconds));
 }catch(error){if(error instanceof Response)return error;return json({error:error instanceof Error?error.message:"Unable to switch UAT provider"},500);}
}
