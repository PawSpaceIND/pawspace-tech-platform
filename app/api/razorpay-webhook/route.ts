import{database}from"../../../lib/server-auth";
import{processGatewayEvent,type GatewayEvent}from"../../../lib/grooming-payment-reconciliation";
import{resolvePaymentWebhookGate}from"../../../lib/payment-webhook-gate";

type RazorEntity=Record<string,unknown>;
type RazorPayload={event?:string;created_at?:number;payload?:Record<string,{entity?:RazorEntity}>};
const json=(value:unknown,status=200)=>Response.json(value,{status});

function hex(bytes:ArrayBuffer){return Array.from(new Uint8Array(bytes)).map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function safeEqual(a:string,b:string){if(a.length!==b.length)return false;let result=0;for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);return result===0;}
async function hmac(secret:string,body:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));}
async function sha256(body:string){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body)));}
function entity(payload:RazorPayload,key:string){return payload.payload?.[key]?.entity||{};}
function extract(payload:RazorPayload,eventId:string,payloadHash:string,environment:"sandbox"|"live"):GatewayEvent{
  const eventType=String(payload.event||"");const payment=entity(payload,"payment"),refund=entity(payload,"refund"),order=entity(payload,"order");const notes=(payment.notes&&typeof payment.notes==="object"?payment.notes:order.notes&&typeof order.notes==="object"?order.notes:{}) as Record<string,unknown>;
  const bookingId=String(notes.booking_id||notes.bookingId||notes.pawspace_booking_id||"").trim()||undefined;
  const amountEntity=eventType.startsWith("refund.")?refund:payment;const amount=Number(amountEntity.amount??order.amount_paid??0);
  return{provider:"razorpay",environment,eventId,eventType,bookingId,gatewayOrderId:String(payment.order_id||refund.order_id||order.id||"").trim()||undefined,gatewayPaymentId:String(refund.payment_id||payment.id||"").trim()||undefined,gatewayRefundId:String(refund.id||"").trim()||undefined,amountSubunits:Number.isFinite(amount)?amount:undefined,currency:String(amountEntity.currency||payment.currency||order.currency||"").trim()||undefined,createdAt:Number(payload.created_at||0)*1000||Date.now(),signatureVerified:true,payloadHash,detail:{contains:Object.keys(payload.payload||{}),source:"razorpay_webhook"}};
}

export async function POST(request:Request){
  try{
    const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
    const gate=resolvePaymentWebhookGate(runtime);if(!gate.ok)return json({error:gate.reason},gate.status);
    const signature=(request.headers.get("x-razorpay-signature")||"").trim().toLowerCase(),eventId=(request.headers.get("x-razorpay-event-id")||"").trim();if(!signature||!eventId)return json({error:"Razorpay signature and event ID are required"},400);
    const raw=await request.text();const expected=await hmac(gate.secret,raw);if(!safeEqual(expected,signature))return json({error:"Invalid Razorpay webhook signature"},401);
    let payload:RazorPayload;try{payload=JSON.parse(raw) as RazorPayload;}catch{return json({error:"Invalid webhook JSON"},400);}if(!payload.event)return json({error:"Webhook event type is required"},400);
    const db=await database();const result=await processGatewayEvent(db,extract(payload,eventId,await sha256(raw),gate.environment));return json({ok:true,environment:gate.environment,...result});
  }catch(error){return json({error:error instanceof Error?error.message:"Unable to process Razorpay webhook"},500);}
}
