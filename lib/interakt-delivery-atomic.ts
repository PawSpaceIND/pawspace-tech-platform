import{resolveCanonicalRecipientOwnership}from"./canonical-recipient-ownership";
import{verifyInteraktWebhook}from"./interakt-whatsapp";
import{recordWhatsAppDeliveryEventAtomic}from"./whatsapp-production-runtime";

type Row=Record<string,unknown>;type Env=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const TYPES:Record<string,"sent"|"delivered"|"read"|"failed">={message_api_sent:"sent",message_api_delivered:"delivered",message_api_read:"read",message_api_failed:"failed"};

export async function recordInteraktDeliveryWebhookAtomic(db:D1Database,env:Env,input:{rawBody:string;headers:Headers}){
 const verified=await verifyInteraktWebhook(input.rawBody,input.headers,env);if(!verified.ok)return{accepted:false,status:verified.status,reason:verified.reason,externalDelivery:false};
 let body:Row;try{body=JSON.parse(input.rawBody)as Row}catch{return{accepted:false,status:400,reason:"invalid_json",externalDelivery:false};}
 const eventType=TYPES[text(body.type)];if(!eventType)return{accepted:true,status:200,matched:false,reason:"non_delivery_event",externalDelivery:true};const data=body.data&&typeof body.data==="object"?body.data as Row:{},messagePayload=data.message&&typeof data.message==="object"?data.message as Row:{},customerPayload=data.customer&&typeof data.customer==="object"?data.customer as Row:{},providerReference=text(messagePayload.id);if(!providerReference)return{accepted:true,status:200,matched:false,reason:"missing_provider_reference",externalDelivery:true};
 const message=await db.prepare("SELECT id,customer_id,lead_id,booking_id FROM communication_messages WHERE provider='interakt' AND provider_reference=?").bind(providerReference).first<Row>();if(!message)return{accepted:true,status:200,matched:false,reason:"unknown_provider_reference",externalDelivery:true};const callbackPhone=text(customerPayload.channel_phone_number);if(callbackPhone){try{await resolveCanonicalRecipientOwnership(db,env,{phone:callbackPhone,customerId:text(message.customer_id),leadId:text(message.lead_id)||null,bookingId:text(message.booking_id)||null,requireSuppliedPhone:true});}catch{return{accepted:true,status:200,matched:true,applied:false,reason:"recipient_customer_mismatch",externalDelivery:true};}}
 const eventId=`${text(body.type)}:${providerReference}:${text(body.timestamp)||"provider"}`,reason=eventType==="failed"?text(messagePayload.channel_failure_reason||messagePayload.channel_error_code)||"interakt_delivery_failed":undefined,result=await recordWhatsAppDeliveryEventAtomic(db,{messageId:text(message.id),provider:"interakt",eventId,eventType,detail:{reason}});return{...result,accepted:true,status:200,matched:true,messageId:text(message.id),eventType,externalDelivery:true};
}
