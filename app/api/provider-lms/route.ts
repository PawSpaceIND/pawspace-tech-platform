import{authError,database,requirePermission,requireProviderOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{lmsOverview,providerTrainingReadiness,saveLmsModule,setLmsModuleStatus,submitLmsCompletion,type LmsQuizQuestion}from"../../../lib/provider-lms";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{
 const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.view");
 const providerId=String(new URL(request.url).searchParams.get("providerId")||"").trim();
 if(providerId){await requireProviderOwnership(db,actor,providerId);return json({data:await providerTrainingReadiness(db,providerId)});}
 return json({data:await lmsOverview(db)});
}catch(error){return authError(error,"Unable to load provider training");}}

export async function POST(request:Request){try{
 const db=await database(),actor=await resolveActor(request);
 const body=await request.json() as Record<string,unknown>,action=String(body.action||"").trim();
 if(action==="complete_module"){
  requirePermission(actor,"bookings.view");
  const providerId=String(body.providerId||"").trim();
  if(!providerId)return json({error:"A provider is required"},400);
  await requireProviderOwnership(db,actor,providerId);
  const data=await submitLmsCompletion(db,{moduleId:String(body.moduleId||""),providerId,answers:Array.isArray(body.answers)?(body.answers as number[]):[],idempotencyKey:String(body.idempotencyKey||""),actorId:actor.email});
  await securityAudit(db,actor,"lms.complete_module","lms_module",String(body.moduleId||""),"completed",{providerId,passed:(data as Record<string,unknown>).passed,scorePct:(data as Record<string,unknown>).scorePct});
  return json({data});
 }
 requirePermission(actor,"settings.manage");
 if(action==="save_module"){
  const data=await saveLmsModule(db,{id:body.id?String(body.id):undefined,title:String(body.title||""),serviceCode:String(body.serviceCode||""),summary:String(body.summary||""),sections:Array.isArray(body.sections)?(body.sections as string[]):[],quiz:Array.isArray(body.quiz)?(body.quiz as LmsQuizQuestion[]):[],passPct:body.passPct==null?undefined:Number(body.passPct),required:body.required!==false,actorId:actor.email});
  await securityAudit(db,actor,"lms.save_module","lms_module",String((data as Record<string,unknown>).moduleId),"completed",{version:(data as Record<string,unknown>).version});
  return json({data});
 }
 if(action==="publish_module"||action==="archive_module"){
  const data=await setLmsModuleStatus(db,{moduleId:String(body.moduleId||""),status:action==="publish_module"?"published":"archived",actorId:actor.email});
  await securityAudit(db,actor,`lms.${action}`,"lms_module",String(body.moduleId||""),"completed",{});
  return json({data});
 }
 return json({error:"Unsupported provider training action"},400);
}catch(error){return authError(error,"Unable to update provider training");}}
