import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../../lib/server-auth";
import{ensureWhatsAppUatTables}from"../../../../lib/whatsapp-uat-adapter";
import{dispatchMetaWhatsAppUat,syncMetaWhatsAppTemplates}from"../../../../lib/meta-whatsapp-uat-dispatch";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function uatDiagnosticCode(error:unknown){if(!(error instanceof Error))return"unknown";const message=String(error.message||"");if(/Meta template sync failed with HTTP/i.test(message))return"meta_http";if(/D1|SQL|database|constraint|column|table/i.test(message))return"database";if(/fetch|network|timeout|socket/i.test(message))return"network";if(/json|parse/i.test(message))return"provider_payload";return"application";}

export async function GET(request:Request){
 try{const actor=await resolveActor(request);requirePermission(actor,"communications.manage");const db=await database();await ensureWhatsAppUatTables(db);
  const[templates,provider,recent]=await Promise.all([
   db.prepare("SELECT template_key,status,category,approved_language,updated_by,updated_at FROM whatsapp_uat_templates ORDER BY updated_at DESC,template_key").all<Row>(),
   db.prepare("SELECT provider,disabled,reason,updated_by,updated_at FROM whatsapp_uat_provider_controls WHERE provider='meta_whatsapp'").first<Row>(),
   db.prepare("SELECT id,customer_id,thread_id,status,provider_reference,template_key,created_at,updated_at FROM communication_messages WHERE channel='whatsapp' AND provider='meta_whatsapp' ORDER BY updated_at DESC LIMIT 50").all<Row>(),
  ]);return json({data:{environment:"uat",productionDelivery:false,templates:templates.results,provider,recentMessages:recent.results}});
 }catch(error){return authError(error,"Unable to load Meta WhatsApp controls");}
}

export async function POST(request:Request){
 try{const actor=await resolveActor(request);const db=await database();const body=await request.json()as Record<string,unknown>,action=String(body.action||"");
  if(action==="sync_templates"){requirePermission(actor,"settings.manage");const{env}=await import("cloudflare:workers");const result=await syncMetaWhatsAppTemplates(db,env as unknown as Record<string,unknown>,{actorId:actor.email});await securityAudit(db,actor,"whatsapp.meta_template_sync","integration","meta_whatsapp","completed",result);return json({data:result});}
  if(action==="dispatch_uat"){requirePermission(actor,"communications.manage");const messageId=String(body.messageId||"").trim(),recipient=String(body.recipient||"").trim();if(!messageId||!recipient)return json({error:"Message ID and allow-listed recipient are required"},400);const{env}=await import("cloudflare:workers");const result=await dispatchMetaWhatsAppUat(db,env as unknown as Record<string,unknown>,{messageId,recipient});await securityAudit(db,actor,"whatsapp.meta_dispatch_uat","communication",messageId,"completed",{status:result.status,providerReference:"providerReference"in result?result.providerReference:null,externalDelivery:result.externalDelivery,productionDelivery:false});return json({data:result});}
  return json({error:"Supported action is sync_templates or dispatch_uat"},400);
 }catch(error){try{const{env}=await import("cloudflare:workers");if(String((env as unknown as Record<string,unknown>).PAWSPACE_COMMUNICATION_ENV||"").toLowerCase()==="uat")return json({error:"Unable to update Meta WhatsApp controls",diagnosticCode:uatDiagnosticCode(error)},500);}catch{}return authError(error,"Unable to update Meta WhatsApp controls");}
}
