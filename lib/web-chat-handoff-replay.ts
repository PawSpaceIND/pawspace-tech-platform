import{ensureAiHumanHandoff,requestAiHumanHandoff,type AiHandoffReason}from"./ai-human-handoff";
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
/** Bind the first chat request to its handoff in the handoff INSERT transaction.
 * A replay may repair a missing reply, but never reopen an already resumed queue. */
export async function requestReplayableWebChatHandoff(db:D1Database,input:{actorEmail:string;customerId:string;threadId:string;requestKey:string;reason:AiHandoffReason}){
 await ensureAiHumanHandoff(db);
 await db.prepare("CREATE TABLE IF NOT EXISTS web_chat_handoff_requests (request_key TEXT PRIMARY KEY,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL,reason TEXT NOT NULL,handoff_id TEXT,created_at INTEGER NOT NULL)").run();
 await db.prepare("SELECT request_key,customer_id,thread_id,reason,handoff_id,created_at FROM web_chat_handoff_requests LIMIT 0").all();
 const trigger=`CREATE TRIGGER IF NOT EXISTS trg_web_chat_handoff_request_v1 AFTER INSERT ON ai_handoffs BEGIN UPDATE web_chat_handoff_requests SET handoff_id=NEW.id WHERE handoff_id IS NULL AND customer_id=NEW.customer_id AND thread_id=NEW.thread_id; END`;
 await db.prepare(trigger).run();
 const saved=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_web_chat_handoff_request_v1'").first<Row>();
 const normalized=(sql:string)=>sql.replace(/IF NOT EXISTS/gi,"").replace(/\s+/g," ").trim().replace(/;$/,"").toLowerCase();
 if(!saved||normalized(text(saved.sql))!==normalized(trigger))throw new Response("Chat handoff binding is unavailable",{status:503});
 const thread=await db.prepare("SELECT customer_id FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
 if(text(thread?.customer_id)!==input.customerId)throw new Response("Chat thread belongs to another customer",{status:403});
 const key=JSON.stringify(["web-chat-handoff",input.customerId,input.requestKey]);
 await db.prepare("INSERT INTO web_chat_handoff_requests (request_key,customer_id,thread_id,reason,handoff_id,created_at) VALUES (?,?,?,?,NULL,?) ON CONFLICT(request_key) DO NOTHING").bind(key,input.customerId,input.threadId,input.reason,Date.now()).run();
 const original=await db.prepare("SELECT * FROM web_chat_handoff_requests WHERE request_key=?").bind(key).first<Row>();
 if(!original||text(original.customer_id)!==input.customerId||text(original.thread_id)!==input.threadId)throw new Response("Chat handoff request ownership denied",{status:403});
 const verify=async(id:string)=>{const handoff=await db.prepare("SELECT * FROM ai_handoffs WHERE id=?").bind(id).first<Row>();if(!handoff||text(handoff.customer_id)!==input.customerId||text(handoff.thread_id)!==input.threadId)throw new Response("Chat handoff ownership denied",{status:403});return{handoff,duplicatePrevented:true};};
 if(text(original.handoff_id))return verify(text(original.handoff_id));
 const active=await db.prepare("SELECT id FROM ai_handoffs WHERE thread_id=? AND customer_id=? AND status IN ('queued','staff_active') LIMIT 1").bind(input.threadId,input.customerId).first<Row>();
 if(active){await db.prepare("UPDATE web_chat_handoff_requests SET handoff_id=? WHERE request_key=? AND handoff_id IS NULL").bind(text(active.id),key).run();}
 else await requestAiHumanHandoff(db,{actorEmail:input.actorEmail,customerId:input.customerId,threadId:input.threadId,reason:text(original.reason) as AiHandoffReason,confidence:null});
 const bound=await db.prepare("SELECT handoff_id FROM web_chat_handoff_requests WHERE request_key=?").bind(key).first<Row>();
 if(!text(bound?.handoff_id))throw new Response("Chat handoff was not bound",{status:503});
 return verify(text(bound?.handoff_id));
}
