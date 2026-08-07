import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NotificationEvent, PlatformRepository } from "./domain.js";
import { processNotification } from "./notifications.js";

export type IntegrationKey = "database" | "otp" | "whatsapp" | "sms" | "email" | "push" | "payments" | "payouts" | "maps";
export type IntegrationMode = "sandbox" | "production";
export interface IntegrationHealth { key:IntegrationKey; provider:string; mode:IntegrationMode; status:"ready"|"configuration_required"|"degraded"; lastCheckedAt:string; }
export interface DeliveryResult { channel:NotificationEvent["channels"][number]; delivered:boolean; providerMessageId?:string; errorCode?:string; }

const now=()=>new Date().toISOString();
const ref=(prefix:string,input:string)=>`${prefix}_${createHash("sha256").update(input).digest("hex").slice(0,16)}`;
const configured=(key:string)=>Boolean(process.env[key]);

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

export class IntegrationGateway {
  constructor(private readonly options:{failChannels?:Set<NotificationEvent["channels"][number]>}={}){}

  health():IntegrationHealth[]{
    const checked=now();
    const row=(key:IntegrationKey,provider:string,mode:IntegrationMode):IntegrationHealth=>({key,provider,mode,status:mode==="production"?"ready":"configuration_required",lastCheckedAt:checked});
    return [
      row("database",process.env.DATABASE_DRIVER==="mongodb"?"MongoDB Atlas":"In-memory sandbox",modeFor(["MONGODB_URI"])),
      row("otp",process.env.OTP_PROVIDER??"MSG91 sandbox",modeFor(["OTP_API_KEY"])),
      row("whatsapp",process.env.WHATSAPP_PROVIDER??"Meta WhatsApp sandbox",modeFor(["WHATSAPP_ACCESS_TOKEN"])),
      row("sms",process.env.SMS_PROVIDER??"MSG91 sandbox",modeFor(["SMS_API_KEY"])),
      row("email",process.env.EMAIL_PROVIDER??"Transactional email sandbox",modeFor(["EMAIL_API_KEY"])),
      row("push",process.env.PUSH_PROVIDER??"Firebase sandbox",modeFor(["PUSH_SERVICE_ACCOUNT"])),
      row("payments","Razorpay",modeFor(["RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET"])),
      row("payouts","RazorpayX",modeFor(["RAZORPAYX_ACCOUNT_NUMBER","RAZORPAY_KEY_SECRET"])),
      row("maps",process.env.MAPS_PROVIDER??"Google Maps sandbox",modeFor(["MAPS_API_KEY"])),
    ];
  }

  async sendOtp(phone:string,purpose:string){return {provider:"otp-sandbox",challengeRef:ref("otp",`${phone}:${purpose}:${Date.now()}`),accepted:true};}

  async deliver(channel:NotificationEvent["channels"][number],event:NotificationEvent):Promise<DeliveryResult>{
    if(this.options.failChannels?.has(channel))return {channel,delivered:false,errorCode:"SANDBOX_PROVIDER_UNAVAILABLE"};
    return {channel,delivered:true,providerMessageId:ref(channel,`${event.id}:${event.attempts}`)};
  }

  async createPaymentOrder(amount:number,receipt:string){return {provider:"razorpay-sandbox",orderId:ref("order",`${receipt}:${amount}`),amount,currency:"INR",status:"created"};}
  async createPayout(amount:number,providerId:string){return {provider:"razorpayx-sandbox",payoutId:ref("payout",`${providerId}:${amount}:${Date.now()}`),amount,currency:"INR",status:"queued"};}
  async quoteRoute(origin:string,destination:string){const seed=parseInt(createHash("sha256").update(`${origin}:${destination}`).digest("hex").slice(0,4),16);const distanceKm=Number((3+(seed%220)/10).toFixed(1));return {provider:"maps-sandbox",routeId:ref("route",`${origin}:${destination}`),distanceKm,durationMinutes:Math.round(distanceKm*3.2+18),trackingReady:true};}
}

export function buildIntegrationGateway(options?:{failChannels?:Set<NotificationEvent["channels"][number]>}){return new IntegrationGateway(options);}

export async function processNotificationOutbox(repository:PlatformRepository,gateway:IntegrationGateway,limit=25){
  const due=(await repository.listNotifications()).filter(event=>["pending","partially_sent","failed"].includes(event.status)&&new Date(event.nextAttemptAt).getTime()<=Date.now()).slice(0,limit);
  const results=[];
  for(const event of due){
    if(event.attempts>=5){results.push({notificationId:event.id,status:"dead_letter",deliveredChannels:[]});continue;}
    const prior=Array.isArray(event.payload.deliveredChannels)?event.payload.deliveredChannels.filter((x):x is NotificationEvent["channels"][number]=>typeof x==="string"&&event.channels.includes(x as NotificationEvent["channels"][number])):[];
    const remaining=event.channels.filter(channel=>!prior.includes(channel));
    const deliveries=await Promise.all(remaining.map(channel=>gateway.deliver(channel,event)));
    const delivered=[...new Set([...prior,...deliveries.filter(x=>x.delivered).map(x=>x.channel)])];
    const updated=await processNotification(repository,event.id,delivered);
    results.push({notificationId:event.id,status:updated?.status??"missing",deliveredChannels:delivered,failures:deliveries.filter(x=>!x.delivered).map(x=>({channel:x.channel,errorCode:x.errorCode}))});
  }
  return {evaluated:due.length,results,runId:`gateway_${randomUUID().replaceAll("-","").slice(0,16)}`};
}
