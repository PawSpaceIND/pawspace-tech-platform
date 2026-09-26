import{ensureD1Once}from"./d1-ensure-once.js";
import{parseBotState,type BotState}from"./web-chat-bot";

/**
 * Where the guided bot's position in a conversation is kept, for every channel that runs it: web chat
 * visitors (`public:<session>`), signed-in web chat customers (`customer:<id>`) and WhatsApp threads
 * (`whatsapp:<thread>`). One table, so the same flows behave the same way everywhere.
 *
 * Every row carries a version. Two messages from the same customer can arrive together; each turn claims
 * the version it read, so a stale turn cannot overwrite a newer answer - it re-reads and runs again.
 */
type Row=Record<string,unknown>;
/** Visitor sessions that have not moved for this long are removed; a visitor's lead lives on in the CRM. */
export const PUBLIC_BOT_SESSION_TTL_MS=7*24*60*60_000;

export async function ensureBotSessionTable(db:D1Database){return ensureD1Once(db,"web_chat_bot_session_table",async()=>{
 await db.prepare("CREATE TABLE IF NOT EXISTS web_chat_bot_sessions (session_ref TEXT PRIMARY KEY,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0)").run();
 // Environments that created the table before it carried a version gain the column.
 await db.prepare("ALTER TABLE web_chat_bot_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0").run().catch((error:unknown)=>{if(!/duplicate column name/i.test(String((error as Error)?.message)))throw error;});
});}
export async function loadBotSessionVersion(db:D1Database,sessionRef:string){await ensureBotSessionTable(db);const row=await db.prepare("SELECT state_json,version FROM web_chat_bot_sessions WHERE session_ref=?").bind(sessionRef).first<Row>();return{state:parseBotState(row?.state_json),version:row?Number(row.version||0):null};}
export async function loadBotSession(db:D1Database,sessionRef:string){return(await loadBotSessionVersion(db,sessionRef)).state;}
/** Unconditional save, for writers that own the whole session (a fresh start). */
export async function saveBotSession(db:D1Database,sessionRef:string,state:BotState,at=Date.now()){await ensureBotSessionTable(db);await db.prepare("INSERT INTO web_chat_bot_sessions (session_ref,state_json,updated_at,version) VALUES (?,?,?,1) ON CONFLICT(session_ref) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at,version=web_chat_bot_sessions.version+1").bind(sessionRef,JSON.stringify(state),at).run();}
/** Save only if nobody else saved since `version` was read (null: the session did not exist). */
export async function claimBotSession(db:D1Database,sessionRef:string,state:BotState,version:number|null,at=Date.now()){
 await ensureBotSessionTable(db);
 const result=version===null
  ?await db.prepare("INSERT OR IGNORE INTO web_chat_bot_sessions (session_ref,state_json,updated_at,version) VALUES (?,?,?,1)").bind(sessionRef,JSON.stringify(state),at).run()
  :await db.prepare("UPDATE web_chat_bot_sessions SET state_json=?,updated_at=?,version=version+1 WHERE session_ref=? AND version=?").bind(JSON.stringify(state),at,sessionRef,version).run();
 return Number(result.meta?.changes||0)===1;
}
/**
 * Read, compute and claim, retrying when another turn claimed first. `step` must not have side effects:
 * they happen after the claim, once this turn owns the new state.
 */
export async function advanceBotSession<T extends{state:BotState}>(db:D1Database,sessionRef:string,step:(state:BotState)=>T,at=Date.now()){
 for(let attempt=0;attempt<3;attempt++){
  const current=await loadBotSessionVersion(db,sessionRef),result=step(current.state);
  if(await claimBotSession(db,sessionRef,result.state,current.version,at))return{...result,previous:current.state};
 }
 throw new Response("This conversation is busy - please send your message again.",{status:409});
}
/** Removes visitor sessions idle past the retention window. */
export async function purgeStalePublicBotSessions(db:D1Database,asOf=Date.now()){await ensureBotSessionTable(db);const result=await db.prepare("DELETE FROM web_chat_bot_sessions WHERE session_ref LIKE 'public:%' AND updated_at<?").bind(asOf-PUBLIC_BOT_SESSION_TTL_MS).run();return Number(result.meta?.changes||0);}
