import{ensureAiBusinessConfiguration}from"./ai-business-configuration";
import{resolveExplicitAiKillSwitches}from"./ai-runtime-kill-switch";
import{assertNativeDemoBusinessAllowed}from"./native-attended-demo";
import{recordAgreedBotFollowup}from"./agreed-bot-followup";
import{ensureLeadCallbackTables,LeadCallbackRefusal}from"./lead-callback-governance";
import{requireCustomerOwnership,type AuthenticatedActor}from"./server-auth";
type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();
/** Bounded explicit agreement protocol shared by chat/voice. No model inference, dates or delivery. */
export async function executeConversationFollowup(db:D1Database,input:{actor:AuthenticatedActor;customerId:string;threadId:string;inputMessageId:string;turnKey:string;message:string;channel:string;intentCode?:string}){
 const value=input.message.trim();
 const declined=/^(?:please\s+)?(?:cancel|stop|do not schedule|don't schedule)\s+(?:my\s+|the\s+|a\s+)?(?:follow[- ]?up|callback)\b/i.test(value);
 const requested=/^(?:please\s+)?(?:schedule|arrange|request)\s+(?:a\s+)?(?:follow[- ]?up|callback)\b/i.test(value)||/^(?:i want|i would like|yes)\s+(?:a\s+)?(?:follow[- ]?up|callback)\b/i.test(value);
 const isoOnly=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
 if(!requested&&!declined&&!isoOnly)return null;
 if(/["“”]|\b(?:if|hypothetical|example|policy|not yet|just asking)\b/i.test(value))return null;
 await requireCustomerOwnership(db,input.actor,input.customerId);
 const canonical=await db.prepare("SELECT customer_id,thread_id,channel,direction,payload_json FROM communication_messages WHERE id=?").bind(input.inputMessageId).first<Row>();
 let payload:Row={};try{payload=JSON.parse(text(canonical?.payload_json));}catch{}
 if(!canonical||text(canonical.customer_id)!==input.customerId||text(canonical.thread_id)!==input.threadId||text(canonical.channel)!==input.channel||canonical.direction!=="inbound"||text(payload.text||payload.message||payload.body||payload.content)!==value)throw new Response("Followup requires the exact canonical customer message",{status:403});
 const thread=await db.prepare("SELECT customer_id,lead_id,status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
 if(!thread||text(thread.customer_id)!==input.customerId||thread.status==='closed')throw new Response("Followup conversation ownership denied",{status:403});
 if(isoOnly){
  const prior=await db.prepare("SELECT input_message_id,policy_decision FROM ai_conversation_turns WHERE thread_id=? AND customer_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").bind(input.threadId,input.customerId).first<Row>();
  const previous=await db.prepare("SELECT id FROM communication_messages WHERE thread_id=? AND direction='inbound' AND id!=? ORDER BY created_at DESC,rowid DESC LIMIT 1").bind(input.threadId,input.inputMessageId).first<Row>();
  if(prior?.policy_decision!=="followup_date_required"||text(prior.input_message_id)!==text(previous?.id))return null;
 }
 await ensureAiBusinessConfiguration(db);
 if((await resolveExplicitAiKillSwitches(db,{channel:input.channel,intent:input.intentCode||"human_handoff"})).length)return{policyDecision:"followup_disabled",output:"Followup actions are paused. Nothing has been scheduled or sent; the team needs to check the request.",receipt:{scheduled:false,externalDelivery:false}};
 await assertNativeDemoBusinessAllowed(db,input.threadId);
 let leadId=text(thread.lead_id);
 if(!leadId){
  const candidates=await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND opt_out=0 AND status NOT IN ('closed','converted') AND lifecycle_state NOT IN ('converted','dropped') ORDER BY id LIMIT 2").bind(input.customerId).all<Row>();
  if(candidates.results.length===1){const selected=text(candidates.results[0].id);await db.prepare("UPDATE communication_threads SET lead_id=? WHERE id=? AND customer_id=? AND lead_id IS NULL").bind(selected,input.threadId,input.customerId).run();const linked=await db.prepare("SELECT lead_id FROM communication_threads WHERE id=? AND customer_id=?").bind(input.threadId,input.customerId).first<Row>();leadId=text(linked?.lead_id);}
 }

 if(!leadId)return{policyDecision:"followup_context_required",output:"Please use the conversation for your existing enquiry so the team can record this followup against the correct lead.",receipt:{scheduled:false,externalDelivery:false}};
 const ownedLead=await db.prepare("SELECT customer_id FROM lead_work_items WHERE id=?").bind(leadId).first<Row>();if(!ownedLead||text(ownedLead.customer_id)!==input.customerId)throw new Response("Followup lead ownership denied",{status:403});
 const dates=value.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/g)||[];
 const date=dates[0]?.slice(0,10),parts=date?.split("-").map(Number),calendar=parts?new Date(Date.UTC(parts[0],parts[1]-1,parts[2])):null;
 const validCalendar=parts&&calendar?.getUTCFullYear()===parts[0]&&calendar?.getUTCMonth()===parts[1]-1&&calendar?.getUTCDate()===parts[2];
 const requestedAt=dates.length===1&&validCalendar?Date.parse(dates[0]):undefined;
 if(!declined&&(dates.length!==1||!Number.isFinite(requestedAt)))return{policyDecision:"followup_date_required",output:"When would you like the team to follow up? Please give the date, time and timezone; nothing has been scheduled.",receipt:{scheduled:false,externalDelivery:false}};
 await assertNativeDemoBusinessAllowed(db,input.threadId);
 await db.prepare("CREATE TABLE IF NOT EXISTS ai_conversation_followup_receipts (turn_key TEXT PRIMARY KEY,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL,input_message_id TEXT NOT NULL,channel TEXT NOT NULL,lead_id TEXT NOT NULL,message TEXT NOT NULL,callback_id TEXT,result_json TEXT,created_at INTEGER NOT NULL)").run();
 const prior=await db.prepare("SELECT * FROM ai_conversation_followup_receipts WHERE turn_key=?").bind(input.turnKey).first<Row>();
 if(prior&&(text(prior.customer_id)!==input.customerId||text(prior.thread_id)!==input.threadId||text(prior.input_message_id)!==input.inputMessageId||text(prior.channel)!==input.channel||text(prior.lead_id)!==leadId||text(prior.message)!==value))throw new Response("Followup turn key belongs to another agreement",{status:409});
 let callbackId=text(prior?.callback_id)||undefined;
 if(declined&&!prior){await ensureLeadCallbackTables(db);const due=await db.prepare("SELECT id FROM lead_callbacks WHERE lead_id=? AND status IN ('scheduled','missed') ORDER BY created_at DESC LIMIT 1").bind(leadId).first<Row>();callbackId=text(due?.id)||undefined;}
 if(!prior)await db.prepare("INSERT OR IGNORE INTO ai_conversation_followup_receipts (turn_key,customer_id,thread_id,input_message_id,channel,lead_id,message,callback_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(input.turnKey,input.customerId,input.threadId,input.inputMessageId,input.channel,leadId,value,callbackId||null,Date.now()).run();
 const bound=await db.prepare("SELECT * FROM ai_conversation_followup_receipts WHERE turn_key=?").bind(input.turnKey).first<Row>();
 if(!bound||text(bound.customer_id)!==input.customerId||text(bound.thread_id)!==input.threadId||text(bound.input_message_id)!==input.inputMessageId||text(bound.channel)!==input.channel||text(bound.lead_id)!==leadId||text(bound.message)!==value)throw new Response("Followup receipt binding changed concurrently",{status:409});
 callbackId=text(bound.callback_id)||undefined;
 let result;
 if(bound.result_json)result=JSON.parse(text(bound.result_json));else{
  try{result=await recordAgreedBotFollowup(db,{customerId:input.customerId,leadId,agreed:!declined,requestedAt,callbackId,reason:value,idempotencyKey:`conversation-followup:${input.turnKey}`,actorId:input.actor.email});}
  catch(error){if(error instanceof LeadCallbackRefusal)return{policyDecision:"followup_refused",output:`The followup was not scheduled: ${error.message}`,receipt:{scheduled:false,externalDelivery:false}};throw error;}
  await db.prepare("UPDATE ai_conversation_followup_receipts SET result_json=?,callback_id=COALESCE(?,callback_id) WHERE turn_key=?").bind(JSON.stringify(result),result.callback?.id||null,input.turnKey).run();
 }
 const output=result.status==="scheduled"?`Your followup request is recorded for ${dates[0]}. The team still needs to make the call; no call or external message has been sent.`:result.status==="cancelled"||result.status==="declined"?"Your followup request is cancelled. No call or external message has been sent.":"The followup is not scheduled; the team needs to check it.";
 return{policyDecision:`followup_${result.status}`,output,receipt:{...result,receiptKey:input.turnKey,leadId,threadId:input.threadId}};
}

export function isExplicitConversationFollowup(value:string){return /^(?:please\s+)?(?:schedule|arrange|request|cancel|stop|do not schedule|don't schedule)\s+(?:my\s+|the\s+|a\s+)?(?:follow[- ]?up|callback)\b/i.test(value)||/^(?:i want|i would like|yes)\s+(?:a\s+)?(?:follow[- ]?up|callback)\b/i.test(value);}
/** Replay a bound action receipt, distinguishing historical execution from the callback's current state. */
export async function readConversationFollowupReceipt(db:D1Database,input:{turnKey:string;customerId:string;threadId:string;inputMessageId:string}){
 let row:Row|null;try{row=await db.prepare("SELECT * FROM ai_conversation_followup_receipts WHERE turn_key=?").bind(input.turnKey).first<Row>();}catch(error){if(/no such table: (?:main\.)?ai_conversation_followup_receipts/i.test(String(error)))return null;throw error;}
 if(!row)return null;
 if(text(row.customer_id)!==input.customerId||text(row.thread_id)!==input.threadId||text(row.input_message_id)!==input.inputMessageId)throw new Response("Followup receipt ownership denied",{status:403});
 if(!row.result_json)return{receiptKey:input.turnKey,scheduled:false,status:"pending_retry",externalDelivery:false};
 const result=JSON.parse(text(row.result_json));let callbackCurrentStatus:string|null=null;
 if(row.callback_id){const callback=await db.prepare("SELECT status FROM lead_callbacks WHERE id=? AND lead_id=?").bind(row.callback_id,row.lead_id).first<Row>();if(!callback)throw new Error("Followup receipt callback cannot be verified");callbackCurrentStatus=text(callback.status);}
 return{...result,receiptKey:input.turnKey,leadId:text(row.lead_id),threadId:input.threadId,historicalOutcome:true,callbackCurrentStatus};
}
