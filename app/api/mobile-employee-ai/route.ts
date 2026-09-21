import { runAuthenticatedAiWebChat } from "../../../lib/ai-web-chat-adapter";
import { ensureConversationAccessTables } from "../../../lib/conversation-access";
import { ensureCustomerAccountTables } from "../../../lib/customer-account";
import { authError, database, requirePermission, resolveActor, securityAudit } from "../../../lib/server-auth";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin employee AI write blocked",{status:403});}
function requireEmployeeAi(actor:Awaited<ReturnType<typeof resolveActor>>){requirePermission(actor,"customers.manage");requirePermission(actor,"communications.message");return actor;}

export async function GET(request:Request){
 try{
  const actor=requireEmployeeAi(await resolveActor(request)),db=await database();
  await ensureConversationAccessTables(db);await ensureCustomerAccountTables(db);
  let customers:{results:Record<string,unknown>[]};
  try{customers=await db.prepare("SELECT id,name,area FROM crm_contacts ORDER BY updated_at DESC LIMIT 24").all<Record<string,unknown>>();}
  catch{customers=await db.prepare("SELECT id,name,city_id area FROM canonical_customers ORDER BY updated_at DESC LIMIT 24").all<Record<string,unknown>>();}
  const voiceAllowed=actor.permissions.includes("*")||actor.permissions.includes("communications.call");
  await securityAudit(db,actor,"mobile.employee_ai.bootstrap","mobile_employee_ai",null,"allowed",{voiceAllowed,customerCount:customers.results.length});
  return json({data:{actor:{name:actor.name,email:actor.email,roleCode:actor.roleCode},capabilities:{chat:true,voice:voiceAllowed,customerScoped:true},customers:customers.results.map(row=>({id:text(row.id),name:text(row.name)||text(row.id),area:text(row.area)||"Bengaluru"}))}});
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Employee AI mobile access is unavailable");}
}

type Body={action?:"chat";customerId?:string;message?:string;idempotencyKey?:string};
export async function POST(request:Request){
 let audited:{actor:ReturnType<typeof requireEmployeeAi>;db:Awaited<ReturnType<typeof database>>;customerId:string}|null=null;
 try{
  sameOrigin(request);
  const actor=requireEmployeeAi(await resolveActor(request)),db=await database(),body=await request.json() as Body;
  if(body.action!=="chat")return json({error:"Unsupported employee AI mobile action"},400);
  const customerId=text(body.customerId),message=text(body.message),idempotencyKey=text(body.idempotencyKey);
  audited={actor,db,customerId};
  if(!customerId||!message||!idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);
  const result=await runAuthenticatedAiWebChat(db,{actor,customerId,text:message,idempotencyKey});
  await securityAudit(db,actor,"mobile.employee_ai.chat","communication_thread",result.threadId,"completed",{customerId,duplicatePrevented:result.duplicatePrevented,autonomousExecution:false});
  return json({data:result});
 }catch(error){
  if(error instanceof Response){
   const detail=await error.text();
   // A governed refusal (409 while staff own the thread) is still an employee-AI chat attempt: audit it as blocked.
   if(audited&&error.status===409)await securityAudit(audited.db,audited.actor,"mobile.employee_ai.chat","communication_thread",null,"blocked",{customerId:audited.customerId,status:error.status,detail}).catch(()=>{});
   return json({error:detail},error.status);
  }
  return authError(error,"Unable to process employee AI mobile chat");
 }
}
