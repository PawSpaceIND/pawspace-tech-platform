import{parseBotState,type BotState}from"./web-chat-bot";

/**
 * Where the guided bot's position in a conversation is kept, for every channel that runs it: web chat
 * visitors (`public:<session>`), signed-in web chat customers (`customer:<id>`) and WhatsApp threads
 * (`whatsapp:<thread>`). One table, so the same flows behave the same way everywhere.
 */
type Row=Record<string,unknown>;
export async function ensureBotSessionTable(db:D1Database){await db.prepare("CREATE TABLE IF NOT EXISTS web_chat_bot_sessions (session_ref TEXT PRIMARY KEY,state_json TEXT NOT NULL,updated_at INTEGER NOT NULL)").run();}
export async function loadBotSession(db:D1Database,sessionRef:string){await ensureBotSessionTable(db);const row=await db.prepare("SELECT state_json FROM web_chat_bot_sessions WHERE session_ref=?").bind(sessionRef).first<Row>();return parseBotState(row?.state_json);}
export async function saveBotSession(db:D1Database,sessionRef:string,state:BotState){await ensureBotSessionTable(db);await db.prepare("INSERT INTO web_chat_bot_sessions (session_ref,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(session_ref) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at").bind(sessionRef,JSON.stringify(state),Date.now()).run();}
