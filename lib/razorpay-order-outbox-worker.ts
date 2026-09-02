import{executeRazorpayOrderOutbox}from"./financial-lifecycle";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

export async function runRazorpayOrderOutboxSweep(db:Db,env:Record<string,unknown>,input:{asOf?:number;limit?:number}={}){
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(100,Math.floor(input.limit??50)));
 if(!(await tableExists(db,"financial_outbox")))return{processed:0,succeeded:0,retried:0,reconciliationRequired:0,claimLost:0,errors:[] as string[],skipped:true};
 const rows=await db.prepare(`SELECT id FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER' AND ((status IN ('PENDING','RETRY') AND next_attempt_at<=?) OR (status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)) ORDER BY CASE WHEN status='PROCESSING' THEN 0 ELSE 1 END,next_attempt_at ASC,created_at ASC LIMIT ?`).bind(asOf,asOf,limit).all<Row>();
 const report={processed:0,succeeded:0,retried:0,reconciliationRequired:0,claimLost:0,errors:[] as string[],skipped:false};
 for(const row of rows.results){const outboxId=text(row.id);if(!outboxId)continue;try{const result=await executeRazorpayOrderOutbox(db,env,{outboxId,workerId:`scheduled:razorpay-order:${crypto.randomUUID()}`});if(!result.claimed){report.claimLost++;continue;}report.processed++;if(result.connected)report.succeeded++;else if(result.reconciliationRequired)report.reconciliationRequired++;else report.retried++;}catch(error){report.errors.push(`${outboxId}:${error instanceof Error?error.message:String(error)}`);}}
 return report;
}
