import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NotificationEvent, PlatformRepository } from "./domain.js";
import { evaluateCommunicationPolicy, voiceSafetyState } from "./lane3.js";
import { processNotification } from "./notifications.js";

export type IntegrationKey = "database" | "otp" | "whatsapp" | "sms" | "email" | "push" | "payments" | "payouts" | "maps" | "media" | "ai" | "voice";
export type IntegrationMode = "sandbox" | "production";
export interface IntegrationHealth { key:IntegrationKey; provider:string; mode:IntegrationMode; status:"ready"|"configuration_required"|"degraded"|"disabled"; lastCheckedAt:string; }
export interface DeliveryResult { channel:NotificationEvent["channels"][number]; delivered:boolean; providerMessageId?:string; errorCode?:string; }

const now=()=>new Date().toISOString();
const ref=(prefix:string,input:string)=>`${prefix}_${createHash("sha256").update(input).digest("hex").slice(0,16)}`;
const configured=(key:string)=>Boolean(process.env[key]?.trim());

function modeFor(required:string[]):IntegrationMode{return required.every(configured)?"production":"sandbox";}
function constantTimeEqual(expected:string,received:string){
  const left=Buffer.from(expected,"utf8");
  const right=Buffer.from(received,"utf8");
  return left.length===right.length&&timingSafeEqual(left,right);
}

export function verifyHmac(payload:string,signature:string,secret:string){
  if(!payload||!signature||!secret)return false;
  const expected=createHmac("sha256",secret).update(payload,"utf8").digest("hex");
  return constantTimeEqual(expected,signature.trim());
}

const requiredForChannel:Record<NotificationEvent["channels"][number],string[]>={
  push:["PUSH_SERVICE_ACCOUNT"],
  whatsapp:["WHATSAPP_ACCESS_TOKEN"],
  sms:["SMS_API_KEY"],
  email:["EMAIL_API_KEY"],
  voice:["VOICE_PROVIDER_API_KEY"],
};

export class IntegrationGateway {
  constructor(private readonly options:{failChannels?:Set<NotificationEvent["channels"][number]>;allowSandboxSuccess?:boolean}={}){}

  health():IntegrationHealth[]{
    const checked=now();
    const row=(key:IntegrationKey,provider:string,mode:IntegrationMode,status?:IntegrationHealth["status"]):IntegrationHealth=>({key,provider,mode,status:status??(mode==="production"?"ready":"configuration_required"),lastCheckedAt:checked});
    const databaseReady=process.env.DATABASE_DRIVER==="mongodb"&&configured("MONGODB_URI");
    const voice=voiceSafetyState();
    return [
      row("database",databaseReady?"MongoDB Atlas":"In-memory sandbox",databaseReady?"production":"sandbox",databaseReady?"ready":"configuration_required"),
      row("otp",process.env.OTP_PROVIDER??"OTP adapter not connected","sandbox","configuration_required"),
      row("whatsapp",process.env.WHATSAPP_PROVIDER??"WhatsApp adapter not connected","sandbox","configuration_required"),
      row("sms",process.env.SMS_PROVIDER??"SMS adapter not connected","sandbox","configuration_required"),
      row("email",process.env.EMAIL_PROVIDER??"Email adapter not connected","sandbox","configuration_required"),
      row("push",process.env.PUSH_PROVIDER??"Push adapter not connected","sandbox","configuration_required"),
      row("payments","Razorpay",modeFor(["RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET"])),
      row("payouts","RazorpayX",modeFor(["RAZORPAYX_ACCOUNT_NUMBER","RAZORPAY_KEY_SECRET"])),
      row("maps",process.env.MAPS_PROVIDER??"Maps adapter not connected","sandbox","configuration_required"),
      row("media",process.env.MEDIA_PROVIDER??"Object storage adapter not connected","sandbox","configuration_required"),
      row("ai",process.env.AI_PROVIDER??"AI adapter not connected","sandbox","configuration_required"),
      row("voice",process.env.VOICE_PROVIDER??"Voice provider","sandbox",voice.enabled?(voice.canDial?"ready":"configuration_required"):"disabled"),
    ];
  }

  async sendOtp(phone:string,purpose:string){return {provider:"otp-sandbox",challengeRef:ref("otp",`${phone}:${purpose}:${Date.now()}`),accepted:true};}

  async deliver(channel:NotificationEvent["channels"][number],event:NotificationEvent):Promise<DeliveryResult>{
    if(channel==="voice"){const voice=voiceSafetyState();if(!voice.canDial)return {channel,delivered:false,errorCode:voice.reason};}
    if(this.options.failChannels?.has(channel))return {channel,delivered:false,errorCode:"SANDBOX_PROVIDER_UNAVAILABLE"};
    if(this.options.allowSandboxSuccess)return {channel,delivered:true,providerMessageId:ref(channel,`${event.id}:${event.attempts}`)};
    const ready=requiredForChannel[channel].every(configured);
    if(!ready)return {channel,delivered:false,errorCode:"PROVIDER_NOT_CONFIGURED"};
    return {channel,delivered:false,errorCode:"PROVIDER_ADAPTER_NOT_CONNECTED"};
  }

