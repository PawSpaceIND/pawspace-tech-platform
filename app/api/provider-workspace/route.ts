import{authError,authFailure,database,resolveActor,securityAudit}from"../../../lib/server-auth";
import{providerWorkspace,resolveProviderForIdentity,submitJobProof,respondToJobOffer}from"../../../lib/provider-workspace";
import{assertPartnerDailyScheduleLiveness}from"../../../lib/trust-safety/partner-shift-liveness-gate";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin provider write blocked",{status:403});}

export async function GET(request:Request){try{const actor=await resolveActor(request);const db=await database();const providerId=await resolveProviderForIdentity(db,actor);if(!providerId)return json({data:{linked:false,email:actor.email,reason:"No active provider record is linked to your identity. Ask Ops to link your partner profile before jobs, earnings or settlements can be shown."},productionReady:false});const{env}=await import("cloudflare:workers");const enforce=["1","true","on","yes"].includes(String((env as unknown as Record<string,unknown>).PAWSPACE_SHIFT_LIVENESS_ENFORCE??"").toLowerCase());const liveness=await assertPartnerDailyScheduleLiveness(db,{providerId,enforce});return json({data:{linked:true,liveness,...await providerWorkspace(db,{providerId})},productionReady:false});}catch(error){return authError(error,"Unable to load your provider workspace");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);const db=await database();const providerId=await resolveProviderForIdentity(db,actor);if(!providerId)throw authFailure("No active provider record is linked to your identity",403);const body=await request.json() as Row,action=text(body.action);let result:unknown;
 if(action==="submit_proof")result=await submitJobProof(db,{providerId,bookingId:text(body.bookingId),proofType:text(body.proofType),objectId:text(body.objectId)||null,note:text(body.note)||null,distanceKm:body.distanceKm==null?null:Number(body.distanceKm)});
 else if(action==="accept_job")result=await respondToJobOffer(db,{providerId,bookingId:text(body.bookingId),accept:true});
 else if(action==="decline_job")result=await respondToJobOffer(db,{providerId,bookingId:text(body.bookingId),accept:false});
 else return json({error:"Unknown provider-workspace action"},400);
 await securityAudit(db,actor,`provider_workspace.${action}`,"provider_workspace",providerId,"completed");
 return json({data:result,productionReady:false});}catch(error){return authError(error,"Provider workspace update failed");}}
