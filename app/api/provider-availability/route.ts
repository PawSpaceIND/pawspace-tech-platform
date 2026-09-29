import {authError,resolveActor,requireProviderOwnership,actorManagesProviders,database,securityAudit} from "../../../lib/server-auth";
import {setProviderAvailability} from "../../../lib/provider-capacity-governance";
import {providerCalendarSnapshot,saveProviderCalendarDay} from "../../../lib/provider-calendar-self-service";
import {governedJsonError} from "../../../lib/governed-http-error";

const selfServiceActor=(actor:Awaited<ReturnType<typeof resolveActor>>)=>actor.subjectType==="provider"||actor.roleCode==="service_provider";

export async function GET(request:Request){
 try{
  const actor=await resolveActor(request),db=await database(),url=new URL(request.url);
  const providerId=String(url.searchParams.get("providerId")||"").trim();
  const from=String(url.searchParams.get("from")||"").trim(),to=String(url.searchParams.get("to")||"").trim();
  if(!providerId||!from||!to)throw governedJsonError({error:"providerId, from and to are required"},400);
  await requireProviderOwnership(db,actor,providerId);
  const data=await providerCalendarSnapshot(db,{providerId,from,to});
  return Response.json({data});
 }catch(error){return authError(error,"Unable to load provider availability");}
}

export async function PUT(request:Request){
 try{
  const actor=await resolveActor(request),db=await database();
  if(!selfServiceActor(actor)||actorManagesProviders(actor)&&actor.subjectType!=="provider")
    throw governedJsonError({error:"Use the Operations calendar controls for staff-managed availability"},403);
  const body=await request.json() as {providerId?:string;date?:string;zoneId?:string;state?:"open"|"blocked";windows?:unknown};
  if(!body.providerId||!body.date||!body.zoneId||!["open","blocked"].includes(String(body.state)))
    throw governedJsonError({error:"providerId, date, zoneId and state are required"},400);
  await requireProviderOwnership(db,actor,body.providerId);
  const data=await saveProviderCalendarDay(db,{providerId:body.providerId,date:body.date,zoneId:body.zoneId,state:body.state!,windows:body.windows});
  await securityAudit(db,actor,"provider.calendar.self_set","provider",body.providerId,"completed",{date:body.date,zoneId:body.zoneId,state:data.state,windowCount:data.windows.length});
  return Response.json({data});
 }catch(error){return authError(error,"Unable to update provider calendar");}
}

export async function POST(request: Request) {
  try {
    const actor = await resolveActor(request);
    const db = await database();
    const body = (await request.json()) as { providerId?: string; available?: boolean; reason?: string };
    if (!body.providerId || typeof body.available !== "boolean" || !body.reason) {
      return Response.json({ error: "providerId, available and reason are required" }, { status: 400 });
    }
    await requireProviderOwnership(db, actor, body.providerId);
    // Legacy coarse on/off remains for existing clients. G17 dated self-service uses PUT above.
    const result = await setProviderAvailability(db, {
      providerId: body.providerId, available: body.available, reason: body.reason, actorId: actor.email,
      actorIsStaff: actorManagesProviders(actor),
    });
    return Response.json({ data: result });
  } catch (error) {
    return authError(error, "Unable to update availability");
  }
}
