import { randomUUID } from "node:crypto";
import type { NotificationEvent, PlatformRepository } from "./domain.js";

export async function enqueueNotification(repository:PlatformRepository,input:Omit<NotificationEvent,"id"|"status"|"attempts"|"nextAttemptAt"|"createdAt"|"updatedAt">){
  const timestamp=new Date().toISOString();
  const event:NotificationEvent={...input,id:`notify_${randomUUID().replaceAll("-","").slice(0,16)}`,status:"pending",attempts:0,nextAttemptAt:timestamp,createdAt:timestamp,updatedAt:timestamp};
  return repository.enqueueNotification(event);
}

export async function processNotification(repository:PlatformRepository,id:string,deliveredChannels:NotificationEvent["channels"],options:{verifiedDelivery?:boolean}={}){
  if(deliveredChannels.length&&!options.verifiedDelivery)throw Object.assign(new Error("Delivered channels require verified provider evidence"),{statusCode:409,code:"DELIVERY_EVIDENCE_REQUIRED"});
  const pending=(await repository.listNotifications()).find(x=>x.id===id);
  if(!pending)return null;
  const prior=Array.isArray(pending.payload.deliveredChannels)?pending.payload.deliveredChannels.filter((x):x is NotificationEvent["channels"][number]=>typeof x==="string"&&pending.channels.includes(x as NotificationEvent["channels"][number])):[];
  const delivered=[...new Set([...prior,...deliveredChannels])];
  const allDelivered=pending.channels.every(channel=>delivered.includes(channel));
  const attempts=pending.attempts+1;
  const retryMinutes=Math.min(60,2**Math.min(attempts,5));
  return repository.updateNotification(id,{status:allDelivered?"sent":delivered.length?"partially_sent":"failed",attempts,nextAttemptAt:allDelivered?new Date().toISOString():new Date(Date.now()+retryMinutes*60_000).toISOString(),updatedAt:new Date().toISOString(),payload:{...pending.payload,deliveredChannels:delivered}});
}