import{authError,database,resolveActor,securityAudit}from"../../../lib/server-auth";
import{captureAiWebLead,publicAiWebKnowledge,runAuthenticatedAiWebChat}from"../../../lib/ai-web-chat-adapter";

type Body={mode?:"public"|"authenticated";sessionKey?:string;query?:string;message?:string;name?:string;email?:string;phone?:string;customerId?:string;idempotencyKey?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin AI web chat write blocked",{status:403});}

export async function GET(request:Request){try{const db=await database(),url=new URL(request.url),query=url.searchParams.get("q")||"";const data=await publicAiWebKnowledge(db,{query});return json({data});}catch(error){return authError(error,"Unable to load public AI chat knowledge");}}

export async function POST(request:Request){try{sameOrigin(request);const db=await database(),body=await request.clone().json()as Body,mode=body.mode||"public";if(mode==="public"){if(body.message&&body.sessionKey){const lead=await captureAiWebLead(db,{sessionKey:body.sessionKey,message:body.message,name:body.name,email:body.email,phone:body.phone});return json({data:{mode:"public",lead,customerDataAccess:false,toolExecution:false}},201);}const data=await publicAiWebKnowledge(db,{query:body.query||body.message||""});return json({data});}
 const actor=await resolveActor(request);if(!body.customerId||!body.message||!body.idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);const data=await runAuthenticatedAiWebChat(db,{actor,customerId:body.customerId,text:body.message,idempotencyKey:body.idempotencyKey});await securityAudit(db,actor,"ai.web_chat.turn","communication_thread",data.threadId,"completed",{duplicatePrevented:data.duplicatePrevented,autonomousExecution:false});return json({data},data.duplicatePrevented?200:201);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to process AI web chat");}}
