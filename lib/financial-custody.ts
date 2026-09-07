type Db=D1Database;
type Row=Record<string,unknown>;

export type FinancialCustodyState="HELD"|"DISPUTED_FROZEN"|"ARBITRATION_RELEASE_APPROVED"|"ARBITRATION_REALLOCATION_REQUIRED"|"RELEASED";

const ready=new WeakSet<object>();
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

export async function ensureFinancialCustodyTables(db:Db){
 const key=db as unknown as object;if(ready.has(key))return;
 await db.batch([
  db.prepare(`CREATE TABLE IF NOT EXISTS partner_fund_custody (
    booking_id TEXT PRIMARY KEY,
    pending_earning_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('HELD','DISPUTED_FROZEN','ARBITRATION_RELEASE_APPROVED','ARBITRATION_REALLOCATION_REQUIRED','RELEASED')),
    dispute_case_id TEXT,
    arbitration_decision TEXT,
    arbitration_actor TEXT,
    arbitration_at INTEGER,
    released_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_partner_fund_custody_state ON partner_fund_custody(state,updated_at)"),
 ]);
 ready.add(key);
}

export async function synchronizeFinancialCustody(db:Db,input:{bookingId:string;pendingEarningId:string;now?:number}){
 await ensureFinancialCustodyTables(db);const now=input.now??Date.now();
 await db.prepare(`INSERT INTO partner_fund_custody (booking_id,pending_earning_id,state,created_at,updated_at)
   VALUES (?,?,'HELD',?,?) ON CONFLICT(booking_id) DO NOTHING`).bind(input.bookingId,input.pendingEarningId,now,now).run();
 if(!(await tableExists(db,"booking_cancellation_cases")))return db.prepare("SELECT * FROM partner_fund_custody WHERE booking_id=?").bind(input.bookingId).first<Row>();
 const caseRow=await db.prepare("SELECT id,status,finance_decision,finance_decision_by,finance_decision_at FROM booking_cancellation_cases WHERE booking_id=? ORDER BY requested_at DESC LIMIT 1").bind(input.bookingId).first<Row>();
 if(!caseRow)return db.prepare("SELECT * FROM partner_fund_custody WHERE booking_id=?").bind(input.bookingId).first<Row>();
 const current=await db.prepare("SELECT state FROM partner_fund_custody WHERE booking_id=?").bind(input.bookingId).first<Row>();
 if(String(current?.state)==="RELEASED")return db.prepare("SELECT * FROM partner_fund_custody WHERE booking_id=?").bind(input.bookingId).first<Row>();
 if(String(caseRow.status)!=="closed"){
  await db.prepare("UPDATE partner_fund_custody SET state='DISPUTED_FROZEN',dispute_case_id=?,arbitration_decision=NULL,arbitration_actor=NULL,arbitration_at=NULL,updated_at=? WHERE booking_id=? AND state!='RELEASED'")
    .bind(String(caseRow.id),now,input.bookingId).run();
 }else{
  const decision=String(caseRow.finance_decision||"").trim().toLowerCase();
  const state:FinancialCustodyState=decision==="no_refund"?"ARBITRATION_RELEASE_APPROVED":"ARBITRATION_REALLOCATION_REQUIRED";
  await db.prepare("UPDATE partner_fund_custody SET state=?,dispute_case_id=?,arbitration_decision=?,arbitration_actor=?,arbitration_at=?,updated_at=? WHERE booking_id=? AND state!='RELEASED'")
    .bind(state,String(caseRow.id),decision||"unresolved",caseRow.finance_decision_by||null,caseRow.finance_decision_at||null,now,input.bookingId).run();
 }
 return db.prepare("SELECT * FROM partner_fund_custody WHERE booking_id=?").bind(input.bookingId).first<Row>();
}

export function custodyReleaseBlockReason(state:unknown){
 const value=String(state||"");
 if(value==="DISPUTED_FROZEN")return"Partner earning is frozen while a dispute is unresolved";
 if(value==="ARBITRATION_REALLOCATION_REQUIRED")return"Partner earning requires financial reallocation after refund arbitration before release";
 if(value==="RELEASED")return null;
 if(value==="HELD"||value==="ARBITRATION_RELEASE_APPROVED")return null;
 return"Partner earning custody state is not releaseable";
}

export async function markCustodyReleased(db:Db,input:{bookingId:string;pendingEarningId:string;now?:number}){
 await ensureFinancialCustodyTables(db);const now=input.now??Date.now();
 const result=await db.prepare("UPDATE partner_fund_custody SET state='RELEASED',released_at=?,updated_at=? WHERE booking_id=? AND pending_earning_id=? AND state IN ('HELD','ARBITRATION_RELEASE_APPROVED')")
  .bind(now,now,input.bookingId,input.pendingEarningId).run();
 if(Number(result.meta?.changes||0)!==1){
  const current=await db.prepare("SELECT state FROM partner_fund_custody WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if(String(current?.state)!=="RELEASED")throw new Error("Partner earning custody release was not authorised atomically");
 }
}
