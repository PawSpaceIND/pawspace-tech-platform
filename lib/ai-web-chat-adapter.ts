import{ensureCommunicationTables}from"./communication-engine";
import{orchestrateAiTurn}from"./ai-conversation-orchestrator";
import{requireCustomerOwnership,type AuthenticatedActor}from"./server-auth";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const STOP_WORDS=new Set(["a","an","and","are","can","do","does","for","how","i","in","is","me","of","on","the","to","what","which","with","you"]);
function searchTerms(value:string){return Array.from(new Set(value.toLowerCase().match(/[a-z0-9]+/g)||[])).filter(term=>term.length>1&&!STOP_WORDS.has(term));}

export async function ensureAiWebChatTables(db:D1Database){await ensureCommunicationTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS ai_web_leads (id TEXT PRIMARY KEY,session_key TEXT NOT NULL UNIQUE,name TEXT,email TEXT,phone TEXT,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS ai_web_chat_events (id TEXT PRIMARY KEY,thread_id TEXT,customer_id TEXT,event_type TEXT NOT NULL,actor_ref TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

export async function publicAiWebKnowledge(db:D1Database,input:{query:string}){await ensureAiWebChatTables(db);const query=text(input.query).toLowerCase(),terms=searchTerms(query);if(!query||!terms.length)return{mode:"public",knowledge:[],customerDataAccess:false,toolExecution:false};const rows=await db.prepare("SELECT id,title,content_text,visibility_scope_json,immutable_hash FROM ai_knowledge_source_versions WHERE status='active' ORDER BY version DESC LIMIT 100").all<Row>().catch(()=>({results:[]}));const knowledge=rows.results.filter(row=>{try{const scope=JSON.parse(text(row.visibility_scope_json)||"[]")as string[];return scope.includes("public")}catch{return false}}).map(row=>{const title=text(row.title).toLowerCase(),content=text(row.content_text).toLowerCase(),combined=`${title} ${content}`;let score=combined.includes(query)?100:0;for(const term of terms){if(title.includes(term))score+=5;if(content.includes(term))score+=2;}return{row,score};}).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,5).map(({row})=>({id:text(row.id),title:text(row.title),excerpt:text(row.content_text).slice(0,600),immutableHash:text(row.immutable_hash)}));return{mode:"public",knowledge,customerDataAccess:false,toolExecution:false};}

async function upsertAiWebLead(db:D1Database,input:{sessionKey:string;message:string;name?:string|null;email?:string|null;phone?:string|null}){
 await ensureAiWebChatTables(db);
 const sessionKey=text(input.sessionKey),message=text(input.message);
 if(!sessionKey||!message)throw new Response("Session and message are required",{status:400});
 const id=`AIWEBLEAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now();
 await db.prepare("INSERT INTO ai_web_leads (id,session_key,name,email,phone,message,status,created_at) VALUES (?,?,?,?,?,?,'new',?) ON CONFLICT(session_key) DO UPDATE SET name=COALESCE(excluded.name,ai_web_leads.name),email=COALESCE(excluded.email,ai_web_leads.email),phone=COALESCE(excluded.phone,ai_web_leads.phone),message=excluded.message").bind(id,sessionKey,text(input.name)||null,text(input.email)||null,text(input.phone)||null,message,now).run();
 return{captured:true,sessionKey,customerDataAccess:false};
}

export async function captureAiWebLead(db:D1Database,input:{sessionKey:string;message:string;name?:string|null;email?:string|null;phone?:string|null}){
 if(!db||typeof db.prepare!=="function")throw new Response("Lead capture storage is unavailable",{status:503});
 try{return await upsertAiWebLead(db,input);}
 catch(error){if(error instanceof Response)throw error;return upsertAiWebLead(db,input);}
}

async function openThread(db:D1Database,customerId:string){const existing=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>();if(existing)return text(existing.id);const id=`THREAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now();await db.batch([db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open','ai-orchestrator',NULL,?,?)").bind(id,customerId,now,now),db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(),id,"customer",customerId,customerId,now)]);return id;}

export async function runAuthenticatedAiWebChat(db:D1Database,input:{actor:AuthenticatedActor;customerId:string;text:string;idempotencyKey:string}){await ensureAiWebChatTables(db);await requireCustomerOwnership(db,input.actor,input.customerId);if(!text(input.text)||!text(input.idempotencyKey))throw new Error("Message and idempotency key are required");const prior=await db.prepare("SELECT id,thread_id FROM communication_messages WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(prior)return{duplicatePrevented:true,messageId:text(prior.id),threadId:text(prior.thread_id),autonomousExecution:false};const threadId=await openThread(db,input.customerId),messageId=`MSG-CHAT-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now();await db.batch([db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'inbound','chat','transactional','web_app_chat',?,'received','pawspace_web',NULL,?,?,?, ?,?)").bind(messageId,threadId,input.customerId,JSON.stringify({text:input.text}),input.idempotencyKey,JSON.stringify({authenticated:true,customerOwned:true,externalDelivery:false}),input.actor.email,now,now),db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=?").bind(now,threadId)]);const result=await orchestrateAiTurn(db,{actor:input.actor,threadId,customerId:input.customerId,inputMessageId:messageId,idempotencyKey:`ai:${input.idempotencyKey}`,channel:"chat"});await db.prepare("INSERT INTO ai_web_chat_events (id,thread_id,customer_id,event_type,actor_ref,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),threadId,input.customerId,"authenticated_turn",input.actor.email,JSON.stringify({outcome:result.turn&&typeof result.turn==="object"?(result.turn as Row).outcome:null,autonomousExecution:false}),now).run();return{duplicatePrevented:false,messageId,threadId,ai:result,autonomousExecution:false};}
