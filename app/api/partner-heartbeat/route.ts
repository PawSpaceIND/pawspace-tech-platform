import {authError,database,requirePermission,requireProviderOwnership,resolveActor} from "../../../lib/server-auth";
import {recordPartnerHeartbeat} from "../../../lib/partner-job-heartbeat";
export async function POST(request:Request) {
  try {
    const actor=await resolveActor(request);requirePermission(actor,"bookings.view");
    const input=await request.json() as Record<string,unknown>;
    if(typeof input.bookingId!=="string"||typeof input.providerId!=="string")return Response.json({error:"Booking and provider are required"},{status:400});
    const db=await database();await requireProviderOwnership(db,actor,input.providerId);
    const trackingState=["native","foreground","permission_denied","unavailable"].includes(String(input.trackingState))?String(input.trackingState):"unavailable";
    const accepted=await recordPartnerHeartbeat(db,{bookingId:input.bookingId,providerId:input.providerId,trackingState});
    return Response.json(accepted?{ok:true,serverTime:Date.now()}:{error:"Job is no longer active or assigned to this partner"},{status:accepted?200:409,headers:{"cache-control":"no-store"}});
  }catch(error){return authError(error,"Unable to record partner heartbeat");}
}
