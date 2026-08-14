import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import{authError,database,resolveActor,securityAudit}from"../../../lib/server-auth";
import{providerWorkspace,resolveProviderForActor,submitJobProof,respondToJobOffer}from"../../../lib/provider-workspace";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin provider write blocked",{status:403});}

export async function GET(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{const actor=await resolveActor(request);const db=await database();const providerId=await resolveProviderForActor(db,actor.email);if(!providerId)return json({data:{linked:false,email:actor.email},productionReady:false});return json({data:{linked:true,...await providerWorkspace(db,{providerId})},productionReady:false});}catch(error){return authError(error,"Unable to load your provider workspace");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);const db=await database();const providerId=await resolveProviderForActor(db,actor.email);if(!providerId)throw new Response("No active provider record is linked to your identity",{status:403});const body=await request.json() as Row,action=text(body.action);let result:unknown;
 if(action==="submit_proof")result=await submitJobProof(db,{providerId,bookingId:text(body.bookingId),proofType:text(body.proofType),objectId:text(body.objectId)||null,note:text(body.note)||null,distanceKm:body.distanceKm==null?null:Number(body.distanceKm)});
 else if(action==="accept_job")result=await respondToJobOffer(db,{providerId,bookingId:text(body.bookingId),accept:true});
 else if(action==="decline_job")result=await respondToJobOffer(db,{providerId,bookingId:text(body.bookingId),accept:false});
 else return json({error:"Unknown provider-workspace action"},400);
 await securityAudit(db,actor,`provider_workspace.${action}`,"provider_workspace",providerId,"completed");
 return json({data:result,productionReady:false});}catch(error){return authError(error,"Provider workspace update failed");}}
