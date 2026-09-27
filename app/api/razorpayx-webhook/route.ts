import{processEmployeeSalaryWebhook}from"../../../lib/employee-payroll-payout";
import{authError,database}from"../../../lib/server-auth";
import{processRazorpayXWebhook}from"../../../lib/razorpayx-payout-runtime";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../lib/voice-safe-fetch";

const MAX_WEBHOOK_BYTES=262_144;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function POST(request:Request){
 try{
  const{env}=await import("cloudflare:workers");let raw:string;
  try{raw=await readBoundedRequestText(request,MAX_WEBHOOK_BYTES);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:"RazorpayX webhook payload is too large"},413);throw error;}
  const signature=String(request.headers.get("x-razorpay-signature")||"").trim().toLowerCase();if(!signature)return json({error:"RazorpayX signature is required"},400);
  const db=await database(),input={rawBody:raw,signature,eventId:request.headers.get("x-razorpay-event-id")};
  const salary=await processEmployeeSalaryWebhook(db,env as unknown as Record<string,unknown>,input);
  if(salary)return json(salary,salary.matched===false?202:200);
  const result=await processRazorpayXWebhook(db,env as unknown as Record<string,unknown>,input);
  return json(result,result.matched===false?202:200);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to process RazorpayX webhook");}
}
