type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??""))as T}catch{return fallback}};
export type DeliveryEventType="accepted"|"sent"|"delivered"|"read"|"failed";
const rank:Record<string,number>={queued:0,scheduled:0,retry_pending:0,dispatching:1,provider_accepted:2,sent:3,delivered:4,read:5,dead_letter:6,suppressed:6};
const nextStatus:Record<Exclude<DeliveryEventType,"failed">,string>={accepted:"provider_accepted",sent:"sent",delivered:"delivered",read:"read"};
export function deliveryRank(status:unknown){return rank[text(status)]??0;}
export function shouldApplyDeliveryTransition(current:unknown,event:DeliveryEventType){
 if(event==="failed")return deliveryRank(current)<deliveryRank("delivered");
 return deliveryRank(nextStatus[event])>=deliveryRank(current);
}
export async function recordAtomicDeliveryEvent(db:D1Database,input:{messageId:string;provider:string;eventId:string;eventType:DeliveryEventType;providerReference?:string|null;detail?:Record<string,unknown>;now?:number}){
 const row=await db.prepare("SELECT m.status,o.status outbox_status,o.attempt_count,o.max_attempts,m.policy_json FROM communication_messages m LEFT JOIN communication_outbox o ON o.message_id=m.id WHERE m.id=?").bind(input.messageId).first<Row>();
 if(!row)throw new Error("Communication message not found");
 const prior=await db.prepare("SELECT id FROM communication_message_delivery_events WHERE provider=? AND event_id=?").bind(input.provider,input.eventId).first<Row>();
 if(prior)return{duplicatePrevented:true,applied:false,status:text(row.status)};
 const eventType=input.eventType,now=input.now??Date.now(),current=text(row.status),apply=shouldApplyDeliveryTransition(current,eventType),statements:D1PreparedStatement[]=[];
 let status=current,outboxStatus=text(row.outbox_status),attempts=Number(row.attempt_count||0),nextAttemptAt:number|null=null,deadLettered=false;
 if(apply&&eventType==="failed"){
  attempts+=1;const max=Math.max(1,Number(row.max_attempts||5)),policy=parse<Record<string,unknown>>(row.policy_json,{}),base=Math.max(1,Number(policy.retryBaseMinutes||5));
  if(attempts>=max){status="dead_letter";outboxStatus="dead_letter";deadLettered=true;statements.push(db.prepare("UPDATE communication_outbox SET status='dead_letter',attempt_count=?,last_error=?,locked_at=NULL,updated_at=? WHERE message_id=?").bind(attempts,text(input.detail?.reason)||"provider_failed",now,input.messageId));statements.push(db.prepare("INSERT OR IGNORE INTO communication_dead_letters (id,message_id,reason,detail_json,created_at) VALUES (?,?,?,?,?)").bind(`DLQ-${input.messageId}`,input.messageId,text(input.detail?.reason)||"provider_failed",JSON.stringify({attempts,max,provider:input.provider,eventId:input.eventId}),now));}
  else{const backoffMinutes=Math.min(240,base*Math.pow(2,attempts-1));nextAttemptAt=now+backoffMinutes*60_000;status="retry_pending";outboxStatus="retry_pending";statements.push(db.prepare("UPDATE communication_outbox SET status='retry_pending',attempt_count=?,next_attempt_at=?,last_error=?,locked_at=NULL,updated_at=? WHERE message_id=?").bind(attempts,nextAttemptAt,text(input.detail?.reason)||"provider_failed",now,input.messageId));}
 }else if(apply&&eventType!=="failed"){status=nextStatus[eventType];outboxStatus=eventType==="accepted"?"sent":eventType;statements.push(db.prepare("UPDATE communication_outbox SET status=?,last_error=NULL,locked_at=NULL,updated_at=? WHERE message_id=?").bind(outboxStatus,now,input.messageId));}
 const eventDetail={...(input.detail??{}),applied:apply,previousStatus:current,nextStatus:status,previousOutboxStatus:text(row.outbox_status),nextOutboxStatus:outboxStatus,regressionPrevented:!apply};
 statements.unshift(db.prepare("INSERT OR IGNORE INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.messageId,input.provider,input.eventId,eventType,JSON.stringify(eventDetail),now));
 if(apply)statements.push(db.prepare("UPDATE communication_messages SET status=?,provider=?,provider_reference=COALESCE(?,provider_reference),updated_at=? WHERE id=?").bind(status,input.provider,text(input.providerReference)||null,now,input.messageId));
 await db.batch(statements);
 return{duplicatePrevented:false,applied:apply,status,previousStatus:current,outboxStatus,regressionPrevented:!apply,attempts,nextAttemptAt,deadLettered};
}