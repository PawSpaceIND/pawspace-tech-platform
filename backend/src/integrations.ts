import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NotificationEvent, PlatformRepository } from "./domain.js";
import { evaluateCommunicationPolicy, voiceSafetyState } from "./lane3.js";
import { processNotification } from "./notifications.js";
import { createRazorpayOrder, createRazorpayRefund, createRazorpayXPayout, fetchRazorpayOrder, fetchRazorpayPayment, paymentReadiness, payoutReadiness, resolveRazorpayXFundAccount, type FetchLike } from "./razorpay.js";

export type IntegrationKey = "database" | "otp" | "whatsapp" | "sms" | "email" | "push" | "payments" | "payouts" | "maps" | "media" | "ai" | "voice";
export type IntegrationMode = "sandbox" | "production";
export interface IntegrationHealth { key:IntegrationKey; provider:string; mode:IntegrationMode; status:"ready"|"configuration_required"|"degraded"|"disabled"; lastCheckedAt:string; }
export interface DeliveryResult { channel:NotificationEvent["channels"][number]; delivered:boolean; providerMessageId?:string; errorCode?:string; }

const now=()=>new Date().toISOString();
const ref=(prefix:string,input:string)=>`${prefix}_${createHash("sha256").update(input).digest("hex").slice(0,16)}`;
const configured=(env:NodeJS.ProcessEnv,key:string)=>Boolean(env[key]?.trim());

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

type GatewayOptions={failChannels?:Set<NotificationEvent["channels"][number]>;allowSandboxSuccess?:boolean;fetcher?:FetchLike;env?:NodeJS.ProcessEnv};

export class IntegrationGateway {
  private readonly env:NodeJS.ProcessEnv;
  private readonly fetcher:FetchLike;
  constructor(private readonly options:GatewayOptions={}){this.env=options.env??process.env;this.fetcher=options.fetcher??globalThis.fetch;}

  health():IntegrationHealth[]{
    const checked=now();
    const row=(key:IntegrationKey,provider:string,mode:IntegrationMode,status:IntegrationHealth["status"]):IntegrationHealth=>({key,provider,mode,status,lastCheckedAt:checked});
    const databaseReady=this.env.DATABASE_DRIVER==="mongodb"&&configured(this.env,"MONGODB_URI");
    const voice=voiceSafetyState(this.env);const payments=paymentReadiness(this.env),payouts=payoutReadiness(this.env);
    return [
      row("database",databaseReady?"MongoDB Atlas":"In-memory sandbox",databaseReady?"production":"sandbox",databaseReady?"ready":"configuration_required"),
      row("otp",this.env.OTP_PROVIDER??"OTP adapter not connected","sandbox","configuration_required"),
      row("whatsapp",this.env.WHATSAPP_PROVIDER??"WhatsApp adapter not connected","sandbox","configuration_required"),
      row("sms",this.env.SMS_PROVIDER??"SMS adapter not connected","sandbox","configuration_required"),
      row("email",this.env.EMAIL_PROVIDER??"Email adapter not connected","sandbox","configuration_required"),
      row("push",this.env.PUSH_PROVIDER??"Push adapter not connected","sandbox","configuration_required"),
      row("payments",payments.providerMode==="test"?"Razorpay Test":"Razorpay",payments.providerMode==="live"?"production":"sandbox",payments.ready?"ready":"configuration_required"),
      row("payouts",payouts.providerMode==="test"?"RazorpayX Test":"RazorpayX",payouts.providerMode==="live"?"production":"sandbox",payouts.ready?"ready":"configuration_required"),
      row("maps",this.env.MAPS_PROVIDER??"Maps adapter not connected","sandbox","configuration_required"),
      row("media",this.env.MEDIA_PROVIDER??"Object storage adapter not connected","sandbox","configuration_required"),
      row("ai",this.env.AI_PROVIDER??"AI adapter not connected","sandbox","configuration_required"),
      row("voice",this.env.VOICE_PROVIDER??"Voice provider","sandbox",voice.enabled?(voice.canDial?"ready":"configuration_required"):"disabled"),
    ];
  }

  async sendOtp(phone:string,purpose:string){return {provider:"otp-sandbox",challengeRef:ref("otp",`${phone}:${purpose}:${Date.now()}`),accepted:true};}

  async deliver(channel:NotificationEvent["channels"][number],event:NotificationEvent):Promise<DeliveryResult>{
    if(channel==="voice"){const voice=voiceSafetyState(this.env);if(!voice.canDial)return {channel,delivered:false,errorCode:voice.reason};}
    if(this.options.failChannels?.has(channel))return {channel,delivered:false,errorCode:"SANDBOX_PROVIDER_UNAVAILABLE"};
    if(this.options.allowSandboxSuccess)return {channel,delivered:true,providerMessageId:ref(channel,`${event.id}:${event.attempts}`)};
    const ready=requiredForChannel[channel].every(key=>configured(this.env,key));
    if(!ready)return {channel,delivered:false,errorCode:"PROVIDER_NOT_CONFIGURED"};
    return {channel,delivered:false,errorCode:"PROVIDER_ADAPTER_NOT_CONNECTED"};
  }

  async createPaymentOrder(amount:number,receipt:string){return createRazorpayOrder(amount,receipt,this.fetcher,this.env);}
  async fetchPaymentOrder(orderId:string){return fetchRazorpayOrder(orderId,this.fetcher,this.env);}
  async fetchPayment(paymentId:string){return fetchRazorpayPayment(paymentId,this.fetcher,this.env);}
  async refundPayment(paymentId:string,amount:number,idempotencyKey:string){return createRazorpayRefund(paymentId,amount,idempotencyKey,this.fetcher,this.env);}
  async createPayout(amount:number,providerId:string,idempotencyKey:string){const fundAccountId=resolveRazorpayXFundAccount(providerId,this.env);return createRazorpayXPayout(amount,fundAccountId,idempotencyKey,this.fetcher,this.env);}

  async quoteRoute(origin:string,destination:string){
    if(!this.options.allowSandboxSuccess){
      const code=configured(this.env,"MAPS_API_KEY")?"MAPS_ADAPTER_NOT_CONNECTED":"MAPS_NOT_CONFIGURED";
      throw Object.assign(new Error(code),{statusCode:503,code});
    }
    const seed=parseInt(createHash("sha256").update(`${origin}:${destination}`).digest("hex").slice(0,4),16);
    const distanceKm=Number((3+(seed%220)/10).toFixed(1));
    return {provider:"maps-sandbox",routeId:ref("route",`${origin}:${destination}`),distanceKm,durationMinutes:Math.round(distanceKm*3.2+18),trackingReady:true};
  }
}

export function buildIntegrationGateway(options?:GatewayOptions){return new IntegrationGateway(options);}

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