  async createPaymentOrder(amount:number,receipt:string){return {provider:"razorpay-sandbox",orderId:ref("order",`${receipt}:${amount}`),amount,currency:"INR",status:"created"};}
  async createPayout(amount:number,providerId:string){return {provider:"razorpayx-sandbox",payoutId:ref("payout",`${providerId}:${amount}:${Date.now()}`),amount,currency:"INR",status:"queued"};}

  async quoteRoute(origin:string,destination:string){
    if(!this.options.allowSandboxSuccess){
      const code=configured("MAPS_API_KEY")?"MAPS_ADAPTER_NOT_CONNECTED":"MAPS_NOT_CONFIGURED";
      throw Object.assign(new Error(code),{statusCode:503,code});
    }
    const seed=parseInt(createHash("sha256").update(`${origin}:${destination}`).digest("hex").slice(0,4),16);
    const distanceKm=Number((3+(seed%220)/10).toFixed(1));
    return {provider:"maps-sandbox",routeId:ref("route",`${origin}:${destination}`),distanceKm,durationMinutes:Math.round(distanceKm*3.2+18),trackingReady:true};
  }
}

export function buildIntegrationGateway(options?:{failChannels?:Set<NotificationEvent["channels"][number]>;allowSandboxSuccess?:boolean}){return new IntegrationGateway(options);}

function notificationPurpose(event:NotificationEvent):"service"|"reminder"|"marketing"{const explicit=String(event.payload.purpose??"");if(explicit==="service"||explicit==="reminder"||explicit==="marketing")return explicit;const value=`${event.eventType} ${event.templateCode}`.toLowerCase();return value.includes("marketing")||value.includes("campaign")?"marketing":value.includes("reminder")?"reminder":"service";}
function priorPolicy(event:NotificationEvent,channel:NotificationEvent["channels"][number]){const decisions=event.payload.policyDecisions;if(!decisions||typeof decisions!=="object"||Array.isArray(decisions))return null;const decision=(decisions as Record<string,unknown>)[channel];if(!decision||typeof decision!=="object"||Array.isArray(decision))return null;const row=decision as Record<string,unknown>;return typeof row.allowed==="boolean"&&typeof row.reason==="string"?{allowed:row.allowed,reason:String(row.reason)}:null;}

export async function processNotificationOutbox(repository:PlatformRepository,gateway:IntegrationGateway,limit=25){
  const all=await repository.listNotifications();
  const due=all.filter(event=>["pending","partially_sent","failed"].includes(event.status)&&new Date(event.nextAttemptAt).getTime()<=Date.now()).slice(0,limit);
  const results=[];
  for(const event of due){
    if(event.attempts>=5){results.push({notificationId:event.id,status:"dead_letter",deliveredChannels:[]});continue;}
    const prior=Array.isArray(event.payload.deliveredChannels)?event.payload.deliveredChannels.filter((x):x is NotificationEvent["channels"][number]=>typeof x==="string"&&event.channels.includes(x as NotificationEvent["channels"][number])):[];
    const remaining=event.channels.filter(channel=>!prior.includes(channel));
    const preference=event.customerId?await repository.getCommunicationPreference(event.customerId):null;
    const purpose=notificationPurpose(event),policyDecisions:Record<string,{allowed:boolean;reason:string;evaluatedAt:string}>={};
    const deliveries:DeliveryResult[]=[];
    for(const channel of remaining){
      let decision=priorPolicy(event,channel);
      if(!decision&&event.customerId){const cutoff=Date.now()-24*60*60_000;const sentInLast24Hours=all.filter(other=>other.id!==event.id&&other.customerId===event.customerId&&new Date(other.updatedAt).getTime()>=cutoff&&Array.isArray(other.payload.deliveredChannels)&&(other.payload.deliveredChannels as unknown[]).includes(channel)).length;decision=evaluateCommunicationPolicy({preference,channel,purpose,at:new Date(),sentInLast24Hours,timeZone:typeof event.payload.timeZone==="string"?event.payload.timeZone:"Asia/Kolkata"});}
      if(decision){policyDecisions[channel]={...decision,evaluatedAt:new Date().toISOString()};if(!decision.allowed){deliveries.push({channel,delivered:false,errorCode:`POLICY_${decision.reason}`});continue;}}
      deliveries.push(await gateway.deliver(channel,event));
    }
    if(Object.keys(policyDecisions).length)await repository.updateNotification(event.id,{payload:{...event.payload,policyDecisions:{...(event.payload.policyDecisions&&typeof event.payload.policyDecisions==="object"?event.payload.policyDecisions:{}),...policyDecisions}},updatedAt:new Date().toISOString()});
    const delivered=[...new Set([...prior,...deliveries.filter(x=>x.delivered).map(x=>x.channel)])];
    const updated=await processNotification(repository,event.id,delivered,{verifiedDelivery:true});
    results.push({notificationId:event.id,status:updated?.status??"missing",deliveredChannels:delivered,failures:deliveries.filter(x=>!x.delivered).map(x=>({channel:x.channel,errorCode:x.errorCode}))});
  }
  return {evaluated:due.length,results,runId:`gateway_${randomUUID().replaceAll("-","").slice(0,16)}`};
}