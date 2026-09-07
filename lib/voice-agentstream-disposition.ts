import{recordBotCallDisposition}from"./bot-call-disposition";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export async function recordAgentStreamCompletionDisposition(db:D1Database,input:{ledgerCallId:string;aiCallId:string;providerCallId:string;reason:string;actorId:string}){
 const order=await db.prepare("SELECT lead_id,dial_number,transcript_ref FROM voice_call_orders WHERE id=? LIMIT 1").bind(input.ledgerCallId).first<Row>();
 if(!order)return{recorded:false,reason:"voice_call_order_missing"};
 const leadId=text(order.lead_id);
 if(!leadId)return{recorded:false,reason:"no_canonical_lead"};
 const segment=await db.prepare("SELECT COUNT(*) count FROM ai_voice_segments WHERE call_id=? AND speaker='customer' AND length(trim(transcript_text))>0").bind(input.aiCallId).first<Row>();
 const customerSpeech=Number(segment?.count||0);
 if(customerSpeech<1)return{recorded:false,reason:"no_customer_speech"};
 const failure=/error|failed|socket_error|processing/i.test(input.reason);
 const result=await recordBotCallDisposition(db,{
  idempotencyKey:`agentstream:${input.ledgerCallId}:completion`,
  leadId,
  phone:text(order.dial_number)||null,
  channel:"voice",
  botProvider:"exotel_agentstream",
  callRef:input.providerCallId,
  primaryTag:failure?"human_intervention_needed":"info_shared",
  secondaryTags:[],
  notes:failure?"AgentStream ended with a processing or socket error; human follow-up required.":"AgentStream call completed with customer speech; no purchase, payment, refund, or conversion claim was inferred.",
  transcriptRef:text(order.transcript_ref)||input.aiCallId,
  actorId:input.actorId,
 });
 return{recorded:true,reason:failure?"human_intervention_needed":"info_shared",result};
}
