import{resolveAiAudienceGate}from"./ai-audience-rollout";
import{aiProviderConnection,requestAiDraft}from"./ai-provider-adapter";
import{orchestrateAiTurn,type AiProviderInput,type AiResponseProvider}from"./ai-conversation-orchestrator";
import{ensureWhatsAppAiLeadTables}from"./whatsapp-ai-lead-orchestration";
import{assertWhatsAppAiRoutingAllowsReply}from"./whatsapp-conversation-control";
import{ensureWhatsAppUatTables}from"./whatsapp-uat-adapter";
import{ensureSecurityTables,securityAudit,type AuthenticatedActor}from"./server-auth";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const serviceActor:AuthenticatedActor={email:"meta-whatsapp-ai@system.pawspace",name:"Meta WhatsApp AI service",roleCode:"service_meta_whatsapp_ai",permissions:["communications.manage"],developmentPreview:false,identitySource:"workspace",principalType:"identity_subject",principalKey:"service:meta-whatsapp-ai"};
const systemPrompt="Draft a concise PawSpace WhatsApp reply using only the canonical context supplied. This is an approval-gated draft, not authorization to mutate bookings, payments, refunds, provider assignments, prices, slots or discounts. Never invent a price, discount, availability, completion state or policy. If the request needs a high-impact action, unsupported fact, medical or safety advice, complaint, refund/payment dispute, or a human, do not claim completion; allow the PawSpace handoff policy to take over.";

function parseConsent(value:unknown){try{return JSON.parse(String(value??"{}"))as Record<string,unknown>}catch{return{}}}

async function assertTrustedMetaInbound(db:D1Database,input:{eventId:string;threadId:string;customerId:string;inputMessageId:string}){
 await ensureWhatsAppUatTables(db);await ensureWhatsAppAiLeadTables(db);
 const evidence=await db.prepare("SELECT e.provider,e.event_id,e.event_type,e.customer_id,e.message_id,e.thread_id,m.provider message_provider,m.channel,m.direction,t.customer_id thread_customer_id,t.status thread_status,t.assigned_to,p.whatsapp_consent,p.opt_out,c.consent_json FROM whatsapp_uat_events e JOIN communication_messages m ON m.id=e.message_id JOIN communication_threads t ON t.id=e.thread_id JOIN canonical_customers c ON c.id=e.customer_id LEFT JOIN customer_contact_preferences p ON p.customer_id=e.customer_id WHERE e.provider='meta_whatsapp' AND e.event_id=? AND e.event_type='inbound_message' LIMIT 1").bind(input.eventId).first<Row>();
 if(!evidence)throw new Response("Trusted Meta inbound evidence is required for internal AI execution",{status:403});
 if(text(evidence.customer_id)!==input.customerId||text(evidence.message_id)!==input.inputMessageId||text(evidence.thread_id)!==input.threadId)throw new Response("Meta inbound evidence does not match the canonical AI turn",{status:409});
 if(text(evidence.message_provider)!=="meta_whatsapp"||text(evidence.channel)!=="whatsapp"||text(evidence.direction)!=="inbound")throw new Response("Canonical Meta inbound transport proof is invalid",{status:409});
 if(text(evidence.thread_customer_id)!==input.customerId||text(evidence.thread_status)!=="open")throw new Response("Canonical conversation is not eligible for Meta AI execution",{status:409});
 if(text(evidence.assigned_to))throw new Response("Human-assigned conversations cannot run Meta AI automation",{status:409});
 const canonicalConsent=parseConsent(evidence.consent_json),whatsappConsent=evidence.whatsapp_consent==null?(canonicalConsent.whatsapp===true||canonicalConsent.whatsappConsent===true):Number(evidence.whatsapp_consent)===1;
 if(!whatsappConsent||Number(evidence.opt_out||0)===1)throw new Response("WhatsApp consent is unavailable or revoked",{status:409});
 const ownership=await db.prepare("SELECT status FROM whatsapp_ai_lead_triggers WHERE thread_id=? ORDER BY updated_at DESC LIMIT 1").bind(input.threadId).first<Row>();
 if(["human_owned","closed"].includes(text(ownership?.status)))throw new Response("Human ownership or closed lead state blocks Meta AI automation",{status:409});
 await assertWhatsAppAiRoutingAllowsReply(db,input.threadId);
 const customerRollout=await resolveAiAudienceGate(db,{audience:"customer"});
 if(!customerRollout.allowed)throw new Response("Customer AI rollout gate blocks Meta WhatsApp automation",{status:409});
}

async function runtimeProvider():Promise<AiResponseProvider>{
 const connection=await aiProviderConnection();
 return{status:connection.connected?"connected":"not_connected",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,deadlineMs:connection.timeoutMs,async generate(input:AiProviderInput){
  const result=await requestAiDraft({systemPrompt,userPrompt:JSON.stringify({channel:"whatsapp",customerMessage:input.inputText,intent:input.intent,canonicalContext:input.context}),maxTokens:1200});
  if(!result.connected)return{text:"",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,latencyMs:0,unsupported:true};
  return{text:result.text,provider:result.providerRef,modelRef:result.modelRef,latencyMs:result.latencyMs,referencedCustomerIds:[input.customerId],highImpactAction:false};
 }};
}

export async function runGovernedMetaWhatsAppAiTurn(db:D1Database,input:{eventId:string;threadId:string;customerId:string;inputMessageId:string}){
 await ensureSecurityTables(db);
 try{
  await assertTrustedMetaInbound(db,input);
  const data=await orchestrateAiTurn(db,{actor:serviceActor,threadId:input.threadId,customerId:input.customerId,inputMessageId:input.inputMessageId,idempotencyKey:`meta-whatsapp-ai:${input.eventId}`,channel:"whatsapp",provider:await runtimeProvider()});
  const turn=(data.turn??null)as Row|null;
  const common={duplicatePrevented:Boolean(data.duplicatePrevented),autoSend:false,autonomousExecution:false,recoveryArmed:false};
  if(!turn){await securityAudit(db,serviceActor,"ai.conversation.meta.internal","communication_thread",input.threadId,"completed",{eventId:input.eventId,status:"pending",autoSend:false});return{status:"ai_pending"as const,...common,approvalRequired:true};}
  const outcome=text(turn.outcome),turnId=text(turn.id),suggestionId=text(turn.suggestionId||turn.suggestion_id);
  if(outcome==="handoff"){await securityAudit(db,serviceActor,"ai.conversation.meta.internal","communication_thread",input.threadId,"completed",{eventId:input.eventId,turnId,status:"human_handoff",autoSend:false});return{status:"human_handoff"as const,turnId,...common,approvalRequired:false,handoffReason:text(turn.handoffReason||turn.handoff_reason)||"provider_error"};}
  await securityAudit(db,serviceActor,"ai.conversation.meta.internal","communication_thread",input.threadId,"completed",{eventId:input.eventId,turnId,status:"ai_draft_ready",autoSend:false,approvalRequired:true});
  return{status:"ai_draft_ready"as const,turnId,suggestionId:suggestionId||null,...common,approvalRequired:true};
 }catch(error){await securityAudit(db,serviceActor,"ai.conversation.meta.internal","communication_thread",input.threadId,"blocked",{eventId:input.eventId,reason:"governed_internal_boundary_rejected",autoSend:false}).catch(()=>undefined);throw error;}
}
