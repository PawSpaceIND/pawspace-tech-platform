import{executeRazorpayOrderOutbox}from"./financial-lifecycle";
import{parsePaymentEnvironment}from"./payment-environment";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

/**
 * Drain due CREATE_RAZORPAY_ORDER entries from the durable financial outbox.
 *
 * Environment validation happens before a row is claimed, so a missing/invalid payment environment can
 * never strand work in PROCESSING or reach Razorpay. Each row is still claimed by the canonical
 * executeRazorpayOrderOutbox() lease/CAS path, preserving its concurrency and reconciliation controls.
 */
export async function runRazorpayOrderOutboxSweep(db:Db,env:Record<string,unknown>,input:{asOf?:number;limit?:number;workerId?:string}={}){
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(100,input.limit??25));
 try{parsePaymentEnvironment(env);}catch(error){return{processed:0,succeeded:0,failed:0,reconciliationRequired:0,blocked:true,reason:error instanceof Error?error.message:String(error),results:[] as Array<Record<string,unknown>>};}
 const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='financial_outbox'").first<Row>();
 if(!table)return{processed:0,succeeded:0,failed:0,reconciliationRequired:0,blocked:false,skipped:true,results:[] as Array<Record<string,unknown>>};
 const rows=await db.prepare("SELECT id FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER' AND status IN ('PENDING','RETRY') AND next_attempt_at<=? ORDER BY next_attempt_at ASC,created_at ASC LIMIT ?").bind(asOf,limit).all<Row>();
 const prefix=text(input.workerId)||`scheduled-financial-outbox:${asOf}:${crypto.randomUUID()}`;
 let succeeded=0,failed=0,reconciliationRequired=0;const results:Array<Record<string,unknown>>=[];
 for(const row of rows.results){const outboxId=text(row.id);if(!outboxId)continue;try{const result=await executeRazorpayOrderOutbox(db,env,{outboxId,workerId:`${prefix}:${outboxId}`});results.push({outboxId,...result});if(result.claimed&&"connected"in result&&result.connected)succeeded++;else if(result.claimed&&"reconciliationRequired"in result&&result.reconciliationRequired)reconciliationRequired++;else if(result.claimed)failed++;}catch(error){failed++;results.push({outboxId,claimed:false,error:error instanceof Error?error.message:String(error)});}}
 return{processed:rows.results.length,succeeded,failed,reconciliationRequired,blocked:false,results};
}
