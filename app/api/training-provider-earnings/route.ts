import{authError,database,requirePermission,requireProviderOwnership,resolveActor}from"../../../lib/server-auth";
import{listTrainerEarnings}from"../../../lib/training-finance";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
export async function GET(request:Request){try{const providerId=String(new URL(request.url).searchParams.get("providerId")||"").trim();if(!providerId)return json({error:"Trainer provider ID is required"},400);const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.view");await requireProviderOwnership(db,actor,providerId);return json({data:await listTrainerEarnings(db,providerId)});}catch(error){return authError(error,"Unable to load Training earnings");}}
