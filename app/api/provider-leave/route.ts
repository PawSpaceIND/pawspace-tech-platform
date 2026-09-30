import{authError,database,requireProviderOwnership,resolveActor}from"../../../lib/server-auth";
import{ensureAttendanceLeaveTables,requestLeave}from"../../../lib/attendance-leave";
import{ensureWorkforcePersonLinkTables,peopleLinkForProvider}from"../../../lib/workforce-person-linkage";
import{governedJsonError}from"../../../lib/governed-http-error";
type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();

export async function GET(request:Request){try{
 const actor=await resolveActor(request),db=await database(),url=new URL(request.url),providerId=text(url.searchParams.get("providerId"));
 if(!providerId)throw governedJsonError({error:"providerId is required"},400);
 await requireProviderOwnership(db,actor,providerId);await ensureAttendanceLeaveTables(db);await ensureWorkforcePersonLinkTables(db);
 const profile=await db.prepare("SELECT provider_model FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>(),link=await peopleLinkForProvider(db,providerId);
 if(!profile||text(profile.provider_model)!=="full_time"||!link)return Response.json({data:{providerId,editable:false,requests:[]}});
 const requests=await db.prepare("SELECT id,leave_code,start_date,end_date,units,reason,status,created_at FROM leave_requests WHERE employee_id=? ORDER BY created_at DESC LIMIT 25").bind(link.employee_id).all<Row>();
 return Response.json({data:{providerId,editable:true,employeeId:text(link.employee_id),requests:requests.results}});
}catch(error){return authError(error,"Unable to load provider leave");}}

export async function POST(request:Request){try{
 const actor=await resolveActor(request),db=await database(),body=await request.json() as Row,providerId=text(body.providerId);
 if(!providerId)throw governedJsonError({error:"providerId is required"},400);
 await requireProviderOwnership(db,actor,providerId);const link=await peopleLinkForProvider(db,providerId);
 if(!link)throw governedJsonError({error:"People linkage is required before this provider can request leave"},409);
 const data=await requestLeave(db,{employeeId:text(link.employee_id),leaveCode:text(body.leaveCode),startDate:text(body.startDate),endDate:text(body.endDate),units:Number(body.units),reason:text(body.reason),actorId:actor.email});
 return Response.json({data});
}catch(error){return authError(error,"Unable to request provider leave");}}
