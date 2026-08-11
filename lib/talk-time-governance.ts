type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/**
 * Real call-duration tracking. The real Exotel adapter isn't connected yet (no live credentials,
 * same sandboxed state as Razorpay/WhatsApp elsewhere in this codebase) - so this is an explicit,
 * governed ledger a rep or system can record real call segments into now, with the exact same shape
 * a real Exotel webhook handler would populate once connected. Nothing here fabricates a duration;
 * every row is a specific, attributable call segment.
 */
export async function ensureTalkTimeTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS rep_call_segments (id TEXT PRIMARY KEY,rep_email TEXT NOT NULL,lead_id TEXT,call_date TEXT NOT NULL,duration_minutes REAL NOT NULL,source TEXT NOT NULL DEFAULT 'manual_entry',provider_call_id TEXT,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_rep_call_segments_rep_date ON rep_call_segments(rep_email,call_date)"),
]);}

export async function recordCallSegment(db:Db,input:{repEmail:string;leadId?:string|null;callDate:string;durationMinutes:number;providerCallId?:string|null;actorId:string}){
 await ensureTalkTimeTables(db);
 if(!text(input.repEmail)||!/^\d{4}-\d{2}-\d{2}$/.test(input.callDate))throw new Error("Rep and a real call date are required");
 if(!Number.isFinite(input.durationMinutes)||input.durationMinutes<=0)throw new Error("Call duration must be a real positive number of minutes");
 if(input.durationMinutes>480)throw new Error("A single call segment longer than 8 hours is almost certainly a data-entry error, not a real call");
 const now=Date.now();
 await db.prepare("INSERT INTO rep_call_segments (id,rep_email,lead_id,call_date,duration_minutes,source,provider_call_id,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)")
   .bind(uid("CALL"),input.repEmail,input.leadId||null,input.callDate,input.durationMinutes,"manual_entry",input.providerCallId||null,input.actorId,now).run();
 return{repEmail:input.repEmail,callDate:input.callDate,durationMinutes:input.durationMinutes};
}

export async function dailyTalkTimeSummary(db:Db,input:{repEmail:string;callDate:string}){
 await ensureTalkTimeTables(db);
 const row=await db.prepare("SELECT COUNT(*) segments,COALESCE(SUM(duration_minutes),0) total_minutes FROM rep_call_segments WHERE rep_email=? AND call_date=?")
   .bind(input.repEmail,input.callDate).first<Row>();
 return{repEmail:input.repEmail,callDate:input.callDate,segments:Number(row?.segments||0),totalMinutes:Math.round(Number(row?.total_minutes||0)*100)/100};
}
