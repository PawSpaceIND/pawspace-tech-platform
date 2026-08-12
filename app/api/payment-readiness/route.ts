import{authError,requirePermission,resolveActor}from"../../../lib/server-auth";
import{paymentWebhookReadiness}from"../../../lib/payment-webhook-gate";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Read-only payment webhook readiness: which environment is active, what's configured, and why the
// receiver is (or isn't) ready. Never returns any secret value.
export async function GET(request:Request){
  try{
    const actor=await resolveActor(request);requirePermission(actor,"payments.view");
    return json({data:paymentWebhookReadiness(await runtime())});
  }catch(error){return authError(error,"Unable to load payment readiness");}
}
