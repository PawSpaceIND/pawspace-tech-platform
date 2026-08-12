import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{contentControlsOverview,publicContent,saveContentBlock,setContentBlockStatus,setFeatureControl,type ContentPlacement}from"../../../lib/content-controls";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Public read (customer app): published, in-window content + evaluated feature flags only.
// Staff overview (?view=admin) additionally requires marketing.manage and includes drafts + audit.
export async function GET(request:Request){try{
 const db=await database(),url=new URL(request.url);
 if(url.searchParams.get("view")==="admin"){
  const actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
  return json({data:await contentControlsOverview(db)});
 }
 return json({data:await publicContent(db,{placement:url.searchParams.get("placement")||undefined,cityId:url.searchParams.get("cityId")||undefined,serviceCode:url.searchParams.get("serviceCode")||undefined})});
}catch(error){return authError(error,"Unable to load content");}}

export async function POST(request:Request){try{
 const db=await database(),actor=await resolveActor(request);
 const body=await request.json() as Record<string,unknown>,action=String(body.action||"").trim();
 if(action==="set_feature"){
  requirePermission(actor,"settings.manage");
  const data=await setFeatureControl(db,{key:String(body.key||""),description:String(body.description||""),enabled:body.enabled===true,cityIds:Array.isArray(body.cityIds)?(body.cityIds as string[]):[],serviceCodes:Array.isArray(body.serviceCodes)?(body.serviceCodes as string[]):[],actorId:actor.email});
  await securityAudit(db,actor,"content.set_feature","feature_control",String(body.key||""),"completed",{enabled:body.enabled===true});
  return json({data});
 }
 requirePermission(actor,"marketing.manage");
 if(action==="save_block"){
  const data=await saveContentBlock(db,{id:body.id?String(body.id):undefined,title:String(body.title||""),bodyMd:String(body.bodyMd||""),placement:String(body.placement||"") as ContentPlacement,serviceCode:body.serviceCode?String(body.serviceCode):null,cityId:body.cityId?String(body.cityId):null,validFrom:body.validFrom==null?null:Number(body.validFrom),validUntil:body.validUntil==null?null:Number(body.validUntil),actorId:actor.email});
  await securityAudit(db,actor,"content.save_block","content_block",String((data as Record<string,unknown>).blockId),"completed",{version:(data as Record<string,unknown>).version});
  return json({data});
 }
 if(action==="publish_block"||action==="archive_block"){
  const data=await setContentBlockStatus(db,{blockId:String(body.blockId||""),status:action==="publish_block"?"published":"archived",actorId:actor.email});
  await securityAudit(db,actor,`content.${action}`,"content_block",String(body.blockId||""),"completed",{});
  return json({data});
 }
 return json({error:"Unsupported content action"},400);
}catch(error){return authError(error,"Unable to update content");}}
