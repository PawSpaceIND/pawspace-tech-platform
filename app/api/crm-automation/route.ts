import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{automationDecision,ensureCrmAutomationGovernance,queueGovernedAutomation,recordAutomationFailure}from"../../../lib/crm-automation-governance";

type Body={action?:string;policyKey?:string;enabled?:boolean;quietStartHour?:number|null;quietEndHour?:number|null;maxContacts?:number|null;windowHours?:number|null;maxAttempts?:number|null;retryMinutes?:number|null;customerId?:string;journeyCode?:string;channel?:string;purpose?:"marketing"|"service";idempotencyKey?:string;dispatchId?:string;error?:string;providerReference?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin CRM automation write blocked",{status:403});}
export async function GET(request:Request){try{await authorize(request,"customers.view");const db=await database();await ensureCrmAutomationGovernance(db);const [policies,dispatches,deadLetters]=await Promise.all([db.prepare("SELECT * FROM crm_automation_policy ORDER BY policy_key").all(),db.prepare("SELECT * FROM crm_automation_dispatches ORDER BY updated_at DESC LIMIT 200").all(),db.prepare("SELECT * FROM crm_automation_dead_letters WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100").all()]);return json({data:{policies:policies.results,dispatches:dispatches.results,deadLetters:deadLetters.results,source:"governed_crm_automation",liveDelivery:false}});}catch(error){return authError(error,"Unable to load CRM automation governance");}}
export async function POST(request:Request){try{sameOrigin(request);const actor=await authorize(request,"customers.manage"),body=await request.json() as Body,db=await database();await ensureCrmAutomationGovernance(db);const now=Date.now();
 if(body.action==="save_policy"){
  if(!body.policyKey)return json({error:"Policy key is required"},400);
  const ints=[body.quietStartHour,body.quietEndHour].filter(value=>value!==null&&value!==undefined);if(ints.some(value=>!Number.isInteger(value)||Number(value)<0||Number(value)>23))return json({error:"Quiet-hour values must be 0-23"},400);
  for(const value of [body.maxContacts,body.windowHours,body.maxAttempts,body.retryMinutes])if(value!==null&&value!==undefined&&(!Number.isFinite(value)||Number(value)<0))return json({error:"Automation limits must be non-negative numbers"},400);
  await db.prepare("INSERT INTO crm_automation_policy (policy_key,enabled,quiet_start_hour,quiet_end_hour,max_contacts,window_hours,max_attempts,retry_minutes,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(policy_key) DO UPDATE SET enabled=excluded.enabled,quiet_start_hour=excluded.quiet_start_hour,quiet_end_hour=excluded.quiet_end_hour,max_contacts=excluded.max_contacts,window_hours=excluded.window_hours,max_attempts=excluded.max_attempts,retry_minutes=excluded.retry_minutes,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
   .bind(body.policyKey,body.enabled?1:0,body.quietStartHour??null,body.quietEndHour??null,body.maxContacts??null,body.windowHours??null,body.maxAttempts??null,body.retryMinutes??null,actor.email,now).run();await securityAudit(db,actor,"crm.automation.policy","automation_policy",body.policyKey,"completed",{enabled:Boolean(body.enabled)});return json({ok:true,policyKey:body.policyKey});
 }
 if(body.action==="decision"){
  if(!body.customerId||!body.channel||!body.purpose)return json({error:"Customer, channel and purpose are required"},400);return json({data:await automationDecision(db,{customerId:body.customerId,purpose:body.purpose,channel:body.channel})});
 }
 if(body.action==="queue"){
  if(!body.customerId||!body.journeyCode||!body.channel||!body.purpose||!body.idempotencyKey)return json({error:"Complete automation request is required"},400);const result=await queueGovernedAutomation(db,{customerId:body.customerId,journeyCode:body.journeyCode,channel:body.channel,purpose:body.purpose,idempotencyKey:body.idempotencyKey});await securityAudit(db,actor,"crm.automation.queue","customer",body.customerId,result.queued?"completed":"blocked",{journeyCode:body.journeyCode,channel:body.channel,purpose:body.purpose,decision:result.decision});return json({data:result},result.queued?201:409);
 }
 if(body.action==="failure"){
  if(!body.dispatchId||!body.error)return json({error:"Dispatch ID and error are required"},400);return json({data:await recordAutomationFailure(db,body.dispatchId,body.error,actor.email)});
 }
 if(body.action==="delivered"){
  if(!body.dispatchId)return json({error:"Dispatch ID is required"},400);await db.prepare("UPDATE crm_automation_dispatches SET status='delivered',provider_reference=?,last_error=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?").bind(body.providerReference||null,now,body.dispatchId).run();await securityAudit(db,actor,"crm.automation.delivered","automation_dispatch",body.dispatchId,"completed",{providerReference:body.providerReference||null});return json({ok:true,id:body.dispatchId,status:"delivered"});
 }
 return json({error:"Unsupported CRM automation action"},400);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to update CRM automation governance");}}
