import{ensureWhatsAppTemplateLifecycle}from"./whatsapp-template-lifecycle";
type Row=Record<string,unknown>;type Fetcher=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const text=(v:unknown)=>String(v??"").trim();
function normalized(v:unknown){const s=text(v).toUpperCase();return s==="APPROVED"?"approved":s==="REJECTED"?"rejected":s==="PAUSED"?"paused":s==="DISABLED"?"paused":"submitted";}
export async function verifyWhatsAppTemplateAgainstMeta(db:D1Database,env:Record<string,unknown>,input:{templateKey:string;actorEmail:string;fetcher?:Fetcher}){
 await ensureWhatsAppTemplateLifecycle(db);const token=text(env.META_WHATSAPP_ACCESS_TOKEN),waba=text(env.META_WHATSAPP_WABA_ID);if(!token||!waba)throw new Response("Meta template verification is not configured",{status:503});
 const key=text(input.templateKey).toLowerCase(),local=await db.prepare("SELECT status FROM whatsapp_uat_templates WHERE template_key=?").bind(key).first<Row>();if(!local)throw new Response("Template not found",{status:404});
 const version=text(env.META_WHATSAPP_GRAPH_VERSION)||"v23.0",response=await(input.fetcher??fetch)(`https://graph.facebook.com/${version}/${encodeURIComponent(waba)}/message_templates?fields=id,name,status,category,language&limit=100`,{headers:{authorization:`Bearer ${token}`},redirect:"error"});
 if(!response.ok)throw new Error(`Meta template verification failed with HTTP ${response.status}`);const payload=await response.json()as Row,rows=Array.isArray(payload.data)?payload.data as Row[]:[],match=rows.find(row=>text(row.name).toLowerCase()===key);if(!match)throw new Response("Template not found in Meta WhatsApp Manager",{status:404});
 const status=normalized(match.status),now=Date.now(),metaReference=text(match.id)||`${waba}:${key}`,previous=text(local.status);const note=`Live Meta Graph API status: ${text(match.status)}`;
 await db.batch([
  db.prepare("UPDATE whatsapp_uat_templates SET status=?,category=?,approved_language=?,updated_by=?,updated_at=? WHERE template_key=?").bind(status,text(match.category).toLowerCase()||"utility",text(match.language)||"en",input.actorEmail,now,key),
  db.prepare("UPDATE whatsapp_template_lifecycle SET meta_reconciliation_status=?,meta_reference=?,reconciliation_note=?,approved_at=?,rejected_at=?,paused_at=?,updated_by=?,updated_at=? WHERE template_key=?").bind(status,metaReference,note,status==="approved"?now:null,status==="rejected"?now:null,status==="paused"?now:null,input.actorEmail,now,key),
  db.prepare("INSERT INTO whatsapp_template_lifecycle_events (id,template_key,from_status,to_status,event_type,actor_email,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`WATPL-${crypto.randomUUID().slice(0,12).toUpperCase()}`,key,previous||null,status,"meta_status_verified",input.actorEmail,"Live Meta Graph API verification",JSON.stringify({metaReference,providerStatus:text(match.status),externalMetaMutation:false,providerRead:true}),now),
 ]);
 return{templateKey:key,status,previousStatus:previous,metaReference,providerStatus:text(match.status),verifiedAgainstMeta:true,externalMetaMutation:false,providerRead:true};
}
