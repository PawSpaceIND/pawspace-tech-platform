import{processMetaWhatsAppEvents,parseMetaWhatsAppWebhook,verifyMetaWebhookChallenge,verifyMetaWhatsAppSignature}from"../../../../lib/meta-whatsapp-webhook";
import{processMetaStatusEventAtomic}from"../../../../lib/whatsapp-production-runtime";

async function bindings(){const{env}=await import("cloudflare:workers");return env as unknown as{DB:D1Database;META_WHATSAPP_APP_SECRET?:string;META_WHATSAPP_VERIFY_TOKEN?:string;META_WHATSAPP_ACCESS_TOKEN?:string;META_WHATSAPP_UAT_ACCESS_TOKEN?:string;META_WHATSAPP_GRAPH_VERSION?:string;PAWSPACE_MEDIA_BUCKET?:unknown};}
const noStore={"cache-control":"no-store"};

export async function GET(request:Request){
 const env=await bindings(),challenge=verifyMetaWebhookChallenge(new URL(request.url),String(env.META_WHATSAPP_VERIFY_TOKEN||""));
 if(!challenge)return new Response("Webhook verification rejected",{status:403,headers:noStore});
 return new Response(challenge,{status:200,headers:{...noStore,"content-type":"text/plain; charset=utf-8"}});
}

export async function POST(request:Request){
 const env=await bindings(),rawBody=await request.text(),signature=request.headers.get("x-hub-signature-256"),secret=String(env.META_WHATSAPP_APP_SECRET||"");
 if(!secret)return Response.json({ok:false,error:"Meta WhatsApp webhook is not configured",externalDelivery:false},{status:503,headers:noStore});
 if(!await verifyMetaWhatsAppSignature(rawBody,signature,secret))return Response.json({ok:false,error:"Invalid Meta webhook signature",externalDelivery:false},{status:401,headers:noStore});
 let payload:unknown;try{payload=JSON.parse(rawBody);}catch{return Response.json({ok:false,error:"Invalid webhook JSON",externalDelivery:false},{status:400,headers:noStore});}
 const events=parseMetaWhatsAppWebhook(payload);
 if(events.length===0)return Response.json({ok:true,accepted:0,results:[],externalDelivery:false},{status:200,headers:noStore});
 try{
  const messages=events.filter(event=>event.kind==="message");
  const results:Array<Record<string,unknown>>=[];
  if(messages.length)results.push(...await processMetaWhatsAppEvents(env.DB,messages,rawBody,env as unknown as Record<string,unknown>));
  for(const event of events){
   if(event.kind==="status")results.push(await processMetaStatusEventAtomic(env.DB,event,rawBody));
  }
  return Response.json({ok:true,accepted:events.length,results,externalDelivery:false},{status:200,headers:noStore});
 }catch(error){
  if(error instanceof Response)return Response.json({ok:false,error:await error.text(),externalDelivery:false},{status:error.status,headers:noStore});
  return Response.json({ok:false,error:"Meta WhatsApp webhook processing failed",externalDelivery:false},{status:500,headers:noStore});
 }
}
