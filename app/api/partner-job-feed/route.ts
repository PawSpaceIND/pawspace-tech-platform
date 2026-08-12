import{authError,requirePermission,requireProviderOwnership,resolveActor,type AuthenticatedActor}from"../../../lib/server-auth";
import{findIdentityBinding}from"../../../lib/identity-binding";
import{hasPermission}from"../../../lib/platform-security";
import{listProviderJobs,type PartnerJobCounts}from"../../../lib/partner-job-feed";

const json=(value:unknown,status=200)=>Response.json(value,{status});

// The one and only way routes reach D1 in this runtime — the Workers env binding.
async function database(){const {env}=await import("cloudflare:workers");return env.DB;}

// Same own-provider resolution as app/api/boarding-stays/route.ts: identity binding first,
// then the legacy provider_identity_links fallback.
async function ownProviderId(db:D1Database,actor:AuthenticatedActor){if(actor.developmentPreview)return"host_maya_rohan";const binding=await findIdentityBinding(db,{identitySource:actor.identitySource,principalType:actor.principalType,principalKey:actor.principalKey,subjectType:"provider"});if(binding)return String(binding.subject_id);const legacy=await db.prepare("SELECT provider_id,status FROM provider_identity_links WHERE email=?").bind(actor.email).first<Record<string,unknown>>();return legacy&&legacy.status==="active"?String(legacy.provider_id):null;}

export async function GET(request:Request){try{
  const url=new URL(request.url);
  let providerId=String(url.searchParams.get("providerId")||"").trim();
  const db=await database(),actor=await resolveActor(request);
  requirePermission(actor,"bookings.view");
  if(!providerId){
    if(hasPermission(actor.permissions,"bookings.manage"))return json({error:"Staff requests require a providerId filter"},400);
    providerId=String(await ownProviderId(db,actor)||"");
    if(!providerId)return json({error:"No active provider identity is linked to this session"},403);
  }
  await requireProviderOwnership(db,actor,providerId);
  const feed=await listProviderJobs(db,providerId);
  const counts:PartnerJobCounts={needsAction:feed.needsAction.length,today:feed.today.length,upcoming:feed.upcoming.length,completed:feed.completed.length,total:feed.needsAction.length+feed.today.length+feed.upcoming.length+feed.completed.length};
  return json({data:{...feed,counts,productionReady:false}});
}catch(error){return authError(error,"Unable to load the partner job feed");}}
